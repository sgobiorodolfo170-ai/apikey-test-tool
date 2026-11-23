import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

  it('routes to providers that have no model list yet', () => {
    const wildcard = [
      { id: 'w', name: 'W', baseUrl: 'https://w.example.com/v1', models: [], enabled: true },
      providers[1],
    ]
    expect(relay.resolveProviderFrom(wildcard, 'anything').id).toBe('w')
  })

  it('never routes to a disabled provider', () => {
    expect(relay.resolveProviderFrom(providers, 'm-c')).toBeNull()
  })
})

describe('多 Key 归一化与展开', () => {
  it('trims and de-duplicates keys (apiKeys 为主，apiKey 兼容)', () => {
    expect(relay.apiKeysOf({ apiKey: ' a ', apiKeys: ['a', 'b', ''] })).toEqual(['a', 'b'])
    expect(relay.apiKeysOf({ apiKey: 'only' })).toEqual(['only'])
    expect(relay.apiKeysOf({})).toEqual([])
  })

  it('expands each provider into one candidate per key', () => {
    const list = relay.expandKeyCandidates([
      { id: 'p', baseUrl: 'https://p.example', apiKeys: ['k1', 'k2'] },
      { id: 'q', baseUrl: 'https://q.example' },
    ])

    expect(list.map((item) => [item.id, item.apiKey])).toEqual([
      ['p', 'k1'],
      ['p', 'k2'],
      ['q', ''],
    ])
  })
})

