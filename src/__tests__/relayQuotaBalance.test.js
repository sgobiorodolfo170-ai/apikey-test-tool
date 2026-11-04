import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

describe('429 撞墙判定（修复饥饿与误锁）', () => {
  beforeEach(() => relay.clearRuntime())

  it('高频 429 不再因刷新计时而永远累计不到 strikes', async () => {
    const provider = makeProvider()
    // 每 150ms 撞一次 429（间隔 120ms 的规则要求）：第一次计数，之后应能继续累计
    for (let index = 0; index < 3; index += 1) {
      relay.noteQuotaHit(provider)
      await sleep(150)
    }
    const lock = relay.quotaLocked(provider)
    expect(lock).toBeTruthy()
    expect(lock.level).toBe('5h')
  })

  it('跨超过观察窗的孤立 429 不会累计误锁', async () => {
    const provider = makeProvider({
      quota: {
        ...makeProvider().quota,
        confirmSpanMinutes: 0.01, // 600ms 观察窗
      },
    })

    relay.noteQuotaHit(provider)
    await sleep(700)
    relay.noteQuotaHit(provider)
    await sleep(700)
    relay.noteQuotaHit(provider)

    expect(relay.quotaLocked(provider)).toBeNull()
  })

  it('上游明确返回额度耗尽时直接锁定，不等多次确认', () => {
    const provider = makeProvider()
    const lock = relay.noteQuotaHit(provider, undefined, { signal: 'quota' })
    expect(lock).toBeTruthy()
    expect(relay.quotaBlocked(provider)?.locked).toBe(true)
  })
})

describe('额度计数口径与按模型/共享组', () => {
  beforeEach(() => relay.clearRuntime())

  it('只统计 2xx：404 / 400 / 429 都不占请求次数', () => {
    const provider = makeProvider()
    relay.recordQuota(provider, { status: 404 })
    relay.recordQuota(provider, { status: 400 })
    relay.recordQuota(provider, { status: 429 })
    relay.recordQuota(provider, { status: 500 })
    expect(relay.quotaUsageOf(provider).used5h).toBe(0)

    relay.recordQuota(provider, { status: 200 })
    expect(relay.quotaUsageOf(provider).used5h).toBe(1)
  })

  it('按 Key 配置共享组：同组共享、异组独立', () => {
    const provider = makeProvider({
      apiKeys: ['sk-1', 'sk-2', 'sk-3'],
      quota: {
        ...makeProvider().quota,
        group: '',
        limit5h: 1,
        keyGroups: { 'sk-1': 'account-a', 'sk-2': 'account-a', 'sk-3': 'account-b' },
      },
    })

    relay.recordQuota({ ...provider, apiKey: 'sk-1' }, { status: 200 })

    expect(relay.quotaBlocked({ ...provider, apiKey: 'sk-1' })).not.toBeNull()
    expect(relay.quotaBlocked({ ...provider, apiKey: 'sk-2' })).not.toBeNull()
    expect(relay.quotaBlocked({ ...provider, apiKey: 'sk-3' })).toBeNull()
  })

  it('Key 没有单独配置组时回落到默认组', () => {
    const provider = makeProvider({
      apiKey: 'sk-x',
      quota: { ...makeProvider().quota, group: 'default-group', limit5h: 1 },
    })

    relay.recordQuota(provider, { status: 200 })
    expect(relay.quotaBlocked(provider)).not.toBeNull()
  })

  it('同名共享组不会跨提供商合并', () => {
    const first = makeProvider({
      id: 'p1',
      apiKey: 'sk-1',
      quota: { ...makeProvider().quota, group: 'same-name', limit5h: 1 },
    })
    const second = { ...first, id: 'p2', apiKey: 'sk-2' }

    relay.recordQuota(first, { status: 200 })

    expect(relay.quotaBlocked(first)).not.toBeNull()
    expect(relay.quotaBlocked(second)).toBeNull()
  })

  it('按模型独立额度：低额度模型先被本地拦住，不影响其它模型', () => {
    const provider = makeProvider({
      models: ['flash-lite', 'deepseek-v4-flash'],
      quota: {
        ...makeProvider().quota,
        perModel: true,
        limit5h: 1500,
        limitWeek: 15000,
        modelLimits: { 'deepseek-v4-flash': { limit5h: 1, limitWeek: 10 } },
      },
    })

    relay.recordQuota(provider, { status: 200, model: 'deepseek-v4-flash' })

    expect(relay.quotaBlocked(provider, 'deepseek-v4-flash')).not.toBeNull()
    expect(relay.quotaBlocked(provider, 'flash-lite')).toBeNull()
    expect(relay.quotaLimitOf(provider, 'deepseek-v4-flash').limit5h).toBe(1)
    expect(relay.quotaLimitOf(provider, 'flash-lite').limit5h).toBe(1500)
  })

  it('共享额度组：同组的多把 Key 共用一个池', () => {
    const first = makeProvider({
      apiKey: 'sk-1',
      quota: { ...makeProvider().quota, group: 'sensenova-account-a', limit5h: 1 },
    })
    const second = { ...first, apiKey: 'sk-2' }

    relay.recordQuota(first, { status: 200 })

    expect(relay.quotaBlocked(first)).not.toBeNull()
    expect(relay.quotaBlocked(second)).not.toBeNull()
    // 不同组仍是独立池
    const other = { ...second, quota: { ...second.quota, group: 'other-account' } }
    expect(relay.quotaBlocked(other)).toBeNull()
  })
})

