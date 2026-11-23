import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
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
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
      confirmSpanMinutes: 9,
    },
    ...overrides,
  }
}

function generic(overrides = {}) {
  return {
    id: 'generic',
    name: '普通上游',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-generic',
    models: ['m1'],
    enabled: true,
    maxConcurrency: 8,
    rpmLimit: 2,
    quota: {
      enabled: true,
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

  it('端砚 RPM 按官方「每用户」口径合并：跨 Key 与模型共享窗口', async () => {
    const keyA = duanyan()
    const keyB = duanyan({ apiKey: 'sk-test-b' })

    const a1 = await relay.acquireSlot(keyA, false, 'm1')
    const a2 = await relay.acquireSlot(keyA, false, 'm2')
    a1()
    a2()

    // rpmLimit=2：换模型、换 Key 都共享同一个用户级窗口
    await expect(relay.acquireSlot(keyA, false, 'm2')).rejects.toMatchObject({
      code: 'rate_limited',
    })
    await expect(relay.acquireSlot(keyB, false, 'm1')).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('默认提供商仍是「提供商级」RPM，多 Key 共享', async () => {
    const provider = generic()
    const keyB = generic({ apiKey: 'sk-generic-b' })

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

  it('端砚真实额度耗尽直接锁 5 小时，不再锁自然月', () => {
    const provider = duanyan()
    const lock = relay.noteQuotaHit(provider, 'm1', { signal: 'quota' })
    expect(lock).toBeTruthy()
    expect(lock.level).toBe('5h')

    const blocked = relay.quotaBlocked(provider, 'm1')
    expect(blocked.window).toBe('5h')
    // 不再是下月 1 日：只锁 5 小时
    expect(lock.until).toBeLessThan(Date.now() + 5 * 60 * 60 * 1000 + 1000)
  })

  it('端砚 5 小时后仍真实失败升级 7 天', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'))
    try {
      const provider = duanyan()
      const fiveHour = relay.noteQuotaHit(provider, 'm1', { signal: 'quota' })
      expect(fiveHour.level).toBe('5h')

      vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1000)
      expect(relay.quotaLocked(provider, 'm1')).toBeNull()
      const week = relay.noteQuotaHit(provider, 'm1', { signal: 'quota' })
      expect(week.level).toBe('week')
    } finally {
      vi.useRealTimers()
    }
  })

  it('非端砚提供商同样使用真实响应保护，不出现 month 窗口', () => {
    const provider = generic()

    const lock = relay.noteQuotaHit(provider, 'm1', { signal: 'quota' })
    expect(lock).toBeTruthy()
    expect(lock.level).toBe('5h')
    expect(relay.quotaBlocked(provider, 'm1').window).toBe('5h')
  })
})