describe('中转服务 多 Key（端到端）', () => {
  let upstream
  let upstreamPort
  let relayInfo
  const seen = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        seen.push(req.headers.authorization)
        if (req.headers.authorization === 'Bearer sk-bad') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-multi',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
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
          id: 'multi',
          name: '多Key上游',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: 'sk-bad',
          apiKeys: ['sk-bad', 'sk-good'],
          models: ['m-multi'],
          enabled: true,
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  it('falls back to another key of the same provider when one is rejected', async () => {
    seen.length = 0
    relay.clearLogs()
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm-multi', messages: [] }),
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual(['Bearer sk-bad', 'Bearer sk-good'])

    const logs = relay.getLogs()
    expect(logs.length).toBeGreaterThanOrEqual(2)
    const requestId = logs[0].requestId
    expect(requestId).toMatch(/^req_/)
    const attempts = logs.filter((item) => item.requestId === requestId)
    expect(attempts.length).toBe(2)
    expect(attempts.some((item) => item.failover)).toBe(true)
    expect(new Set(attempts.map((item) => item.keyTail)).size).toBe(2)
  })

  it('rotates the starting key between requests', async () => {
    seen.length = 0
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm-multi', messages: [] }),
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual(['Bearer sk-good'])
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
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
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

  it('records call stats with usage', async () => {
    relay.clearStats()
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm-a', messages: [] }),
    })
    expect(response.status).toBe(200)
    await response.json()

    const stats = relay.getStats()
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({
      provider: '上游',
      model: 'm-a',
      total: 1,
      success: 1,
      lastStatus: 'success',
      lastHttpStatus: 200,
      usage: { prompt: 7, completion: 5, total: 12 },
    })
  })

  it('aggregates daily token usage for charts', async () => {
    relay.clearStats()
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm-daily', messages: [] }),
    })
    expect(response.status).toBe(200)
    await response.json()

    const history = relay.getTokenHistory()
    expect(history).toHaveLength(1)
    expect(history[0].total).toBe(12)
    expect(history[0].prompt).toBe(7)
    expect(history[0].completion).toBe(5)
    expect(history[0].calls).toBe(1)
    expect(history[0].models[0]).toMatchObject({ model: 'm-daily', total: 12 })
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

describe('本地访问 Key（端到端）', () => {
  let info

  beforeAll(async () => {
    info = await relay.start({
      port: 0,
      apiKey: 'sk-relay-test',
      providers: [
        {
          id: 'keyed',
          name: '带 Key 的上游',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: ['m-keyed'],
          enabled: true,
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
  })

  it('rejects requests without the key', async () => {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/models`)
    expect(response.status).toBe(401)
    const payload = await response.json()
    expect(payload.error.type).toBe('invalid_api_key')
  })

  it('accepts requests with the key', async () => {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/models`, {
      headers: { Authorization: 'Bearer sk-relay-test' },
    })
    expect(response.status).toBe(200)
  })

  it('keeps /health open without a key', async () => {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`)
    expect(response.status).toBe(200)
  })
})

describe('中转增强：别名 / embeddings / 缓存', () => {
  let upstream
  let info
  const calls = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        calls.push({ url: req.url, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (req.url.endsWith('/embeddings')) {
          res.end(
            JSON.stringify({
              object: 'list',
              data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
              usage: { prompt_tokens: 5, total_tokens: 5 },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            id: 'chatcmpl-alias',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        )
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    info = await relay.start({
      port: 0,
      cache: { enabled: true, ttlMs: 60000 },
      providers: [
        {
          id: 'alias',
          name: '别名上游',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          models: ['real-model'],
          modelAliases: { 'my-model': 'real-model' },
          enabled: true,
        },
      ],
    })
    relay.clearCache()
    relay.clearStats()
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  it('maps an alias to the real model and lists it', async () => {
    calls.length = 0
    const base = `http://127.0.0.1:${info.port}/v1`
    const models = await (await fetch(`${base}/models`)).json()
    expect(models.data.map((item) => item.id)).toEqual(['real-model', 'my-model'])

    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'my-model', messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(calls[0].body).model).toBe('real-model')
  })

  it('forwards embeddings to /embeddings', async () => {
    calls.length = 0
    const base = `http://127.0.0.1:${info.port}/v1`
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'real-model', input: 'hello' }),
    })
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe('/v1/embeddings')
  })

  it('serves identical non-stream requests from cache', async () => {
    relay.clearCache()
    relay.clearStats()
    relay.clearLogs()
    calls.length = 0
    const base = `http://127.0.0.1:${info.port}/v1`
    const body = JSON.stringify({
      model: 'real-model',
      messages: [{ role: 'user', content: 'cache me' }],
    })
    const request = () =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

    const first = await request()
    const second = await request()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(second.headers.get('x-relay-cache')).toBe('hit')
    expect(relay.getStats().some((item) => item.provider === '缓存')).toBe(true)
    // 日志记录请求路径，供统计页区分 chat / embeddings 的命中率
    const hitLog = relay.getLogs().find((item) => item.cached)
    expect(hitLog.path).toBe('/chat/completions')
  })

  it('serves identical embeddings requests from cache', async () => {
    relay.clearCache()
    relay.clearStats()
    relay.clearLogs()
    calls.length = 0
    const base = `http://127.0.0.1:${info.port}/v1`
    const body = JSON.stringify({ model: 'real-model', input: 'hello' })
    const request = () =>
      fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

    const first = await request()
    const second = await request()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(second.headers.get('x-relay-cache')).toBe('hit')
    expect(relay.getLogs().find((item) => item.cached)?.path).toBe('/embeddings')
  })

  it('keeps cached tokens out of real usage and reports savings separately', async () => {
    relay.clearCache()
    relay.clearStats()
    calls.length = 0
    const base = `http://127.0.0.1:${info.port}/v1`
    const body = JSON.stringify({
      model: 'real-model',
      messages: [{ role: 'user', content: 'count tokens' }],
    })
    const request = () =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

    await request()
    await request()

    const today = relay.getTokenHistory().at(-1)
    // 真实消耗只算第一次调用（上游 usage: 3 输入 + 2 输出）
    expect(today.total).toBe(5)
    expect(today.calls).toBe(1)
    // 第二次命中缓存，单独记为「缓存节省」
    expect(today.cached.calls).toBe(1)
    expect(today.cached.total).toBe(5)

    const cacheStat = relay.getStats().find((item) => item.provider === '缓存')
    expect(cacheStat.usage).toBeNull()
    expect(cacheStat.cachedUsage).toEqual({ prompt: 3, completion: 2, total: 5 })
  })
})