describe('多 Key 剩余额度调度', () => {
  beforeEach(() => relay.clearRuntime())

  it('水位越低的 Key 权重越低，顺序优先选剩余额度多的 Key', () => {
    const provider = makeProvider({
      apiKeys: ['sk-low', 'sk-high'],
      quota: { ...makeProvider().quota, limit5h: 100, limitWeek: 1000, reserveRatio: 0 },
    })

    // 把 sk-low 打到只剩 10%
    for (let index = 0; index < 90; index += 1) {
      relay.recordQuota({ ...provider, apiKey: 'sk-low' }, { status: 200 })
    }

    const low = relay.quotaWeightOf({ ...provider, apiKey: 'sk-low' })
    const high = relay.quotaWeightOf({ ...provider, apiKey: 'sk-high' })
    expect(high).toBeGreaterThan(low)

    const order = relay.orderedKeysOf(provider)
    expect(order[0]).toBe('sk-high')
  })

  it('未开启额度窗口时仍保持普通轮询', () => {
    const provider = makeProvider({ quota: undefined, apiKey: '', apiKeys: ['k1', 'k2'] })
    expect(relay.orderedKeysOf(provider)).toEqual(['k1', 'k2'])
    expect(relay.orderedKeysOf(provider)).toEqual(['k2', 'k1'])
  })
})

describe('Retry-After 与 429 信号解析', () => {
  it('解析秒数与 HTTP-date', () => {
    expect(relay.parseRetryAfterMs('120')).toBe(120000)
    expect(relay.parseRetryAfterMs(undefined)).toBe(0)
    expect(relay.parseRetryAfterMs('not-a-date')).toBe(0)
    const httpDate = new Date(Date.now() + 5000).toUTCString()
    expect(relay.parseRetryAfterMs(httpDate)).toBeGreaterThan(3000)
  })

  it('区分额度耗尽与瞬时限流', () => {
    expect(relay.parse429Signal(JSON.stringify({ error: { code: 'insufficient_quota' } }))).toBe(
      'quota',
    )
    expect(
      relay.parse429Signal(JSON.stringify({ error: { message: 'rate limit exceeded' } })),
    ).toBe('rate')
    expect(relay.parse429Signal('plain text')).toBe('')
  })
})

describe('额度锁持久化与半开恢复', () => {
  const tmpFile = path.join(os.tmpdir(), `relay-quota-${process.pid}-${Date.now()}.json`)
  const emptyFile = path.join(os.tmpdir(), `relay-empty-${process.pid}-${Date.now()}.json`)

  afterAll(() => {
    relay.clearRuntime()
    relay.attachStorage(emptyFile)
    for (const file of [tmpFile, emptyFile]) {
      try {
        fs.unlinkSync(file)
      } catch {
        // 文件可能未创建
      }
    }
  })

  it('恢复上次的 5h 等级：半开探测失败时升级为周锁', () => {
    const provider = makeProvider()
    const key = relay.quotaPoolKeyOf(provider)
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        locks: [[key, { until: Date.now() - 1000, level: '5h', at: Date.now() - 600000 }]],
        levels: [[key, { level: '5h', at: Date.now() - 600000 }]],
      }),
      'utf8',
    )
    relay.attachStorage(tmpFile)

    // 过期锁会被清掉并进入半开探测
    expect(relay.quotaLocked(provider)).toBeNull()
    // 探测请求再次 429：直接升级为周锁
    const lock = relay.noteQuotaHit(provider)
    expect(lock).toBeTruthy()
    expect(lock.level).toBe('week')
    expect(relay.quotaBlocked(provider)?.window).toBe('week')
  })
})

describe('上游 429 透传与冷却（端到端）', () => {
  let upstream
  let upstreamPort

  afterAll(() => {
    relay.stop()
    upstream?.close()
  })

  it('把 Retry-After 透传给客户端，并用于本地冷却', async () => {
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' })
        res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }))
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = upstream.address().port

    relay.clearRuntime()
    const info = await relay.start({
      port: 0,
      providers: [
        makeProvider({
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          quota: {
            ...makeProvider().quota,
            confirmIntervalMinutes: 1,
            confirmSpanMinutes: 9,
          },
        }),
      ],
    })

    const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    await response.json()

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')

    const cooling = relay.getStatus().cooling.find((item) => item.key.includes('sk-a'))
    expect(cooling).toBeTruthy()
    expect(cooling.retryAfter).toBeGreaterThanOrEqual(2)
    // 单次 429 只短冷却，不立即锁额度
    expect(relay.quotaBlocked(makeProvider())).toBeNull()
  })
})
