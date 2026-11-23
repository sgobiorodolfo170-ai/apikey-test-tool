import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { walkSecrets } = require('../../electron/lib/secrets.cjs')

const encrypt = async (value) => {
  if (!value || value.startsWith('enc:')) return value
  return `enc:${Buffer.from(value, 'utf8').toString('base64')}`
}

const decrypt = async (value) => {
  if (!value.startsWith('enc:')) return value
  try {
    return Buffer.from(value.slice(4), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

const sample = () => ({
  providers: [
    {
      id: 'p',
      name: '上游',
      apiKey: 'sk-legacy',
      apiKeys: ['sk-a', 'sk-b'],
      models: ['m'],
      quota: {
        enabled: true,
        groups: ['account-a'],
        keyGroups: { 'sk-a': 'account-a' },
      },
    },
  ],
  clientKeys: [{ key: 'sk-client', label: '客户端1' }],
  history: [{ config: { apiKey: 'sk-history' } }],
})

describe('walkSecrets 密钥字段规则', () => {
  it('加密 apiKey / apiKeys / clientKeys / keyGroups，保留其余字段', async () => {
    const result = await walkSecrets(sample(), encrypt)
    const provider = result.providers[0]
    expect(provider.apiKey).toMatch(/^enc:/)
    expect(provider.apiKeys.every((key) => key.startsWith('enc:'))).toBe(true)
    expect(provider.models).toEqual(['m'])
    expect(provider.quota.groups).toEqual(['account-a'])
    expect(Object.keys(provider.quota.keyGroups)[0]).toMatch(/^enc:/)
    expect(provider.quota.keyGroups[Object.keys(provider.quota.keyGroups)[0]]).toBe('account-a')
    expect(result.clientKeys[0].key).toMatch(/^enc:/)
    expect(result.clientKeys[0].label).toBe('客户端1')
    expect(result.history[0].config.apiKey).toMatch(/^enc:/)
  })

  it('已加密的值重复处理保持幂等', async () => {
    const once = await walkSecrets(sample(), encrypt)
    const twice = await walkSecrets(once, encrypt)
    expect(twice).toEqual(once)
  })

  it('解密后恢复全部明文，且不误伤普通字段', async () => {
    const sealed = await walkSecrets(sample(), encrypt)
    const plain = await walkSecrets(sealed, decrypt)
    const provider = plain.providers[0]
    expect(provider.apiKey).toBe('sk-legacy')
    expect(provider.apiKeys).toEqual(['sk-a', 'sk-b'])
    expect(provider.quota.keyGroups).toEqual({ 'sk-a': 'account-a' })
    expect(plain.clientKeys[0]).toEqual({ key: 'sk-client', label: '客户端1' })
    expect(plain.history[0].config.apiKey).toBe('sk-history')
  })

  it('旧版明文数据解密时原样返回', async () => {
    expect(await walkSecrets(sample(), decrypt)).toEqual(sample())
  })

  it('keyGroups 解密失败时保留原键，不吞掉分组映射', async () => {
    const sealed = await walkSecrets(sample(), encrypt)
    const failed = async (value) => (value.startsWith('enc:') ? '' : value)
    const result = await walkSecrets(sealed, failed)
    const groups = result.providers[0].quota.keyGroups
    expect(Object.keys(groups)).toHaveLength(1)
    expect(Object.keys(groups)[0]).toMatch(/^enc:/)
    expect(Object.values(groups)[0]).toBe('account-a')
  })
})