describe('冷却 / 熔断', () => {
  let upstream
  let info
  let calls = 0

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        calls += 1
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"boom"}}')
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    info = await relay.start({
      port: 0,
      providers: [
        {
          id: 'bad',
          name: '坏上游',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          models: ['m-bad'],
          enabled: true,
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  it('cools down a failing upstream and short-circuits further calls', async () => {
    calls = 0
    const base = `http://127.0.0.1:${info.port}/v1`
    const request = () =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm-bad', messages: [] }),
      })

    const first = await request()
    expect(first.status).toBe(500)
    expect(calls).toBe(1)

    const second = await request()
    expect(second.status).toBe(503)
    expect(calls).toBe(1)
  })
})

describe('日志与统计持久化', () => {
  let upstream
  let info
  let file

  beforeAll(async () => {
    file = path.join(os.tmpdir(), `relay-usage-${Date.now()}.json`)
    try {
      fs.rmSync(file)
    } catch {
      // 文件不存在
    }
    relay.attachStorage(file)
    relay.clearStats()
    relay.clearLogs()

    upstream = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        )
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    info = await relay.start({
      port: 0,
      providers: [
        {
          id: 'p',
          name: '持久化上游',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          models: ['m'],
          enabled: true,
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
    try {
      fs.rmSync(file)
    } catch {
      // 已删除
    }
  })

  it('writes logs / stats to disk and restores them', async () => {
    const base = `http://127.0.0.1:${info.port}/v1`
    await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    await relay.persistNow()

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.stats.length).toBeGreaterThan(0)
    expect(saved.logs.length).toBeGreaterThan(0)
    expect(saved.daily.length).toBeGreaterThan(0)

    relay.attachStorage(file)
    expect(relay.getStats().length).toBeGreaterThan(0)
    expect(relay.getLogs().length).toBeGreaterThan(0)
    const history = relay.getTokenHistory()
    expect(history.length).toBeGreaterThan(0)
    expect(history.at(-1).total).toBeGreaterThan(0)
  })

  it('persists cached savings separately and restores them', async () => {
    // 开启缓存后跑两次相同请求，第二次命中；真实用量只应记一次
    const cacheInfo = await relay.start({
      port: 0,
      cache: { enabled: true, ttlMs: 60000 },
      providers: [
        {
          id: 'p',
          name: '持久化上游',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          models: ['m'],
          enabled: true,
        },
      ],
    })
    relay.clearCache()
    relay.clearStats()
    const base = `http://127.0.0.1:${cacheInfo.port}/v1`
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'persist' }] })
    const request = () =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

    await request()
    const second = await request()
    expect(second.headers.get('x-relay-cache')).toBe('hit')

    await relay.persistNow()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const today = saved.daily.at(-1)[1]
    expect(today.total).toBe(3)
    expect(today.calls).toBe(1)
    expect(today.cached).toMatchObject({ total: 3, calls: 1 })

    relay.attachStorage(file)
    const history = relay.getTokenHistory()
    expect(history.at(-1).total).toBe(3)
    expect(history.at(-1).cached.total).toBe(3)
  })
})

