import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_STATUSES,
  QUOTA_LEVELS,
  cooldownAccount,
  isAccountAvailable,
  migrateProviderAccounts,
  newAccountId,
  normalizeAccount,
  pickAccount,
  recordDailyClaim,
  rejectAccount,
} from '../accounts.js'

const NOW = 1_700_000_000_000

describe('channels accounts：迁移', () => {
  it('apiKeys 去重 + apiKey 兼容，逐把生成账号', () => {
    const provider = { id: 'p_1', apiKeys: ['k1', 'k2', 'k1'], apiKey: 'k1' }
    const next = migrateProviderAccounts(provider)
    expect(next.accounts).toHaveLength(2)
    expect(next.accounts[0].label).toBe('Key 1')
    expect(next.accounts[1].label).toBe('Key 2')
    expect(next.accounts[0].credentialRef).toContain('relay:provider:p_1:')
    // 兼容字段不被改动
    expect(next.apiKeys).toEqual(['k1', 'k2', 'k1'])
    expect(next.apiKey).toBe('k1')
  })

  it('账号不复制明文 Key', () => {
    const next = migrateProviderAccounts({ id: 'p_1', apiKeys: ['sk-secret'] })
    expect(JSON.stringify(next.accounts)).not.toContain('sk-secret')
  })

  it('无 Key 生成空账号池', () => {
    expect(migrateProviderAccounts({ id: 'p_1' }).accounts).toEqual([])
  })

  it('已有 accounts 只归一化不重建', () => {
    const provider = {
      id: 'p_1',
      apiKeys: ['k1'],
      accounts: [{ id: 'a_keep', label: '主号', status: 'ready' }],
    }
    const next = migrateProviderAccounts(provider)
    expect(next.accounts).toHaveLength(1)
    expect(next.accounts[0].id).toBe('a_keep')
    expect(next.accounts[0].label).toBe('主号')
    expect(next.accounts[0].status).toBe('ready')
  })

  it('非法 status / quota.level 归一为默认', () => {
    const a = normalizeAccount({ status: 'bogus', quota: { level: 'bogus' } })
    expect(a.status).toBe('unknown')
    expect(a.quota.level).toBe('none')
    expect(ACCOUNT_STATUSES).toContain(a.status)
    expect(QUOTA_LEVELS).toContain(a.quota.level)
  })
})

describe('channels accounts：可用性与调度', () => {
  const base = normalizeAccount({ id: 'a1' })

  it('默认可用', () => {
    expect(isAccountAvailable(base, NOW)).toBe(true)
  })

  it('冷却中 / 额度耗尽 / 禁用 / 拒因 不可用', () => {
    expect(isAccountAvailable({ ...base, cooldownUntil: NOW + 1000 }, NOW)).toBe(false)
    expect(isAccountAvailable({ ...base, quota: { level: 'exhausted' } }, NOW)).toBe(false)
    expect(isAccountAvailable({ ...base, status: 'disabled' }, NOW)).toBe(false)
    expect(isAccountAvailable({ ...base, status: 'rejected' }, NOW)).toBe(false)
  })

  it('冷却到期恢复可用', () => {
    expect(isAccountAvailable({ ...base, cooldownUntil: NOW - 1 }, NOW)).toBe(true)
  })

  it('pickAccount 取第一个可用，跳过不可用', () => {
    const accounts = [
      { ...base, id: 'a1', status: 'disabled' },
      { ...base, id: 'a2' },
      { ...base, id: 'a3' },
    ]
    expect(pickAccount(accounts, NOW).id).toBe('a2')
  })

  it('pickAccount 粘性优先复用 lastId', () => {
    const accounts = [
      { ...base, id: 'a1' },
      { ...base, id: 'a2' },
    ]
    expect(pickAccount(accounts, NOW, 'a2').id).toBe('a2')
    // lastId 不可用时回退第一个可用
    expect(
      pickAccount(
        [
          { ...base, id: 'a1' },
          { ...base, id: 'a2', status: 'disabled' },
        ],
        NOW,
        'a2',
      ).id,
    ).toBe('a1')
  })

  it('全不可用返回 null', () => {
    expect(pickAccount([{ ...base, status: 'disabled' }], NOW)).toBeNull()
    expect(pickAccount([], NOW)).toBeNull()
  })
})

describe('channels accounts：状态变更', () => {
  const base = normalizeAccount({ id: 'a1' })

  it('cooldownAccount 设置冷却与状态', () => {
    const next = cooldownAccount(base, 5000, NOW)
    expect(next.status).toBe('cooldown')
    expect(next.cooldownUntil).toBe(NOW + 5000)
    expect(isAccountAvailable(next, NOW)).toBe(false)
    expect(isAccountAvailable(next, NOW + 5000)).toBe(true)
  })

  it('rejectAccount 标记拒因', () => {
    expect(rejectAccount(base).status).toBe('rejected')
  })

  it('recordDailyClaim 记录时间与结果', () => {
    const next = recordDailyClaim(base, 'ok', NOW)
    expect(next.dailyClaim).toEqual({ lastAt: NOW, result: 'ok' })
  })

  it('newAccountId 唯一且带 a_ 前缀', () => {
    const a = newAccountId()
    const b = newAccountId()
    expect(a.startsWith('a_')).toBe(true)
    expect(a).not.toBe(b)
  })
})
