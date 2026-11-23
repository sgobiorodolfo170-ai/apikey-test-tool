import { describe, expect, it } from 'vitest'
import {
  CHANNEL_AUTH_TYPES,
  CHANNEL_CAPABILITIES,
  CHANNEL_PERMISSIONS,
  validateAdapter,
  validateChannelManifest,
} from '../contract.js'

function fn() {
  return () => {}
}

function validAdapter(overrides = {}) {
  return {
    meta: { id: 'demo', name: 'Demo', authType: 'bearer', capabilities: ['chat', 'stream'] },
    credentials: { list: fn(), import: fn(), validate: fn() },
    models: { list: fn() },
    chat: { send: fn(), stream: fn() },
    ...overrides,
  }
}

describe('channels contract：适配器校验', () => {
  it('合法适配器通过', () => {
    expect(validateAdapter(validAdapter()).ok).toBe(true)
  })

  it('枚举常量冻结且含 dailyClaim / oauth', () => {
    expect(CHANNEL_CAPABILITIES).toContain('dailyClaim')
    expect(CHANNEL_AUTH_TYPES).toContain('oauth')
    expect(CHANNEL_PERMISSIONS).toContain('dailyClaim')
    expect(Object.isFrozen(CHANNEL_CAPABILITIES)).toBe(true)
  })

  it('非对象拒绝', () => {
    expect(validateAdapter(null).ok).toBe(false)
    expect(validateAdapter([]).ok).toBe(false)
  })

  it('缺 meta / id / name 拒绝', () => {
    expect(validateAdapter(validAdapter({ meta: undefined })).ok).toBe(false)
    expect(
      validateAdapter(
        validAdapter({ meta: { id: '', name: 'x', authType: 'bearer', capabilities: [] } }),
      ).ok,
    ).toBe(false)
  })

  it('未知 authType 拒绝', () => {
    const a = validAdapter()
    a.meta.authType = 'magic'
    expect(validateAdapter(a).ok).toBe(false)
  })

  it('白名单之外的能力声明拒绝（伪造 / 注入不予承认）', () => {
    const a = validAdapter()
    a.meta.capabilities = ['chat', 'fingerprintSpoof']
    const result = validateAdapter(a)
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('fingerprintSpoof')
  })

  it('credentials / models / chat 缺方法拒绝', () => {
    expect(validateAdapter(validAdapter({ credentials: { list: fn() } })).ok).toBe(false)
    expect(validateAdapter(validAdapter({ models: {} })).ok).toBe(false)
    expect(validateAdapter(validAdapter({ chat: { send: fn() } })).ok).toBe(false)
    expect(validateAdapter(validAdapter({ chat: { send: 'no', stream: fn() } })).ok).toBe(false)
  })

  it('oauth 必须提供 begin/complete', () => {
    const a = validAdapter()
    a.meta.authType = 'oauth'
    expect(validateAdapter(a).ok).toBe(false)
    a.auth = { begin: fn(), complete: fn() }
    expect(validateAdapter(a).ok).toBe(true)
  })

  it('claimDaily 未声明 dailyClaim 能力时拒绝', () => {
    const a = validAdapter()
    a.quota = { claimDaily: fn() }
    expect(validateAdapter(a).ok).toBe(false)
    a.meta.capabilities = ['chat', 'dailyClaim']
    expect(validateAdapter(a).ok).toBe(true)
  })

  it('quota.fetch 可选且无需 dailyClaim', () => {
    const a = validAdapter()
    a.quota = { fetch: fn() }
    expect(validateAdapter(a).ok).toBe(true)
  })
})

describe('channels contract：manifest 校验', () => {
  const manifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    entry: 'index.cjs',
    permissions: ['network', 'credentials'],
  }

  it('合法 manifest 通过', () => {
    expect(validateChannelManifest(manifest).ok).toBe(true)
  })

  it('缺字段拒绝', () => {
    expect(validateChannelManifest({ ...manifest, version: '' }).ok).toBe(false)
    expect(validateChannelManifest({ ...manifest, entry: '' }).ok).toBe(false)
  })

  it('绝对路径与 .. 穿越拒绝', () => {
    expect(validateChannelManifest({ ...manifest, entry: 'C:/evil.cjs' }).ok).toBe(false)
    expect(validateChannelManifest({ ...manifest, entry: '/etc/passwd' }).ok).toBe(false)
    expect(validateChannelManifest({ ...manifest, entry: '../escape.cjs' }).ok).toBe(false)
    expect(validateChannelManifest({ ...manifest, entry: 'sub/../../escape.cjs' }).ok).toBe(false)
  })

  it('未知权限拒绝', () => {
    expect(validateChannelManifest({ ...manifest, permissions: ['network', 'spoof'] }).ok).toBe(
      false,
    )
  })

  it('permissions 非数组拒绝', () => {
    expect(validateChannelManifest({ ...manifest, permissions: 'network' }).ok).toBe(false)
  })
})