describe('会话粘性 / 客户端归因 / 取消 / 缓存加固', () => {
  let upstream
  let upstreamPort
  let hits = []
  let delayMs = 0

  const makeProvider = (overrides = {}) => ({
    id: 'up',
    name: '上游',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    models: ['m'],
    enabled: true,
    maxConcurrency: 8,
    ...overrides,
  })

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        hits.push({ auth: req.headers.authorization, body })
        const send = () => {
          if (res.writableEnded || res.destroyed) return
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'chatcmpl-vendor',
              created: 1,
              choices: [{ message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          )
        }
        res.on('error', () => {})
        if (delayMs > 0) setTimeout(send, delayMs)
        else send()
      })
    })

    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  const post = (port, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  it('identifies clients by their own key and rejects unknown ones', async () => {
    relay.clearLogs()
    const info = await relay.start({
      port: 0,
      apiKey: 'sk-default',
      clientKeys: [
        { key: 'sk-tool-a', label: '工具A' },
        { key: 'sk-tool-b', label: '工具B' },
      ],
      providers: [makeProvider()],
    })

    const bad = await post(
      info.port,
      { model: 'm', messages: [] },
      { Authorization: 'Bearer sk-nope' },
    )
    expect(bad.status).toBe(401)

    const ok = await post(
      info.port,
      { model: 'm', messages: [] },
      { Authorization: 'Bearer sk-tool-a' },
    )
    expect(ok.status).toBe(200)
    await ok.json()

    const logs = relay.getLogs()
    expect(logs[0].client).toBe('工具A')
    expect(relay.getStatus().clientKeys).toBe(2)
  })

  it('keeps one session on the same key when sticky is on', async () => {
    hits = []
    const info = await relay.start({
      port: 0,
      sticky: true,
      providers: [makeProvider({ apiKeys: ['sk-k1', 'sk-k2'] })],
    })

    for (let index = 0; index < 3; index += 1) {
      const response = await post(info.port, {
        model: 'm',
        user: 'tool-a-session-1',
        messages: [{ role: 'user', content: `第 ${index} 轮` }],
      })
      expect(response.status).toBe(200)
      await response.json()
    }

    expect(new Set(hits.map((item) => item.auth)).size).toBe(1)
    expect(relay.getStatus().sticky).toBe(true)
  })

  it('rewrites the response id on a cache hit', async () => {
    const info = await relay.start({
      port: 0,
      cache: { enabled: true, ttlMs: 60000 },
      providers: [makeProvider()],
    })
    const body = { model: 'm', messages: [{ role: 'user', content: '缓存我' }] }

    const first = await post(info.port, body)
    const firstPayload = await first.json()
    const second = await post(info.port, body)
    const secondPayload = await second.json()

    expect(second.headers.get('x-relay-cache')).toBe('hit')
    expect(secondPayload.id).not.toBe(firstPayload.id)
    expect(secondPayload.id).toMatch(/^chatcmpl-/)
    expect(secondPayload.choices[0].message.content).toBe('ok')
  })

  it('marks a client abort with 499 without counting it as a failure stat', async () => {
    delayMs = 300
    relay.clearLogs()
    relay.clearStats()
    const info = await relay.start({ port: 0, providers: [makeProvider()] })

    await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: info.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        () => {},
      )
      req.on('error', () => resolve())
      req.end(JSON.stringify({ model: 'm', messages: [] }))
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 80)
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    delayMs = 0

    const logs = relay.getLogs()
    expect(logs.some((item) => item.status === 499 && item.aborted)).toBe(true)
    expect(relay.getStats()).toHaveLength(0)
  })

  it('reserves a normal slot when the streaming limit is reached', async () => {
    relay.clearRuntime()
    const provider = { id: 'lim', maxConcurrency: 2, queueTimeoutMs: 30 }
    const streaming = await relay.acquireSlot(provider, true)

    await expect(relay.acquireSlot(provider, true)).rejects.toMatchObject({
      code: 'rate_limited',
    })

    const normal = await relay.acquireSlot(provider, false)
    normal()
    streaming()
    relay.clearRuntime()
  })

  it('builds a stable sticky key from headers, user, or the message prefix', () => {
    expect(relay.stickyKeyOf({ headers: { 'x-session-id': 's-1' } }, { messages: [] })).toBe('s-1')
    expect(relay.stickyKeyOf({ headers: {} }, { user: 'u-1' })).toBe('u-1')
    expect(
      relay.stickyKeyOf(
        { headers: {} },
        {
          messages: [
            { role: 'system', content: '你是助手' },
            { role: 'user', content: '你好' },
          ],
        },
      ),
    ).toContain('system:你是助手')
  })

  it('normalizes client keys (trim / de-duplicate / default label)', () => {
    const list = relay.normalizeClientKeys([
      { key: ' a ', label: ' A ' },
      { key: 'a', label: 'dup' },
      { key: '' },
    ])
    expect(list).toEqual([{ key: 'a', label: 'A' }])
    expect(relay.normalizeClientKeys([{ key: 'b' }])[0].label).toBe('客户端1')
  })
})

