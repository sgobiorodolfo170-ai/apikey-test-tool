import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

const makeProvider = (overrides = {}) => ({
  id: 'q',
  name: '上游',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-very-secret',
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
})

describe('额度锁键不落明文 Key', () => {
  let file

  beforeEach(() => {
    file = path.join(os.tmpdir(), `relay-quota-key-${Date.now()}-${Math.random()}.json`)
    relay.clearRuntime()
  })

  afterEach(() => {
    try {
      fs.rmSync(file)
    } catch {
      // 文件不存在
    }
  })

  it('独立 Key 的额度池键使用短哈希而非明文', () => {
    const key = relay.quotaPoolKeyOf(makeProvider(), 'm')
    expect(key).not.toContain('sk-very-secret')
    expect(key).toMatch(/^q::[0-9a-f]{16}::m$/)
  })

  it('共享组池键沿用组名，不包含 Key', () => {
    const provider = makeProvider({
      quota: { enabled: true, keyGroups: { 'sk-very-secret': 'account-a' } },
    })
    expect(relay.quotaPoolKeyOf(provider, 'm')).toBe('group:q::account-a::m')
  })

  it('旧版锁文件里的明文 Key 迁移为哈希键并重写文件', async () => {
    const provider = makeProvider()
    const until = Date.now() + 60 * 60 * 1000
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        logs: [],
        locks: [['q::sk-very-secret::m', { until, level: '5h', at: Date.now() }]],
        levels: [['q::sk-very-secret::m', { level: '5h', at: Date.now() }]],
      }),
    )

    relay.attachStorage(file)
    expect(relay.quotaBlocked(provider, 'm')).toMatchObject({ locked: true, window: '5h' })

    await relay.persistNow()
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved).not.toContain('sk-very-secret')
    expect(saved).toContain(relay.quotaPoolKeyOf(provider, 'm'))
  })
})
