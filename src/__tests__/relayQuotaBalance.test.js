import http from 'node:http'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

function makeProvider(overrides = {}) {
  return {
    id: 'q',
    name: '商汤',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKey: 'sk-a',
    models: ['m'],
    enabled: true,
    quota: {
      enabled: true,
      confirmStrikes: 1,
      confirmIntervalMinutes: 0,
      confirmSpanMinutes: 9,
      burstWindowMinutes: 10,
      burstStrikes: 0,
      warmupMinutes: 5,
    },
    ...overrides,
  }
}

describe('真实 429 分级锁定', () => {
  beforeEach(() => {
    relay.clearRuntime()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次确认只锁 5 分钟探测，不直接锁 5 小时', () => {
    const provider = makeProvider()
    const lock = relay.noteQuotaHit(provider, 'm')

    expect(lock.level).toBe('probe')
    expect(relay.quotaBlocked(provider, 'm')).toMatchObject({
      window: 'probe',
      locked: true,
    })
    // 5 分钟探测锁，不是 5 小时
    expect(relay.quotaBlocked(provider, 'm').retryAfter).toBeLessThanOrEqual(5 * 60)
    expect(relay.quotaBlocked(provider, 'm').retryAfter).toBeGreaterThan(4 * 60)
  })

  it('探测仍失败升级 5 小时，5 小时后仍失败升级 7 天', () => {
    const provider = makeProvider()
    relay.noteQuotaHit(provider, 'm')

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    // 探测锁到期：进入半开探测，下一次真实 429 会升级
    expect(relay.quotaLocked(provider, 'm')).toBeNull()
    const fiveHour = relay.noteQuotaHit(provider, 'm')
    expect(fiveHour.level).toBe('5h')

    vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1000)
    expect(relay.quotaLocked(provider, 'm')).toBeNull()
    const week = relay.noteQuotaHit(provider, 'm')
    expect(week.level).toBe('week')
  })

  it('等级记忆随时间衰减：长期无流量的 Key 重新从 5 分钟探测开始', () => {
    const provider = makeProvider()
    relay.noteQuotaHit(provider, 'm')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    const fiveHour = relay.noteQuotaHit(provider, 'm')
    expect(fiveHour.level).toBe('5h')

    // 超过 5 小时窗口的 2 倍无任何真实成功/429 → 陈旧记忆衰减
    vi.advanceTimersByTime(10 * 60 * 60 * 1000 + 1000)
    const fresh = relay.noteQuotaHit(provider, 'm')
    expect(fresh.level).toBe('probe')
  })

  it('真实成功立即清除锁定与升级等级', () => {
    const provider = makeProvider()
    relay.noteQuotaHit(provider, 'm')
    expect(relay.quotaBlocked(provider, 'm')).not.toBeNull()

    relay.markSuccess(provider, 'm')

    expect(relay.quotaBlocked(provider, 'm')).toBeNull()
    expect(relay.quotaLocked(provider, 'm')).toBeNull()
  })

  it('同一 Key 的不同模型各自锁定，不互相影响', () => {
    const provider = makeProvider()
    relay.noteQuotaHit(provider, 'm1')

    expect(relay.quotaBlocked(provider, 'm1')).not.toBeNull()
    expect(relay.quotaBlocked(provider, 'm2')).toBeNull()
  })

  it('共享账号组内的 Key 共享真实 429 锁定', () => {
    const first = makeProvider({
      apiKey: 'sk-1',
      quota: { ...makeProvider().quota, group: 'acct' },
    })
    const second = makeProvider({
      apiKey: 'sk-2',
      quota: { ...makeProvider().quota, group: 'acct' },
    })

    relay.noteQuotaHit(first, 'm')

    expect(relay.quotaBlocked(first, 'm')).not.toBeNull()
    expect(relay.quotaBlocked(second, 'm')).not.toBeNull()
  })

  it('不同共享组不共享锁定', () => {
    const first = makeProvider({ apiKey: 'sk-1', quota: { ...makeProvider().quota, group: 'a' } })
    const second = makeProvider({ apiKey: 'sk-2', quota: { ...makeProvider().quota, group: 'b' } })

    relay.noteQuotaHit(first, 'm')

    expect(relay.quotaBlocked(second, 'm')).toBeNull()
  })

  it('手动解锁清掉锁定与等级，真实调用可重新探测', () => {
    const provider = makeProvider()
    relay.noteQuotaHit(provider, 'm')
    expect(relay.quotaBlocked(provider, 'm')).not.toBeNull()

    const cleared = relay.unlockQuota(provider.id)
    expect(cleared).toBeGreaterThan(0)
    expect(relay.quotaBlocked(provider, 'm')).toBeNull()
    expect(relay.quotaLocked(provider, 'm')).toBeNull()
  })

  it('分钟级限流 429 不触发额度锁定', () => {
    const provider = makeProvider()
    const lock = relay.noteQuotaHit(provider, 'm', { signal: 'rate' })
    expect(lock).toBeNull()
    expect(relay.quotaBlocked(provider, 'm')).toBeNull()
  })

  it('跨过观察窗的孤立 429 不累计误锁', () => {
    const provider = makeProvider({
      quota: { ...makeProvider().quota, confirmStrikes: 3, confirmIntervalMinutes: 1 },
    })
    // 第 1、2 次：确认点不足 3 个，不锁定
    expect(relay.noteQuotaHit(provider, 'm')).toBeNull()
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(relay.noteQuotaHit(provider, 'm')).toBeNull()
    // 跳到观察窗（9 分钟）之外再出现孤立 429：旧确认点全部过期，重新计数
    vi.advanceTimersByTime(16 * 60 * 1000)
    expect(relay.noteQuotaHit(provider, 'm')).toBeNull()
    expect(relay.quotaBlocked(provider, 'm')).toBeNull()
  })

  it('确认间隔内的高频 429 不累计确认点，防止把瞬时限流判成额度耗尽', () => {
    const provider = makeProvider({
      quota: { ...makeProvider().quota, confirmStrikes: 3, confirmIntervalMinutes: 2 },
    })
    // 30 秒内连打 10 次：只有第 1 次计入确认点，其余被确认间隔拦下
    for (let i = 0; i < 10; i++) {
      expect(relay.noteQuotaHit(provider, 'm')).toBeNull()
      vi.advanceTimersByTime(3 * 1000)
    }
    expect(relay.quotaBlocked(provider, 'm')).toBeNull()
  })

  it('商汤 429 速率/额度同码：明确 quota 信号也只走 5 分钟探测，不直接锁 5 小时', () => {
    // 默认 baseUrl 就是 token.sensenova.cn，验证按域名识别
    const provider = makeProvider()
    const lock = relay.noteQuotaHit(provider, 'm', { signal: 'quota' })

    expect(lock.level).toBe('probe')
    expect(relay.quotaBlocked(provider, 'm').retryAfter).toBeLessThanOrEqual(5 * 60)
    expect(relay.quotaBlocked(provider, 'm').retryAfter).toBeGreaterThan(4 * 60)
  })

  it('presetId = sensenova 的提供商同样降级 quota 信号', () => {
    const provider = makeProvider({
      presetId: 'sensenova',
      baseUrl: 'https://custom.example.com/v1',
    })
    const lock = relay.noteQuotaHit(provider, 'm', { signal: 'quota' })

    expect(lock.level).toBe('probe')
  })

  it('非商汤上游明确 quota 信号仍直接锁 5 小时', () => {
    const provider = makeProvider({ baseUrl: 'https://discovery-api.intern-ai.org.cn/v1' })
    const lock = relay.noteQuotaHit(provider, 'm', { signal: 'quota' })

    expect(lock.level).toBe('5h')
    expect(relay.quotaBlocked(provider, 'm').retryAfter).toBeGreaterThan(4 * 60 * 60)
  })

  it('商汤探测锁到期后的真实 429 仍正常升级 5 小时', () => {
    const provider = makeProvider()
    relay.noteQuotaHit(provider, 'm', { signal: 'quota' })

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    expect(relay.quotaLocked(provider, 'm')).toBeNull()
    const fiveHour = relay.noteQuotaHit(provider, 'm', { signal: 'quota' })
    expect(fiveHour.level).toBe('5h')
  })
})

