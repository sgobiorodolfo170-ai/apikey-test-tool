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

  it('starts and stops the relay', async () => {
    const bridge = mountBridge()
    const store = useRelayStore()
    await store.addProvider({ name: 'A', baseUrl: 'https://a', models: ['m'] })

    await store.start()
    expect(bridge.start).toHaveBeenCalledWith({ port: 8787, providers: store.providers })
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
