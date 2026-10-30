import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

const providers = [
  {
    id: 'a',
    name: '上游A',
    baseUrl: 'https://a.example.com/v1',
    models: ['m-a', 'shared'],
    enabled: true,
  },
  {
    id: 'b',
    name: '上游B',
    baseUrl: 'https://b.example.com/v1',
    models: ['m-b', 'shared'],
    enabled: true,
  },
  { id: 'c', name: '已停用', baseUrl: 'https://c.example.com/v1', models: ['m-c'], enabled: false },
]

describe('listModelsFrom', () => {
  it('aggregates enabled providers and de-duplicates models', () => {
    const models = relay.listModelsFrom(providers)
    expect(models.map((m) => m.id)).toEqual(['m-a', 'shared', 'm-b'])
    expect(models[0].owned_by).toBe('上游A')
  })

  it('skips disabled providers and empty base urls', () => {
    const models = relay.listModelsFrom([
      ...providers,
      { id: 'd', name: '没地址', baseUrl: '', models: ['x'], enabled: true },
    ])
    expect(models.some((m) => m.id === 'm-c')).toBe(false)
    expect(models.some((m) => m.id === 'x')).toBe(false)
  })
})

describe('resolveProviderFrom', () => {
  it('routes by exact model match', () => {
    expect(relay.resolveProviderFrom(providers, 'm-b').id).toBe('b')
    // 同名模型归属第一个匹配的提供商
    expect(relay.resolveProviderFrom(providers, 'shared').id).toBe('a')
  })

  it('falls back to the only enabled provider', () => {
    const single = [providers[0], providers[2]]
    expect(relay.resolveProviderFrom(single, 'unknown-model').id).toBe('a')
  })

  it('refuses to guess when several providers are enabled', () => {
    expect(relay.resolveProviderFrom(providers, 'unknown-model')).toBeNull()
  })

  it('never routes to a disabled provider', () => {
    expect(relay.resolveProviderFrom(providers, 'm-c')).toBeNull()
  })
})

describe('中转服务（端到端）', () => {
  let upstream
  let upstreamPort
  let relayInfo
  let received = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received.push({ url: req.url, auth: req.headers.authorization, body })

        if (req.url.endsWith('/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'm-a' }, { id: 'shared' }] }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            choices: [{ message: { role: 'assistant', content: '来自上游' } }],
          }),
        )
      })
    })

    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port

    relayInfo = await relay.start({
      port: 0,
      providers: [
        {
          id: 'up',
          name: '上游',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: 'sk-upstream',
          models: ['m-a', 'shared'],
          enabled: true,
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  it('starts on a real port and reports status', () => {
    expect(relayInfo.port).toBeGreaterThan(0)
    expect(relay.getStatus().running).toBe(true)
  })

  it('serves an aggregated /v1/models', async () => {
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/models`)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.data.map((m) => m.id)).toEqual(['m-a', 'shared'])
  })

  it('forwards chat completions and passes the upstream key', async () => {
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm-a', messages: [{ role: 'user', content: '你好' }] }),
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.choices[0].message.content).toBe('来自上游')

    const last = received.at(-1)
    expect(last.url).toBe('/v1/chat/completions')
    expect(last.auth).toBe('Bearer sk-upstream')
    expect(JSON.parse(last.body).model).toBe('m-a')
  })

  it('falls back to the only provider for unknown model names', async () => {
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'any-name', messages: [] }),
    })

    expect(response.status).toBe(200)
  })

  it('rejects a request without model', async () => {
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(response.status).toBe(400)
  })

  it('exposes a health endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/health`)
    const payload = await response.json()

    expect(payload.status).toBe('ok')
    expect(payload.providers).toBe(1)
    expect(payload.models).toBe(2)
  })

  it('returns an OpenAI-style 404 when several providers are enabled but none matches', async () => {
    relay.stop()
    const info = await relay.start({
      port: 0,
      providers: [
        {
          id: 'up',
          name: '上游',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: 'sk-upstream',
          models: ['m-a'],
          enabled: true,
        },
        {
          id: 'up2',
          name: '上游2',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: 'sk-2',
          models: ['m-b'],
          enabled: true,
        },
      ],
    })

    const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    })
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(payload.error.type).toBe('model_not_found')
  })

  it('stops the server', () => {
    relay.stop()
    expect(relay.getStatus().running).toBe(false)
  })
})
