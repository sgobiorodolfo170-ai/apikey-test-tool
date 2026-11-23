import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')
const file = path.join(os.tmpdir(), `relay-observations-${Date.now()}-${process.pid}.json`)

function localDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

describe('长期提供商观察', () => {
  beforeEach(() => {
    relay.clearRuntime()
    relay.clearLogs()
    relay.clearProviderObservations()
  })

  afterAll(async () => {
    relay.clearLogs()
    relay.clearProviderObservations()
    try {
      fs.rmSync(file)
    } catch {
      // 文件可能已不存在
    }
  })

  it('按提供商 + 模型 + 日期聚合真实调用结果', () => {
    const at = new Date().toISOString()
    const base = {
      at,
      model: 'm',
      provider: '商汤日日新',
      providerId: 'p1',
      keyTail: 'abc123',
      client: '工具A',
    }
    relay.pushLog({
      ...base,
      status: 200,
      ms: 120,
      usage: { prompt: 10, completion: 5, total: 15 },
    })
    relay.pushLog({ ...base, status: 429, ms: 9000, quota: true, error: '额度耗尽' })
    relay.pushLog({ ...base, status: 500, ms: 300, error: 'HTTP 500' })
    relay.pushLog({ ...base, status: 0, ms: 800, error: 'network' })
    relay.noteQuotaHit(
      {
        id: 'p1',
        name: '商汤日日新',
        apiKey: 'sk-test',
        quota: { enabled: true, confirmStrikes: 1, confirmIntervalMinutes: 1 },
      },
      'm',
    )

    const [row] = relay.getProviderObservations()
    expect(row).toMatchObject({
      provider: '商汤日日新',
      providerId: 'p1',
      model: 'm',
      date: localDateKey(new Date()),
      calls: 4,
      success: 1,
      rateLimited: 1,
      quotaLimited: 1,
      serverErrors: 1,
      networkErrors: 1,
    })
    expect(row.latency.sum).toBe(120 + 9000 + 300 + 800)
    expect(row.latency.max).toBe(9000)
    expect(row.latency.buckets[1]).toBe(2) // 120ms + 300ms
    expect(row.latency.buckets[4]).toBe(1) // 9000ms
    expect(row.tokens.total).toBe(15)
    expect(row.hourCalls[new Date().getHours()]).toBe(4)
    expect(row.hourRateLimited[new Date().getHours()]).toBe(1)
    expect(row.hourQuotaLimited[new Date().getHours()]).toBe(1)
  })

  it('不同提供商和模型分别聚合，不混在一起', () => {
    const at = new Date().toISOString()
    relay.pushLog({
      at,
      model: 'm1',
      provider: '商汤日日新',
      providerId: 'p1',
      keyTail: 'k1',
      status: 200,
      ms: 50,
    })
    relay.pushLog({
      at,
      model: 'm2',
      provider: '书生·端砚',
      providerId: 'p2',
      keyTail: 'k2',
      status: 429,
      ms: 1000,
    })

    const rows = relay.getProviderObservations()
    expect(rows).toHaveLength(2)
    const byProvider = Object.fromEntries(rows.map((row) => [row.providerId, row]))
    expect(byProvider.p1.calls).toBe(1)
    expect(byProvider.p1.success).toBe(1)
    expect(byProvider.p2.calls).toBe(1)
    expect(byProvider.p2.rateLimited).toBe(1)
  })

  it('记录真实 429 锁定等级与成功恢复', () => {
    const provider = {
      id: 'p1',
      name: '商汤日日新',
      apiKey: 'sk-test',
      models: ['m'],
      quota: { enabled: true, confirmStrikes: 1, confirmIntervalMinutes: 1, confirmSpanMinutes: 9 },
    }

    relay.noteQuotaHit(provider, 'm')
    relay.markSuccess(provider, 'm')

    const [row] = relay.getProviderObservations()
    expect(row.locks.probe).toBe(1)
    expect(row.recoveries).toBe(1)
    expect(row.lastRecoveryLevel).toBe('probe')
    expect(row.recoveryMsSum).toBeGreaterThanOrEqual(0)
  })

  it('持久化长期观察数据，并在恢复时丢弃超过 180 天的记录', async () => {
    const now = Date.now()
    fs.writeFileSync(
      file,
      JSON.stringify({
        providerDaily: [
          {
            providerId: 'p1',
            provider: '商汤日日新',
            model: 'm',
            date: localDateKey(new Date(now)),
            calls: 3,
            success: 2,
            rateLimited: 1,
          },
          {
            providerId: 'p1',
            provider: '商汤日日新',
            model: 'm',
            date: localDateKey(new Date(now - 200 * 24 * 60 * 60 * 1000)),
            calls: 10,
          },
        ],
      }),
    )

    relay.attachStorage(file)
    const rows = relay.getProviderObservations()
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe(localDateKey(new Date(now)))
    expect(rows[0].calls).toBe(3)

    await relay.persistNow()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.providerDaily).toHaveLength(1)
    expect(saved.providerDaily[0].calls).toBe(3)
  })

  it('升级前没有长期观察数据时，用保留的日志回填一次', () => {
    const at = new Date().toISOString()
    fs.writeFileSync(
      file,
      JSON.stringify({
        logs: [
          {
            at,
            model: 'm',
            provider: '书生·端砚',
            providerId: 'p2',
            keyTail: 'k2',
            status: 200,
            ms: 400,
            error: null,
            usage: { prompt: 1, completion: 1, total: 2 },
          },
        ],
      }),
    )

    relay.attachStorage(file)
    const [row] = relay.getProviderObservations()
    expect(row).toMatchObject({ provider: '书生·端砚', providerId: 'p2', model: 'm', calls: 1 })
  })
})
