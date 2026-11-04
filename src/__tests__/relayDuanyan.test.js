import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

function duanyan(overrides = {}) {
  return {
    id: 'duanyan',
    name: '书生·端砚',
    baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    presetId: 'duanyan',
    apiKey: 'sk-test-a',
    models: ['m1', 'm2'],
    enabled: true,
    maxConcurrency: 8,
    rpmLimit: 2,
    quota: {
      enabled: true,
      metric: 'credit',
      windowMode: 'calendar-month',
      limitMonth: 10,
      perModel: false,
      modelRates: { m1: 4, m2: 8 },
      reserveRatio: 0,
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
      confirmSpanMinutes: 9,
    },
    ...overrides,
  }
}

function legacy(overrides = {}) {
  return {
    id: 'sensenova',
    name: '商汤日日新',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKey: 'sk-legacy',
    models: ['m1'],
    enabled: true,
    maxConcurrency: 8,
    rpmLimit: 2,
    quota: {
      enabled: true,
      metric: 'request',
      limit5h: 100,
      limitWeek: 1000,
      confirmStrikes: 3,
      confirmIntervalMinutes: 0.002,
      confirmSpanMinutes: 1,
    },
    ...overrides,
  }
}

describe('端砚专项策略（不影响其它提供商）', () => {
  beforeEach(() => relay.clearRuntime())
  afterAll(() => relay.clearRuntime())

  it('RPM 按 Key × 模型独立计数', async () => {
    const keyA = duanyan()
    const keyB = duanyan({ apiKey: 'sk-test-b' })

    const release1 = await relay.acquireSlot(keyA, false, 'm1')
    const release2 = await relay.acquireSlot(keyA, false, 'm1')
    release1()
    release2()

    // 同一 Key 同一模型第 3 次超限
    await expect(relay.acquireSlot(keyA, false, 'm1')).rejects.toMatchObject({
      code: 'rate_limited',
    })

    // 同一 Key 换模型：独立额度
    const other = await relay.acquireSlot(keyA, false, 'm2')
    other()

    // 另一把 Key 同一模型：独立额度
    const another = await relay.acquireSlot(keyB, false, 'm1')
    another()
  })

  it('默认提供商仍是「提供商级」RPM，多 Key 共享', async () => {
    const provider = legacy()
    const keyB = legacy({ apiKey: 'sk-legacy-b' })

    const a1 = await relay.acquireSlot(provider, false, 'm1')
    const a2 = await relay.acquireSlot(provider, false, 'm1')
    a1()
    a2()

    // 默认策略用 provider.id 做键：换 Key 也共享同一个窗口
    await expect(relay.acquireSlot(keyB, false, 'm1')).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('端砚分钟限流（rate）不会误锁额度窗口', () => {
    const provider = duanyan()
    for (let index = 0; index < 5; index += 1) {
      relay.noteQuotaHit(provider, 'm1', { signal: 'rate' })
    }
    expect(relay.quotaLocked(provider, 'm1')).toBeNull()
  })

  it('端砚余额不足（quota）直接锁到下月 1 日', () => {
    const provider = duanyan()
    const lock = relay.noteQuotaHit(provider, 'm1', { signal: 'quota' })
    expect(lock).toBeTruthy()
    expect(lock.level).toBe('month')
    const until = new Date(lock.until)
    expect(until.getDate()).toBe(1)
    expect(lock.until).toBeGreaterThan(Date.now())
  })

  it('自然月额度用尽后 quotaBlocked 返回 month 窗口', () => {
    const provider = duanyan()
    // 每次 1M tokens × 4 墨点 = 4 墨点，三次即 12 > 10
    for (let index = 0; index < 3; index += 1) {
      relay.recordQuota(provider, { status: 200, usage: { total: 1_000_000 }, model: 'm1' })
    }
    const blocked = relay.quotaBlocked(provider, 'm1')
    expect(blocked).toBeTruthy()
    expect(blocked.window).toBe('month')
  })

  it('余额预扣：不足时直接拒绝，释放后可再次预扣', () => {
    const provider = duanyan()
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
    })
    const cost = relay.estimateCostOf(provider, 'm1', body)
    expect(cost).toBeGreaterThan(0)

    const release = relay.reserveQuota(provider, 'm1', 9)
    expect(typeof release).toBe('function')
    expect(relay.reserveQuota(provider, 'm1', 2)).toBe(false)
    release()
    const again = relay.reserveQuota(provider, 'm1', 2)
    expect(typeof again).toBe('function')
    again()
  })

  it('预扣不足会短期跳过该 Key，避免反复排队', () => {
    const provider = duanyan()
    relay.markQuotaShortage(provider, 'm1')
    const blocked = relay.quotaBlocked(provider, 'm1')
    expect(blocked).toBeTruthy()
    expect(blocked.window).toBe('month')
    expect(blocked.locked).toBe(true)
    expect(relay.quotaShortageOf(provider, 'm1')).toBeGreaterThan(Date.now())
  })

  it('非端砚提供商不启用月窗口与预扣', () => {
    const provider = legacy()
    expect(relay.estimateCostOf(provider, 'm1', '{"messages":[]}')).toBe(0)
    expect(relay.reserveQuota(provider, 'm1', 1)).toBeNull()

    const lock = relay.noteQuotaHit(provider, 'm1', { signal: 'quota' })
    expect(lock).toBeTruthy()
    expect(lock.level).not.toBe('month')
  })
})
