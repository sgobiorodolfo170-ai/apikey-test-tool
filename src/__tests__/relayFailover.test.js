import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

function startUpstream(status, payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe('resolveProvidersFrom', () => {
  const providers = [
    { id: 'a', name: 'A', baseUrl: 'https://a', models: ['m', 'x'], enabled: true },
    { id: 'b', name: 'B', baseUrl: 'https://b', models: ['m'], enabled: true },
    { id: 'c', name: 'C', baseUrl: 'https://c', models: ['m'], enabled: false },
  ]

  it('returns every provider that can serve the model, in config order', () => {
    expect(relay.resolveProvidersFrom(providers, 'm').map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('skips disabled providers', () => {
    expect(relay.resolveProvidersFrom(providers, 'm').some((p) => p.id === 'c')).toBe(false)
  })

  it('falls back to the only enabled provider', () => {
    expect(relay.resolveProvidersFrom([providers[0], providers[2]], 'zzz')).toHaveLength(1)
  })

  it('returns an empty list when nothing matches', () => {
    expect(relay.resolveProvidersFrom(providers, 'zzz')).toEqual([])
  })
})

describe('故障转移与请求日志', () => {
  let okServer
  let failServer
  let clientErrorServer
  let okPort
  let failPort
  let clientErrorPort
  let relayPort

  beforeAll(async () => {
    okServer = await startUpstream(200, {
      id: 'ok',
      choices: [{ message: { role: 'assistant', content: '备用上游回答' } }],
    })
    failServer = await startUpstream(500, { error: { message: 'boom' } })
    clientErrorServer = await startUpstream(400, { error: { message: 'bad request' } })

    okPort = okServer.address().port
    failPort = failServer.address().port
    clientErrorPort = clientErrorServer.address().port
  })

  afterAll(() => {
    relay.stop()
    okServer.close()
    failServer.close()
    clientErrorServer.close()
  })

  async function startWith(providers) {
    relay.clearLogs()
    const info = await relay.start({ port: 0, providers })
    relayPort = info.port
    return info
  }

  function provider(id, name, port, models = ['m']) {
    return { id, name, baseUrl: `http://127.0.0.1:${port}`, models, enabled: true }
  }

  function call(model = 'm') {
    return fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })
  }

  it('falls back to the next provider when the first returns 5xx', async () => {
    await startWith([provider('bad', '坏上游', failPort), provider('good', '好上游', okPort)])

    const response = await call()
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.choices[0].message.content).toBe('备用上游回答')
    expect(response.headers.get('x-relay-provider')).toBe(encodeURIComponent('好上游'))

    const logs = relay.getLogs()
    expect(logs.some((log) => log.provider === '坏上游' && log.status === 500)).toBe(true)
    expect(logs[0].provider).toBe('好上游')
    expect(logs[0].status).toBe(200)
  })

  it('does not retry on client errors such as 400', async () => {
    await startWith([
      provider('c400', '报错上游', clientErrorPort),
      provider('good', '好上游', okPort),
    ])

    const response = await call()

    expect(response.status).toBe(400)
    expect(relay.getLogs()[0].status).toBe(400)
  })

  it('passes through the last upstream status when every upstream returns an error', async () => {
    await startWith([provider('b1', '坏1', failPort), provider('b2', '坏2', failPort)])

    const response = await call()

    // 最后一个上游的响应原样透传，比统一包成 502 更有信息量
    expect(response.status).toBe(500)
    expect(relay.getLogs().filter((log) => log.error).length).toBeGreaterThanOrEqual(1)
  })

  it('returns 502 when every upstream is unreachable', async () => {
    // 端口 1 上没有服务，连接会被拒绝
    await startWith([provider('d1', '断1', 1), provider('d2', '断2', 1)])

    const response = await call()
    const payload = await response.json()

    expect(response.status).toBe(502)
    expect(payload.error.type).toBe('upstream_error')
    expect(payload.error.message).toContain('所有上游均失败')
  })

  it('records the model, provider, status and duration in the log', async () => {
    await startWith([provider('good', '好上游', okPort)])
    await call('m')

    const [log] = relay.getLogs()
    expect(log.model).toBe('m')
    expect(log.provider).toBe('好上游')
    expect(log.status).toBe(200)
    expect(typeof log.ms).toBe('number')
    expect(log.at).toBeTruthy()
  })

  it('clears the log buffer', async () => {
    await startWith([provider('good', '好上游', okPort)])
    await call()

    expect(relay.getLogs().length).toBeGreaterThan(0)
    relay.clearLogs()
    expect(relay.getLogs()).toEqual([])
  })
})
