import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initStorage,
  readProviders,
  readProviderSettings,
  saveProvider,
  deleteProvider,
  readHistory,
  writeHistory,
  saveTestRecord,
  saveProviderFromRecord,
  deleteTestRecord,
  clearHistory,
  readChannels,
  saveChannel,
  deleteChannel,
} from '../storage.js'
import {
  setupElectronAPIMock,
  clearElectronAPIMock,
  resetMockStore,
  mockStore,
} from '../../__tests__/setup.js'

// 递归改写对象里的 apiKey，用来模拟主进程的 safeStorage 加解密
function mapApiKeys(node, fn) {
  if (Array.isArray(node)) return node.map((item) => mapApiKeys(item, fn))
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'apiKey' && typeof value === 'string') out[key] = fn(value)
    else out[key] = mapApiKeys(value, fn)
  }
  return out
}

describe('storage', () => {
  beforeEach(() => {
    resetMockStore()
    setupElectronAPIMock()
  })

  describe('initStorage', () => {
    it('should initialize userDataPath from electronAPI', async () => {
      const result = await initStorage()
      expect(result).toBe('/mock/user/data')
    })

    it('should skip initialization when electronAPI is absent', async () => {
      clearElectronAPIMock()
      await initStorage()
      expect(window.electronAPI).toBeUndefined()
    })
  })

  describe('provider CRUD', () => {
    it('should return empty provider list initially', async () => {
      const providers = await readProviders()
      expect(providers).toEqual([])
    })

    it('should save and read a provider', async () => {
      await saveProvider('test-provider', { baseUrl: 'https://api.test.com', apiMode: 'openai' })
      const providers = await readProviders()
      expect(providers).toContain('test-provider')
    })

    it('should read provider settings', async () => {
      const settings = { baseUrl: 'https://api.test.com', apiMode: 'openai' }
      await saveProvider('test-provider', settings)
      const result = await readProviderSettings('test-provider')
      expect(result.baseUrl).toBe('https://api.test.com')
      expect(result.apiMode).toBe('openai')
      expect(result.updatedAt).toBeDefined()
    })

    it('should return null for unknown provider', async () => {
      const result = await readProviderSettings('nonexistent')
      expect(result).toBeNull()
    })

    it('should delete a provider', async () => {
      await saveProvider('test-provider', { baseUrl: 'https://api.test.com', apiMode: 'openai' })
      await deleteProvider('test-provider')
      const providers = await readProviders()
      expect(providers).not.toContain('test-provider')
    })
  })

  describe('history management', () => {
    it('should read empty history', async () => {
      const history = await readHistory()
      expect(history).toEqual([])
    })

    it('should write and read history', async () => {
      const data = [{ id: '1', result: 'ok' }]
      await writeHistory(data)
      const history = await readHistory()
      expect(history).toEqual(data)
    })

    it('should save a test record with generated id and timestamp', async () => {
      const record = {
        config: {
          provider: 'test',
          baseUrl: 'https://api.test.com',
          apiMode: 'openai',
          apiKey: 'sk-test',
        },
        result: { connected: true, connectTime: 100, models: [] },
      }
      const saved = await saveTestRecord(record)
      expect(saved.id).toBeDefined()
      expect(saved.timestamp).toBeDefined()
      expect(saved.config.provider).toBe('test')
    })

    it('should enforce 100 record limit', async () => {
      for (let i = 0; i < 110; i++) {
        await saveTestRecord({
          config: {
            provider: `p${i}`,
            baseUrl: 'https://api.test.com',
            apiMode: 'openai',
            apiKey: 'sk-test',
          },
          result: { connected: true },
        })
      }
      const history = await readHistory()
      expect(history.length).toBeLessThanOrEqual(100)
    })

    it('should delete a record by id', async () => {
      const saved = await saveTestRecord({
        config: {
          provider: 'test',
          baseUrl: 'https://api.test.com',
          apiMode: 'openai',
          apiKey: 'sk-test',
        },
        result: { connected: true },
      })
      const remaining = await deleteTestRecord(saved.id)
      expect(remaining.find((r) => r.id === saved.id)).toBeUndefined()
    })

    it('should clear all history', async () => {
      await saveTestRecord({
        config: {
          provider: 'test',
          baseUrl: 'https://api.test.com',
          apiMode: 'openai',
          apiKey: 'sk-test',
        },
        result: { connected: true },
      })
      await clearHistory()
      const history = await readHistory()
      expect(history).toEqual([])
    })

    it('should save provider from record via saveProviderFromRecord', async () => {
      const record = {
        config: {
          provider: 'from-record',
          baseUrl: 'https://api.test.com',
          apiMode: 'openai',
          apiKey: 'sk-test',
        },
        result: { connected: true },
      }
      await saveProviderFromRecord(record)
      const settings = await readProviderSettings('from-record')
      expect(settings).not.toBeNull()
      expect(settings.baseUrl).toBe('https://api.test.com')
    })
  })

  describe('key protection and concurrency', () => {
    it('should encrypt apiKey before writing and decrypt it on read', async () => {
      window.electronAPI.secureStore = vi.fn(async (op, data) => {
        if (op === 'encrypt') {
          return { ok: true, encrypted: true, data: mapApiKeys(data, (v) => `enc:${btoa(v)}`) }
        }
        return {
          ok: true,
          data: mapApiKeys(data, (v) => (v.startsWith('enc:') ? atob(v.slice(4)) : v)),
        }
      })

      await saveTestRecord({
        config: {
          provider: 'p',
          baseUrl: 'https://api.test.com',
          apiMode: 'openai',
          apiKey: 'sk-secret',
        },
        result: { connected: true },
      })

      const raw = JSON.stringify(mockStore.history)
      expect(raw).not.toContain('sk-secret')
      expect(raw).toContain('enc:')

      const history = await readHistory()
      expect(history[0].config.apiKey).toBe('sk-secret')
    })

    it('should keep plaintext keys readable (backward compatibility)', async () => {
      window.electronAPI.secureStore = vi.fn(async (op, data) => {
        if (op === 'encrypt') {
          return { ok: true, encrypted: true, data: mapApiKeys(data, (v) => `enc:${btoa(v)}`) }
        }
        return {
          ok: true,
          data: mapApiKeys(data, (v) => (v.startsWith('enc:') ? atob(v.slice(4)) : v)),
        }
      })
      mockStore.history = {
        version: 1,
        data: [{ id: 'old', config: { provider: 'legacy', apiKey: 'sk-plain' } }],
      }

      const history = await readHistory()
      expect(history[0].config.apiKey).toBe('sk-plain')
    })

    it('should not lose records when saves run concurrently', async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          saveTestRecord({ config: { provider: `p${i}` }, result: { connected: true } }),
        ),
      )
      const history = await readHistory()
      expect(history).toHaveLength(8)
    })
  })

  describe('error handling', () => {
    it('should handle readFile failure gracefully', async () => {
      window.electronAPI.readFile = async () => ({ success: false, error: 'file not found' })
      const history = await readHistory()
      expect(history).toEqual([])
    })

    it('should surface writeFile failure to the caller', async () => {
      window.electronAPI.writeFile = async () => ({ success: false, error: 'write failed' })
      await expect(
        saveTestRecord({
          config: {
            provider: 'test',
            baseUrl: 'https://api.test.com',
            apiMode: 'openai',
            apiKey: 'sk-test',
          },
          result: { connected: true },
        }),
      ).rejects.toThrow('write failed')
    })

    it('should back up corrupt JSON and fall back to defaults', async () => {
      window.electronAPI.readFile = async () => ({ success: true, data: '{not-json' })
      const history = await readHistory()

      expect(history).toEqual([])
      expect(window.electronAPI.writeFile).toHaveBeenCalled()
      const [backupPath] = window.electronAPI.writeFile.mock.calls[0]
      expect(backupPath).toContain('history.corrupt-')
    })

    it('should reject non-array history payloads instead of crashing', async () => {
      window.electronAPI.readFile = async () => ({
        success: true,
        data: JSON.stringify({ version: 1, data: {} }),
      })
      const history = await readHistory()

      expect(history).toEqual([])
      expect(window.electronAPI.writeFile).toHaveBeenCalled()
    })
  })
})