describe('额度窗口（5 小时 / 7 天）', () => {
  it('normalizes quota config to real-response auto protection', () => {
    expect(
      relay.normalizeQuota({
        enabled: true,
        // 旧字段应被丢弃，不再参与额度判定
        metric: 'credit',
        limit5h: 10,
        limitWeek: 50,
        creditsPerMillionTokens: 4,
        perModel: true,
        modelRates: { m: 3 },
      }),
    ).toEqual({
      enabled: true,
      confirmStrikes: 0,
      confirmIntervalMinutes: 0,
      confirmSpanMinutes: 0,
      burstWindowMinutes: 0,
      burstStrikes: 0,
      warmupMinutes: 0,
      group: '',
      groups: [],
      keyGroups: {},
    })
    // 没有配置任何上限也可以开启：是否锁定只由真实 429 决定
    expect(relay.normalizeQuota({ enabled: true }).enabled).toBe(true)
    expect(relay.normalizeQuota({ enabled: false }).enabled).toBe(false)
  })

  it('requires spaced real 429s before locking a key', async () => {
    relay.clearRuntime()
    const provider = {
      id: 'q5',
      name: 'Q5',
      apiKey: 'sk-429',
      quota: {
        enabled: true,
        confirmStrikes: 3,
        confirmIntervalMinutes: 0.002,
      },
    }

    // 同一波 429（间隔不足）只算一次
    relay.noteQuotaHit(provider, 'm')
    relay.noteQuotaHit(provider, 'm')
    relay.noteQuotaHit(provider, 'm')
    expect(relay.quotaBlocked(provider, 'm')).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 150))
    relay.noteQuotaHit(provider, 'm')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const lock = relay.noteQuotaHit(provider, 'm')
    expect(lock.level).toBe('probe')

    const blocked = relay.quotaBlocked(provider, 'm')
    expect(blocked.locked).toBe(true)
    expect(blocked.window).toBe('probe')
    // 首次确认先探测 5 分钟，而不是直接锁 5 小时
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(300)
    relay.clearRuntime()
  })
})

describe('testKey 测通（/models 与指定模型）', () => {
  let upstream
  let port
  const requests = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body })
        if (req.url.endsWith('/chat/completions')) {
          if (req.headers.authorization === 'Bearer sk-good') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' } }] }))
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
          }
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }] }))
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    port = upstream.address().port
  })

  afterAll(() => {
    upstream.close()
  })

  it('未指定模型时保持 /models 连通测试', async () => {
    const result = await relay.testKey({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-good',
    })
    expect(result.ok).toBe(true)
    expect(result.models).toBe(2)
    expect(result.model).toBeUndefined()
    expect(requests.at(-1)).toMatchObject({ url: '/v1/models', method: 'GET' })
  })

  it('指定模型时发一次最小化 /chat/completions', async () => {
    const result = await relay.testKey({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-good',
      model: 'gpt-test',
    })
    expect(result.ok).toBe(true)
    expect(result.model).toBe('gpt-test')
    expect(typeof result.ms).toBe('number')

    const last = requests.at(-1)
    expect(last).toMatchObject({
      url: '/v1/chat/completions',
      method: 'POST',
      auth: 'Bearer sk-good',
    })
    const parsed = JSON.parse(last.body)
    expect(parsed.model).toBe('gpt-test')
    expect(parsed.max_tokens).toBe(1)
    expect(parsed.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('模型测通失败时透传上游错误', async () => {
    const result = await relay.testKey({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-bad',
      model: 'gpt-test',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
  })

  it('空白模型名视为未指定', async () => {
    const result = await relay.testKey({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-good',
      model: '   ',
    })
    expect(result.ok).toBe(true)
    expect(result.models).toBe(2)
    expect(result.model).toBeUndefined()
  })
})
