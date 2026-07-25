import { describe, it, expect, beforeEach } from 'vitest'
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
} from '../storage.js'
import {
  setupElectronAPIMock,
  clearElectronAPIMock,
  resetMockStore,
} from '../../__tests__/setup.js'

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

  describe('error handling', () => {
    it('should handle readFile failure gracefully', async () => {
      window.electronAPI.readFile = async () => ({ success: false, error: 'file not found' })
      const history = await readHistory()
      expect(history).toEqual([])
    })

    it('should handle writeFile failure gracefully', async () => {
      window.electronAPI.writeFile = async () => ({ success: false, error: 'write failed' })
      const result = await saveTestRecord({
        config: {
          provider: 'test',
          baseUrl: 'https://api.test.com',
          apiMode: 'openai',
          apiKey: 'sk-test',
        },
        result: { connected: true },
      })
      expect(result).toBeDefined()
    })
  })
})