describe('真实调用不受本地计数限制', () => {
  let upstream
  let upstreamPort

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port
  })

  afterAll(async () => {
    await relay.stop()
    upstream?.close()
    relay.clearRuntime()
  })

  it('连续成功不会因为本地计数被拦住', async () => {
    relay.clearRuntime()
    const info = await relay.start({
      port: 0,
      providers: [makeProvider({ baseUrl: `http://127.0.0.1:${upstreamPort}` })],
    })
    relay.clearLogs()

    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] }),
      })
      expect(response.status).toBe(200)
      await response.json()
    }

    expect(relay.quotaBlocked(makeProvider())).toBeNull()
  })
})

describe('parse429Signal：区分额度耗尽与瞬时限流', () => {
  const signalOf = (payload) => relay.parse429Signal(JSON.stringify(payload))

  it('额度类错误码 → quota', () => {
    expect(signalOf({ error: { code: 'insufficient_quota' } })).toBe('quota')
    expect(signalOf({ error: { type: 'quota_exceeded_error' } })).toBe('quota')
    expect(signalOf({ code: 'insufficient_balance' })).toBe('quota')
    expect(signalOf({ error: { code: '', message: 'billing limit reached' } })).toBe('quota')
  })

  it('限流类错误码 → rate', () => {
    expect(signalOf({ error: { code: 'rate_limit_exceeded' } })).toBe('rate')
    expect(signalOf({ error: { code: 'throttling' } })).toBe('rate')
    expect(signalOf({ error: { message: 'Too Many Requests' } })).toBe('rate')
  })

  it('无法区分时返回空串，交由连续确认判定', () => {
    expect(signalOf({ error: { code: 'invalid_request_error' } })).toBe('')
    expect(relay.parse429Signal('not json')).toBe('')
    expect(relay.parse429Signal('')).toBe('')
  })
})

describe('429 额度锁定日志（端到端）', () => {
  let upstream
  let upstreamPort

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'quota_exceeded', message: 'quota exhausted' } }))
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port
  })

  afterAll(async () => {
    await relay.stop()
    upstream?.close()
    relay.clearRuntime()
  })

  it('锁定额度时同一次尝试只写一条日志，并合并额度信息', async () => {
    relay.clearRuntime()
    const info = await relay.start({
      port: 0,
      providers: [
        makeProvider({
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-lock',
        }),
      ],
    })
    relay.clearLogs()

    const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    await response.json()

    expect(response.status).toBe(429)
    const logs = relay.getLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 429, attempt: 1, quota: true })
    expect(logs[0].error).toContain('额度耗尽')
    expect(relay.quotaBlocked(makeProvider({ apiKey: 'sk-lock' }), 'm')).not.toBeNull()
  })
})
