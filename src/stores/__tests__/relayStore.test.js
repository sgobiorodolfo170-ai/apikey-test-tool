import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readRelay: vi.fn(() => Promise.resolve({ port: 8787, providers: [] })),
  saveRelay: vi.fn((config) => Promise.resolve(config)),
}))

import { useRelayStore } from '../relayStore.js'
import { useToastStore } from '../toastStore.js'
import { readRelay, saveRelay } from '../../utils/storage.js'

function mountBridge(overrides = {}) {
  const bridge = {
    start: vi.fn(async ({ port }) => ({
      ok: true,
      port,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      status: {
        running: true,
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        providers: 1,
        models: 2,
      },
    })),
    stop: vi.fn(async () => ({ ok: true, status: { running: false } })),
    status: vi.fn(async () => ({ ok: true, status: { running: false } })),
    update: vi.fn(async () => ({ ok: true, status: { running: true } })),
    fetchModels: vi.fn(async () => ({ ok: true, models: ['m1', 'm2'] })),
    logs: vi.fn(async () => ({ ok: true, logs: [] })),
    clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
    ...overrides,
  }
  window.electronAPI = { relay: bridge }
  return bridge
}

describe('relayStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    readRelay.mockResolvedValue({ port: 8787, providers: [] })
    saveRelay.mockImplementation(async (config) => config)
  })

  it('loads persisted config', async () => {
    readRelay.mockResolvedValue({
      port: 9000,
      providers: [{ id: 'p1', name: 'A', baseUrl: 'https://a', models: ['m'], enabled: true }],
    })
    mountBridge()
    const store = useRelayStore()

    await store.load()

    expect(store.port).toBe(9000)
    expect(store.providers).toHaveLength(1)
    expect(store.initialized).toBe(true)
  })

  it('adds a provider with a generated id and persists', async () => {
    mountBridge()
    const store = useRelayStore()

    const provider = await store.addProvider({
      name: '商汤',
      baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
      apiKey: 'sk-1',
      models: ['SenseChat-5'],
    })

    expect(provider.id).toMatch(/^p_/)
    expect(store.providers).toHaveLength(1)
    expect(saveRelay).toHaveBeenCalled()
    expect(useToastStore().toasts.at(-1).type).toBe('success')
  })

  it('keeps every api key and mirrors the first one', async () => {
    mountBridge()
    const store = useRelayStore()

    const provider = await store.addProvider({
      name: 'A',
      baseUrl: 'https://a',
      apiKeys: [' sk-1 ', 'sk-2', '', 'sk-1'],
    })

    expect(provider.apiKeys).toEqual(['sk-1', 'sk-2'])
    expect(provider.apiKey).toBe('sk-1')
    expect(store.providers[0].apiKeys).toEqual(['sk-1', 'sk-2'])
  })

  it('syncs apiKey when apiKeys are updated', async () => {
    mountBridge()
    const store = useRelayStore()
    const provider = await store.addProvider({ name: 'A', baseUrl: 'https://a', apiKey: 'old' })

    await store.updateProvider(provider.id, { apiKeys: ['new-1', 'new-2'] })

    expect(store.providers[0].apiKeys).toEqual(['new-1', 'new-2'])
    expect(store.providers[0].apiKey).toBe('new-1')
  })

  it('passes plain data to IPC so the config stays cloneable', async () => {
    const bridge = mountBridge()
    const store = useRelayStore()
    await store.addProvider({ name: 'A', baseUrl: 'https://a', apiKeys: ['k1'] })

    await store.start()

    const payload = bridge.start.mock.calls[0][0]
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload.providers[0].name).toBe('A')
    expect(payload.providers[0].apiKeys).toEqual(['k1'])
  })

  it('generates and clears the local access key', async () => {
    mountBridge()
    const store = useRelayStore()

    const key = await store.generateApiKey()
    expect(key).toMatch(/^sk-relay-[0-9a-f]+$/)
    expect(store.apiKey).toBe(key)
    expect(saveRelay).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: key }))

    await store.clearApiKey()
    expect(store.apiKey).toBe('')
  })

  it('persists cache and auto start settings', async () => {
    mountBridge()
    const store = useRelayStore()

    await store.setCacheEnabled(true)
    await store.setCacheTtlMinutes(10)
    await store.setAutoStart(false)

    expect(store.cacheEnabled).toBe(true)
    expect(store.cacheTtlMinutes).toBe(10)
    expect(store.autoStart).toBe(false)
    expect(saveRelay).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cache: { enabled: true, ttlMs: 600000 },
        autoStart: false,
      }),
    )
  })

  it('toggles a provider on and off', async () => {
    mountBridge()
    const store = useRelayStore()
    const provider = await store.addProvider({ name: 'A', baseUrl: 'https://a' })

    await store.toggleProvider(provider.id)
    expect(store.providers[0].enabled).toBe(false)

    await store.toggleProvider(provider.id)
    expect(store.providers[0].enabled).toBe(true)
  })

  it('removes a provider', async () => {
    mountBridge()
    const store = useRelayStore()
    const provider = await store.addProvider({ name: 'A', baseUrl: 'https://a' })

    await store.removeProvider(provider.id)

    expect(store.providers).toHaveLength(0)
  })

  it('loads client keys and the sticky flag', async () => {
    readRelay.mockResolvedValue({
      port: 8787,
      providers: [],
      clientKeys: [{ key: 'sk-a', label: '工具A' }],
      sticky: true,
    })
    mountBridge()
    const store = useRelayStore()

    await store.load()

    expect(store.clientKeys).toEqual([{ key: 'sk-a', label: '工具A' }])
    expect(store.sticky).toBe(true)
  })

  it('attaches preset quota to legacy providers on load', async () => {
    readRelay.mockResolvedValue({
      port: 8787,
      providers: [
        {
          id: 'p1',
          name: '商汤日日新',
          baseUrl: 'https://token.sensenova.cn/v1',
          presetId: 'sensenova',
          models: ['deepseek-v4-flash'],
          enabled: true,
        },
      ],
    })
    mountBridge()
    const store = useRelayStore()

    await store.load()

    expect(store.providers[0].quota).toMatchObject({
      enabled: true,
      metric: 'request',
      limit5h: 1500,
      limitWeek: 15000,
    })
    expect(store.providers[0].models).toEqual(['deepseek-v4-flash'])
  })

  it('normalizes quota when adding a provider', async () => {
    mountBridge()
    const store = useRelayStore()

    const provider = await store.addProvider({
      name: '端砚',
      baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
      quota: {
        enabled: true,
        metric: 'credit',
        limit5h: 10,
        limitWeek: 50,
        creditsPerMillionTokens: 4,
        confirmStrikes: 3,
        confirmIntervalMinutes: 1,
      },
    })

    expect(provider.quota).toEqual({
      enabled: true,
      metric: 'credit',
      limit5h: 10,
      limitWeek: 50,
      creditsPerMillionTokens: 4,
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
    })
  })

  it('adds / renames / removes client keys', async () => {
    mountBridge()
    const store = useRelayStore()

    const item = await store.addClientKey('工具A')
    expect(item.key).toMatch(/^sk-relay-/)
    expect(store.clientKeys).toHaveLength(1)
    expect(store.clientKeys[0].label).toBe('工具A')

    await store.addClientKey('')
    expect(store.clientKeys[1].label).toBe('客户端2')

    await store.renameClientKey(0, '改了')
    expect(store.clientKeys[0].label).toBe('改了')

    await store.removeClientKey(0)
    expect(store.clientKeys).toHaveLength(1)
    expect(saveRelay).toHaveBeenCalled()
  })

  it('persists sticky and pushes it to a running relay', async () => {
    const bridge = mountBridge()
    const store = useRelayStore()

    await store.setSticky(true)
    expect(store.sticky).toBe(true)
    expect(bridge.update).not.toHaveBeenCalled()

    store.running = true
    await store.setSticky(false)
    expect(bridge.update).toHaveBeenCalledWith(expect.objectContaining({ sticky: false }))
  })

  it('starts and stops the relay', async () => {
    const bridge = mountBridge()
    const store = useRelayStore()
    await store.addProvider({ name: 'A', baseUrl: 'https://a', models: ['m'] })

    await store.start()
    expect(bridge.start).toHaveBeenCalledWith({
      port: 8787,
      apiKey: '',
      clientKeys: [],
      sticky: false,
      cache: { enabled: false, ttlMs: 300000 },
      providers: store.providers,
    })
    expect(store.running).toBe(true)
    expect(store.baseUrl).toContain('/v1')

    await store.stop()
    expect(store.running).toBe(false)
  })

  it('surfaces a start failure', async () => {
    mountBridge({ start: vi.fn(async () => ({ ok: false, error: '端口 8787 已被占用' })) })
    const store = useRelayStore()

    const ok = await store.start()

    expect(ok).toBe(false)
    expect(store.running).toBe(false)
    expect(useToastStore().toasts.at(-1).message).toContain('已被占用')
  })

  it('pushes config to the running server after edits', async () => {
    const bridge = mountBridge()
    const store = useRelayStore()
    await store.start()
    expect(bridge.update).not.toHaveBeenCalled()

    await store.addProvider({ name: 'A', baseUrl: 'https://a' })

    expect(bridge.update).toHaveBeenCalled()
  })

  it('fills models from the upstream', async () => {
    mountBridge()
    const store = useRelayStore()
    const provider = await store.addProvider({ name: 'A', baseUrl: 'https://a' })

    await store.fetchModels(provider.id)

    expect(store.providers[0].models).toEqual(['m1', 'm2'])
    expect(store.busyProviderId).toBeNull()
  })

  it('reports a failed model fetch without clobbering existing models', async () => {
    mountBridge({ fetchModels: vi.fn(async () => ({ ok: false, error: 'HTTP 401' })) })
    const store = useRelayStore()
    const provider = await store.addProvider({ name: 'A', baseUrl: 'https://a', models: ['old'] })

    await store.fetchModels(provider.id)

    expect(store.providers[0].models).toEqual(['old'])
    expect(useToastStore().toasts.at(-1).message).toContain('401')
  })

  it('validates the port', async () => {
    mountBridge()
    const store = useRelayStore()

    await store.setPort(80)
    expect(store.port).toBe(8787)
    expect(useToastStore().toasts.at(-1).type).toBe('warning')

    await store.setPort(9001)
    expect(store.port).toBe(9001)
  })
})

