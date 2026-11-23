import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

// 默认路由是「常规模型解析（精确匹配 → 通配 → 单上游）返回空」之后的兜底，
// 因此 503 守卫用多上游夹具触发：两个启用上游各有模型列表，未命中才会落到默认路由。
const providerA = {
  id: 'a',
  name: '上游A',
  baseUrl: '',
  apiKey: 'sk-a',
  models: ['m-a'],
  enabled: true,
}
const providerB = {
  id: 'b',
  name: '上游B',
  baseUrl: '',
  apiKey: 'sk-b',
  models: ['m-b'],
  enabled: true,
}
const providerC = {
  id: 'c',
  name: '已停用C',
  baseUrl: '',
  apiKey: 'sk-c',
  models: ['m-c'],
  enabled: false,
}

describe('默认路由 defaultProviderId（端到端）', () => {
  let upstream
  let relayInfo
  const received = []

  const post = (model) =>
    fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-default',
            choices: [{ message: { role: 'assistant', content: req.headers.authorization } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${upstream.address().port}/v1`
    providerA.baseUrl = base
    providerB.baseUrl = base
    providerC.baseUrl = base

    relayInfo = await relay.start({
      port: 0,
      providers: [providerA, providerB, providerC],
      defaultProviderId: '',
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  beforeEach(() => {
    received.length = 0
    relay.clearLogs()
  })

  it('未设默认且模型未命中 → 404 model_not_found（行为不变）', async () => {
    relay.update({ providers: [providerA, providerB, providerC], defaultProviderId: '' })
    const response = await post('m-unknown')
    const payload = await response.json()
    expect(response.status).toBe(404)
    expect(payload.error.type).toBe('model_not_found')
    expect(received).toHaveLength(0)
  })

  it('设默认后模型未命中 → 走默认，带 x-relay-provider 与 routedBy:default', async () => {
    relay.update({ providers: [providerA, providerB, providerC], defaultProviderId: 'a' })
    const response = await post('m-unknown')
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.choices[0].message.content).toBe('Bearer sk-a')
    expect(response.headers.get('x-relay-provider')).toBe(encodeURIComponent('上游A'))
    const logs = relay.getLogs()
    expect(logs[0].routedBy).toBe('default')
  })

  it('命中模型仍路由到匹配上游，不算默认路由', async () => {
    relay.update({ providers: [providerA, providerB, providerC], defaultProviderId: 'a' })
    const response = await post('m-b')
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.choices[0].message.content).toBe('Bearer sk-b')
    expect(relay.getLogs()[0].routedBy).toBe('')
  })

  it('默认上游被禁用 → 明确 503，不静默切到其它上游', async () => {
    relay.update({ providers: [providerA, providerB, providerC], defaultProviderId: 'c' })
    const response = await post('m-unknown')
    const payload = await response.json()
    expect(response.status).toBe(503)
    expect(payload.error.type).toBe('default_provider_unavailable')
    expect(received).toHaveLength(0)
  })

  it('默认上游无可用 Key → 明确 503', async () => {
    const keyless = { ...providerA, apiKey: '', apiKeys: [] }
    relay.update({ providers: [keyless, providerB, providerC], defaultProviderId: 'a' })
    const response = await post('m-unknown')
    const payload = await response.json()
    expect(response.status).toBe(503)
    expect(payload.error.type).toBe('default_provider_unavailable')
    expect(received).toHaveLength(0)
  })

  it('免 Key 的公钥上游可以设为默认（不报缺 Key）', async () => {
    const keyless = { ...providerA, apiKey: '', apiKeys: [], presetId: 'kilo-free' }
    relay.update({ providers: [keyless, providerB, providerC], defaultProviderId: 'a' })
    const response = await post('m-unknown')
    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].auth).toBeUndefined()
  })

  it('/v1/models 仍广播所有启用上游，不只默认', async () => {
    relay.update({ providers: [providerA, providerB, providerC], defaultProviderId: 'a' })
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/models`)
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.data.map((m) => m.id)).toEqual(['m-a', 'm-b'])
  })

  it('getStatus 与 update 携带 defaultProviderId', () => {
    relay.update({ defaultProviderId: 'b' })
    expect(relay.getStatus().defaultProviderId).toBe('b')
    relay.update({ defaultProviderId: '  ' })
    expect(relay.getStatus().defaultProviderId).toBe('')
  })
})
