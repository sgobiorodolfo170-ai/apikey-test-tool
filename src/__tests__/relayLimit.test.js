import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

// 慢上游：延迟 delayMs 后返回 200
function startUpstream(delayMs = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
        }, delayMs)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe('限流与并发控制', () => {
  let slowServer
  let fastServer
  let slowPort
  let fastPort
  let relayPort

  beforeAll(async () => {
    slowServer = await startUpstream(200)
    fastServer = await startUpstream(0)
    slowPort = slowServer.address().port
    fastPort = fastServer.address().port
  })

  afterAll(() => {
    relay.stop()
    slowServer.close()
    fastServer.close()
  })

  beforeEach(() => {
    relay.clearRuntime()
  })

  function provider(id, name, port, extra = {}) {
    return {
      id,
      name,
      baseUrl: `http://127.0.0.1:${port}`,
      models: ['m'],
      enabled: true,
      ...extra,
    }
  }

  async function startWith(providers) {
    const info = await relay.start({ port: 0, providers })
    relayPort = info.port
    return info
  }

  function call() {
    return fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    })
  }

  it('returns 429 once the per-minute quota is used up', async () => {
    await startWith([provider('rpm', '限速上游', fastPort, { rpmLimit: 1 })])

    const first = await call()
    const second = await call()
    const payload = await second.json()

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(payload.error.type).toBe('rate_limit_exceeded')
    expect(second.headers.get('retry-after')).toBeTruthy()
  })

  it('queues requests above the concurrency limit instead of failing', async () => {
    await startWith([provider('conc', '慢上游', slowPort, { maxConcurrency: 1 })])

    const started = Date.now()
    const [a, b] = await Promise.all([call(), call()])
    const elapsed = Date.now() - started

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // 串行执行：两个 200ms 的请求至少 380ms
    expect(elapsed).toBeGreaterThanOrEqual(380)
  })

  it('fails the queued request when the queue times out', async () => {
    await startWith([
      provider('qto', '慢上游', slowPort, { maxConcurrency: 1, queueTimeoutMs: 50 }),
    ])

    const first = call()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await call()

    expect(second.status).toBe(429)
    expect((await first).status).toBe(200)
  })

  it('fails over to another provider when the first is rate limited', async () => {
    await startWith([
      provider('r1', '限速上游', fastPort, { rpmLimit: 1 }),
      provider('r2', '备用上游', fastPort),
    ])

    const first = await call()
    const second = await call()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(decodeURIComponent(second.headers.get('x-relay-provider') || '')).toBe('备用上游')
  })

  it('exposes inflight and limits in the status snapshot', async () => {
    await startWith([provider('load', '慢上游', slowPort, { maxConcurrency: 2, rpmLimit: 60 })])

    const pending = call()
    await new Promise((resolve) => setTimeout(resolve, 40))

    const load = relay.getStatus().load.load
    expect(load.maxConcurrency).toBe(2)
    expect(load.rpmLimit).toBe(60)
    expect(load.inflight).toBe(1)

    await pending
    // 请求结束后归还槽位
    expect(relay.getStatus().load.load.inflight).toBe(0)
  })

  it('falls back to defaults for invalid limits', () => {
    expect(relay.limitsOf({}).maxConcurrency).toBe(4)
    expect(relay.limitsOf({}).rpmLimit).toBe(0)
    expect(relay.limitsOf({ maxConcurrency: 0, rpmLimit: -3 }).maxConcurrency).toBe(4)
  })
})
