import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../api/openai.js', () => ({
  testOpenAIConnection: vi.fn(),
  listOpenAIModels: vi.fn(),
  testAllModelsConcurrently: vi.fn(),
  testModelLatency: vi.fn(),
  sendOpenAIChat: vi.fn(),
  streamOpenAIChat: vi.fn(),
  cancelAllRequests: vi.fn(),
}))

vi.mock('../../api/anthropic.js', () => ({
  testAnthropicConnection: vi.fn(),
  listAnthropicModels: vi.fn(),
  testAnthropicModels: vi.fn(),
  testAnthropicModelLatency: vi.fn(),
  sendAnthropicChat: vi.fn(),
  streamAnthropicChat: vi.fn(),
  cancelAllRequests: vi.fn(),
}))

vi.mock('../../utils/storage.js', () => ({
  saveTestRecord: vi.fn(),
  saveProvider: vi.fn(),
}))

import { useTestStore } from '../testStore.js'
import { testModelLatency, listOpenAIModels } from '../../api/openai.js'
import { testAnthropicModelLatency } from '../../api/anthropic.js'

const mockConfig = {
  provider: 'test-provider',
  baseUrl: 'https://api.openai.com/v1',
  apiMode: 'openai',
  apiKey: 'sk-test-key',
}

describe('testStore.testSingleModel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('should reject empty model without calling api', async () => {
    const store = useTestStore()
    const result = await store.testSingleModel(mockConfig, '   ')
    expect(result.success).toBe(false)
    expect(testModelLatency).not.toHaveBeenCalled()
    expect(testAnthropicModelLatency).not.toHaveBeenCalled()
  })

  it('should test a single model in openai mode', async () => {
    testModelLatency.mockResolvedValueOnce({ model: 'gpt-4', latency: 123, status: 'success' })
    const store = useTestStore()

    const result = await store.testSingleModel(mockConfig, 'gpt-4')

    expect(testModelLatency).toHaveBeenCalledWith(mockConfig, 'gpt-4')
    expect(result.success).toBe(true)
    expect(store.isTesting).toBe(false)
    expect(store.currentResult.connected).toBe(true)
    expect(store.currentResult.testedModel).toBe('gpt-4')
    expect(store.currentResult.connectTime).toBe(123)
    expect(store.currentResult.models).toHaveLength(1)
    expect(store.currentResult.summary).toEqual({ success: 1, failed: 0, avgLatency: 123 })
    expect(store.hasResult).toBe(true)
  })

  it('should route anthropic mode to testAnthropicModelLatency', async () => {
    testAnthropicModelLatency.mockResolvedValueOnce({
      model: 'claude-3-haiku-20240307',
      latency: 88,
      status: 'success',
    })
    const store = useTestStore()

    const result = await store.testSingleModel(
      { ...mockConfig, apiMode: 'anthropic' },
      'claude-3-haiku-20240307',
    )

    expect(testAnthropicModelLatency).toHaveBeenCalled()
    expect(testModelLatency).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(store.currentResult.summary.avgLatency).toBe(88)
  })

  it('should record failure with error details', async () => {
    testModelLatency.mockResolvedValueOnce({
      model: 'gpt-4',
      latency: -1,
      status: 'failed',
      error: 'API Key无效',
    })
    const store = useTestStore()

    const result = await store.testSingleModel(mockConfig, 'gpt-4')

    expect(result.success).toBe(false)
    expect(store.currentResult.connected).toBe(false)
    expect(store.currentResult.testedModel).toBe('gpt-4')
    expect(store.currentResult.error).toBe('API Key无效')
    expect(store.currentResult.summary).toEqual({ success: 0, failed: 1, avgLatency: 0 })
    expect(store.isTesting).toBe(false)
  })

  it('should keep result when api throws', async () => {
    testModelLatency.mockRejectedValueOnce(new Error('网络错误'))
    const store = useTestStore()

    const result = await store.testSingleModel(mockConfig, 'gpt-4')

    expect(result.success).toBe(false)
    expect(store.currentResult.connected).toBe(false)
    expect(store.currentResult.error).toBe('网络错误')
    expect(store.isTesting).toBe(false)
  })
})

describe('testStore.fetchModels', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('should record detection failure reason', async () => {
    listOpenAIModels.mockResolvedValueOnce({
      success: false,
      models: [],
      error: 'API Key无效或未授权 (HTTP 401)',
    })
    const store = useTestStore()

    await store.fetchModels(mockConfig)

    expect(store.availableModels).toEqual([])
    expect(store.modelsError).toBe('API Key无效或未授权 (HTTP 401)')
    expect(store.isFetchingModels).toBe(false)
  })

  it('should clear modelsError on successful detection', async () => {
    listOpenAIModels.mockResolvedValueOnce({ success: true, models: [{ id: 'gpt-4' }] })
    const store = useTestStore()
    store.modelsError = 'old error'

    await store.fetchModels(mockConfig)

    expect(store.modelsError).toBeNull()
    expect(store.availableModels).toEqual(['gpt-4'])
    expect(store.isFetchingModels).toBe(false)
  })

  it('should ignore stale fetch results', async () => {
    const store = useTestStore()
    let resolveSlow
    listOpenAIModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve
        }),
    )
    listOpenAIModels.mockResolvedValueOnce({ success: true, models: [{ id: 'fast-model' }] })

    const slowRequest = store.fetchModels(mockConfig)
    await store.fetchModels(mockConfig)
    resolveSlow({ success: true, models: [{ id: 'slow-model' }] })
    await slowRequest

    expect(store.availableModels).toEqual(['fast-model'])
    expect(store.isFetchingModels).toBe(false)
  })
})
