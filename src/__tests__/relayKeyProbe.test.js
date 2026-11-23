import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

describe('normalizeAutoProbe', () => {
  it('defaults to disabled / 30 minutes / empty model', () => {
    expect(relay.normalizeAutoProbe()).toEqual({ enabled: false, intervalMinutes: 30, model: '' })
  })

  it('clamps the interval into 1..720 and trims the model', () => {
    expect(
      relay.normalizeAutoProbe({ enabled: true, intervalMinutes: 5000, model: ' m ' }),
    ).toEqual({ enabled: true, intervalMinutes: 720, model: 'm' })
    expect(relay.normalizeAutoProbe({ enabled: true, intervalMinutes: 0 }).intervalMinutes).toBe(30)
  })
})

describe('Key 额度自动探测（端到端）', () => {
  let upstream
  let upstreamPort
  // 'ok' | 'unauthorized' | 'busy'(中性 429，不带 quota/rate 关键字) | 'broken'(5xx)
  let mode = 'ok'
  const seenAuths = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        seenAuths.push(req.headers.authorization)
        if (mode === 'unauthorized') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
          return
        }
        if (mode === 'busy') {
          // 中性文案：parse429Signal 返回 ''，429 走连续确认 / 突发判定，不触发跳级
          res.writeHead(429, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'upstream busy' } }))
          return
        }
        if (mode === 'broken') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'boom' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'pong' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
      })
    })

    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port

    await relay.start({
      port: 0,
      providers: [
        {
          id: 'probe-a',
          name: '探测上游',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKeys: ['sk-probe-1', 'sk-probe-2'],
          models: ['probe-model'],
          enabled: true,
          autoProbe: { enabled: true, intervalMinutes: 30, model: 'probe-model' },
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  it('手动探测一轮得到 ok，快照含排程且日志带 probe 标记', async () => {
    mode = 'ok'
    seenAuths.length = 0
    const result = await relay.probeAllKeys('probe-a')

    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ ok: true, keys: 2, model: 'probe-model' })
    const entry = result.snapshot.find((item) => item.providerId === 'probe-a')
    expect(entry.probeEnabled).toBe(true)
    expect(entry.keys).toHaveLength(2)
    for (const row of entry.keys) {
      expect(row.result).toBe('ok')
      expect(row.lastProbeAt).toBeTruthy()
      expect(row.latencyMs).toBeGreaterThanOrEqual(0)
      expect(row.locked).toBe(false)
    }
    // 每把 Key 都用各自的 Bearer 鉴权打了上游
    expect(seenAuths).toEqual(['Bearer sk-probe-1', 'Bearer sk-probe-2'])
    // 启动后自动探测已排程：nextProbeAt 在未来；快照可从 getStatus 读到
    const status = relay.getStatus()
    const scheduled = status.keyProbe.find((item) => item.providerId === 'probe-a')
    expect(scheduled.nextProbeAt).toBeGreaterThan(Date.now())
    // 探测也是真实调用：进调用日志并带 probe 标记与「额度探测」归因
    expect(relay.getLogs().some((item) => item.probe === true && item.client === '额度探测')).toBe(
      true,
    )
  })

  it('401 标记 Key 无效并记录首次失效时间', async () => {
    mode = 'unauthorized'
    const result = await relay.probeAllKeys('probe-a')
    const entry = result.snapshot.find((item) => item.providerId === 'probe-a')
    for (const row of entry.keys) {
      expect(row.result).toBe('invalid')
      expect(row.status).toBe(401)
      expect(row.invalidSince).toBeTruthy()
    }
  })

  it('5xx 记为探测失败且不保留无效标记', async () => {
    mode = 'broken'
    const result = await relay.probeAllKeys('probe-a')
    const row = result.snapshot.find((item) => item.providerId === 'probe-a').keys[0]
    expect(row.result).toBe('error')
    expect(row.invalidSince).toBe('')
  })

  it('连续探测 429（突发确认）锁定 Key，探测成功立即恢复', async () => {
    mode = 'busy'
    relay.update({
      providers: [
        {
          id: 'probe-a',
          name: '探测上游',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKeys: ['sk-probe-lock'],
          models: ['probe-model'],
          enabled: true,
          autoProbe: { enabled: true, intervalMinutes: 30, model: 'probe-model' },
          quota: {
            enabled: true,
            confirmStrikes: 3,
            confirmIntervalMinutes: 1,
            confirmSpanMinutes: 9,
            burstWindowMinutes: 10,
            burstStrikes: 3,
            warmupMinutes: 5,
          },
        },
      ],
    })

    for (let round = 0; round < 3; round += 1) {
      await relay.probeAllKeys('probe-a')
    }

    let status = relay.getStatus()
    expect(status.quota.find((item) => item.providerId === 'probe-a')?.locked).toBe(true)
    let entry = status.keyProbe.find((item) => item.providerId === 'probe-a')
    expect(entry.keys[0].result).toBe('rate_limited')
    expect(entry.keys[0].locked).toBe(true)
    expect(entry.keys[0].lockWindow).toBeTruthy()

    // 滚动窗口提前恢复：探测成功立即解锁
    mode = 'ok'
    await relay.probeAllKeys('probe-a')
    status = relay.getStatus()
    entry = status.keyProbe.find((item) => item.providerId === 'probe-a')
    expect(entry.keys[0].locked).toBe(false)
    expect(entry.keys[0].result).toBe('ok')
    expect(status.quota.find((item) => item.providerId === 'probe-a')?.locked).toBe(false)
  })

  it('没有探测模型时不打上游；停机后自动排程清空', async () => {
    mode = 'ok'
    relay.update({
      providers: [
        {
          id: 'probe-empty',
          name: '无模型上游',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKeys: ['sk-probe-3'],
          models: [],
          enabled: true,
          autoProbe: { enabled: true, intervalMinutes: 30, model: '' },
        },
      ],
    })
    const before = seenAuths.length
    const result = await relay.probeAllKeys('probe-empty')

    expect(result.results[0].ok).toBe(false)
    expect(result.results[0].reason).toBe('no_model')
    expect(seenAuths.length).toBe(before)

    relay.stop()
    const status = relay.getStatus()
    const entry = status.keyProbe.find((item) => item.providerId === 'probe-empty')
    expect(entry?.nextProbeAt ?? 0).toBe(0)
  })
})

describe('测通请求的断流兜底', () => {
  it('上游响应中途断开时返回失败，而不是一直悬挂', async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' })
      res.write('{"choices":[')
      req.socket.destroy()
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const port = upstream.address().port
    try {
      const startedAt = Date.now()
      const result = await relay.testKey(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'm' },
        3000,
      )
      expect(result.ok).toBe(false)
      expect(Date.now() - startedAt).toBeLessThan(5000)
    } finally {
      await new Promise((resolve) => upstream.close(resolve))
    }
  })
})