describe('relayStore 顺序与日志', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    readRelay.mockResolvedValue({ port: 8787, providers: [] })
    saveRelay.mockImplementation(async (config) => config)
  })

  it('moves a provider up and down (order = failover priority)', async () => {
    mountBridge()
    const store = useRelayStore()
    const a = await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await store.addProvider({ name: 'B', baseUrl: 'https://b' })

    await store.moveProvider(a.id, 1)
    expect(store.providers.map((p) => p.name)).toEqual(['B', 'A'])

    await store.moveProvider(a.id, -1)
    expect(store.providers.map((p) => p.name)).toEqual(['A', 'B'])
  })

  it('ignores moves beyond the list bounds', async () => {
    mountBridge()
    const store = useRelayStore()
    const a = await store.addProvider({ name: 'A', baseUrl: 'https://a' })

    await store.moveProvider(a.id, -1)
    expect(store.providers.map((p) => p.name)).toEqual(['A'])
  })

  it('loads and clears call stats', async () => {
    const stat = { id: 'p::m', provider: 'A', model: 'm', total: 2, success: 1 }
    mountBridge({
      stats: vi.fn(async () => ({ ok: true, stats: [stat] })),
      clearStats: vi.fn(async () => ({ ok: true, stats: [] })),
    })
    const store = useRelayStore()

    await store.loadStats()
    expect(store.stats).toEqual([stat])

    await store.clearStats()
    expect(store.stats).toEqual([])
    expect(useToastStore().toasts.at(-1).message).toContain('已清空')
  })

  it('loads and clears request logs', async () => {
    const entry = { id: 'l1', model: 'm', provider: 'A', status: 200, ms: 12 }
    mountBridge({ logs: vi.fn(async () => ({ ok: true, logs: [entry] })) })
    const store = useRelayStore()

    await store.loadLogs()
    expect(store.logs).toEqual([entry])

    await store.clearLogs()
    expect(store.logs).toEqual([])
  })
})

describe('relayStore 限流配置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    readRelay.mockResolvedValue({ port: 8787, providers: [] })
    saveRelay.mockImplementation(async (config) => config)
  })

  it('defaults to 4 concurrent and no rpm cap', async () => {
    mountBridge()
    const store = useRelayStore()

    const provider = await store.addProvider({ name: 'A', baseUrl: 'https://a' })

    expect(provider.maxConcurrency).toBe(4)
    expect(provider.rpmLimit).toBe(0)
  })

  it('keeps explicit limits', async () => {
    mountBridge()
    const store = useRelayStore()

    const provider = await store.addProvider({
      name: 'A',
      baseUrl: 'https://a',
      maxConcurrency: 2,
      rpmLimit: 60,
    })

    expect(provider.maxConcurrency).toBe(2)
    expect(provider.rpmLimit).toBe(60)
  })
})
