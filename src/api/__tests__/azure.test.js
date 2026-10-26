import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  normalizeAzureBaseUrl,
  testAzureConnection,
  listAzureModels,
  testAzureModelLatency,
  testAzureModels,
  sendAzureChat,
} from '../azure.js'

const mockConfig = {
  apiKey: 'azure-key',
  baseUrl: 'https://my-resource.openai.azure.com',
}

describe('azure openai api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('normalizeAzureBaseUrl', () => {
    it('should append /openai to the resource endpoint', () => {
      expect(normalizeAzureBaseUrl('https://res.openai.azure.com').base).toBe(
        'https://res.openai.azure.com/openai',
      )
    })

    it('should not duplicate /openai', () => {
      expect(normalizeAzureBaseUrl('https://res.openai.azure.com/openai/').base).toBe(
        'https://res.openai.azure.com/openai',
      )
    })

    it('should extract api-version from the base url', () => {
      const { base, apiVersion } = normalizeAzureBaseUrl(
        'https://res.openai.azure.com/openai?api-version=2023-05-15',
      )
      expect(base).toBe('https://res.openai.azure.com/openai')
      expect(apiVersion).toBe('2023-05-15')
    })

    it('should fall back to the default api version', () => {
      expect(normalizeAzureBaseUrl('https://res.openai.azure.com').apiVersion).toBe('2024-06-01')
    })
  })

  describe('listAzureModels', () => {
    it('should parse deployments from the deployments endpoint', async () => {
      axios.get.mockResolvedValueOnce({
        data: { data: [{ id: 'gpt-4o-deploy' }, { id: 'gpt-4o-mini-deploy' }] },
      })
      const result = await listAzureModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['gpt-4o-deploy', 'gpt-4o-mini-deploy'])
      expect(axios.get.mock.calls[0][0]).toBe(
        'https://my-resource.openai.azure.com/openai/deployments?api-version=2024-06-01',
      )
      expect(axios.get.mock.calls[0][1].headers['api-key']).toBe('azure-key')
    })

    it('should fall back to the models endpoint on 404', async () => {
      axios.get
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: { value: [{ name: 'gpt-4o' }] } })
      const result = await listAzureModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['gpt-4o'])
      expect(axios.get.mock.calls[1][0]).toContain('/models?api-version=')
    })

    it('should report 401 reason', async () => {
      axios.get.mockRejectedValue({ response: { status: 401 } })
      const result = await listAzureModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('401')
      expect(result.status).toBe(401)
    })

    it('should report cancellation', async () => {
      axios.get.mockRejectedValue({ name: 'CanceledError' })
      const result = await listAzureModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toBe('请求已取消')
    })
  })

  describe('testAzureConnection', () => {
    it('should return connected when deployments are listed', async () => {
      axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'deploy-1' }] } })
      const result = await testAzureConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.connectTime).toBeGreaterThanOrEqual(0)
    })

    it('should return failure with reason when listing fails', async () => {
      axios.get.mockRejectedValue({ response: { status: 401 } })
      const result = await testAzureConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })
  })

  describe('testAzureModelLatency', () => {
    it('should call the deployment chat completions endpoint', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } })
      const result = await testAzureModelLatency(mockConfig, 'my-deploy')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][0]).toBe(
        'https://my-resource.openai.azure.com/openai/deployments/my-deploy/chat/completions?api-version=2024-06-01',
      )
      expect(axios.post.mock.calls[0][2].headers['api-key']).toBe('azure-key')
    })

    it('should report missing deployment on 404', async () => {
      axios.post.mockRejectedValue({ response: { status: 404 } })
      const result = await testAzureModelLatency(mockConfig, 'nope')
      expect(result.status).toBe('failed')
      expect(result.error).toContain('nope')
    })

    it('should report invalid key on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testAzureModelLatency(mockConfig, 'deploy')
      expect(result.status).toBe('failed')
    })

    it('should handle cancellation', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testAzureModelLatency(mockConfig, 'deploy')
      expect(result.status).toBe('cancelled')
    })
  })

  describe('testAzureModels', () => {
    it('should test all deployments', async () => {
      axios.post.mockResolvedValue({ data: { choices: [] } })
      const results = await testAzureModels(mockConfig, ['a', 'b'], 5)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })
  })

  describe('sendAzureChat', () => {
    it('should return assistant text', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'hi' } }] } })
      const text = await sendAzureChat(mockConfig, {
        model: 'my-deploy',
        messages: [{ role: 'user', content: 'hello' }],
      })
      expect(text).toBe('hi')
    })
  })
})