describe('channels', () => {
  beforeEach(() => {
    setupElectronAPIMock()
    resetMockStore()
  })

  it('creates a channel with id and timestamps', async () => {
    const list = await saveChannel({
      name: '渠道A',
      baseUrl: 'https://a.example.com/v1',
      apiMode: 'openai',
      apiKey: 'sk-a',
    })

    expect(list).toHaveLength(1)
    expect(list[0].id).toBeTruthy()
    expect(list[0].createdAt).toBeTruthy()
    expect(list[0].updatedAt).toBeTruthy()

    const stored = await readChannels()
    expect(stored).toHaveLength(1)
    expect(stored[0].name).toBe('渠道A')
  })

  it('updates an existing channel instead of appending a duplicate', async () => {
    const first = await saveChannel({
      name: '渠道A',
      baseUrl: 'https://a.example.com/v1',
      apiMode: 'openai',
      apiKey: 'sk-a',
    })
    const id = first[0].id

    const second = await saveChannel({
      id,
      name: '渠道A（改名）',
      baseUrl: 'https://a.example.com/v1',
      apiMode: 'openai',
      apiKey: 'sk-a2',
    })

    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(id)
    expect(second[0].name).toBe('渠道A（改名）')
    expect(second[0].apiKey).toBe('sk-a2')
  })

  it('deletes a channel by id', async () => {
    const list = await saveChannel({
      name: '渠道A',
      baseUrl: 'https://a.example.com/v1',
      apiMode: 'openai',
      apiKey: 'sk-a',
    })

    const remaining = await deleteChannel(list[0].id)
    expect(remaining).toHaveLength(0)
    expect(await readChannels()).toHaveLength(0)
  })

  it('encrypts the api key before writing to disk', async () => {
    window.electronAPI.secureStore = vi.fn(async (op, data) => {
      if (op === 'encrypt') {
        return { ok: true, encrypted: true, data: mapApiKeys(data, (v) => `enc:${btoa(v)}`) }
      }
      return {
        ok: true,
        data: mapApiKeys(data, (v) => (v.startsWith('enc:') ? atob(v.slice(4)) : v)),
      }
    })

    await saveChannel({
      name: '渠道A',
      baseUrl: 'https://a.example.com/v1',
      apiMode: 'openai',
      apiKey: 'sk-secret',
    })

    expect(JSON.stringify(mockStore.channels)).not.toContain('sk-secret')
    expect(JSON.stringify(mockStore.channels)).toContain('enc:')

    const stored = await readChannels()
    expect(stored[0].apiKey).toBe('sk-secret')
  })
})
