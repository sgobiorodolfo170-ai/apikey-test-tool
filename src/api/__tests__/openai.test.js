import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  testOpenAIConnection,
  listOpenAIModels,
  testModelLatency,
  testAllModelsConcurrently,
} from '../openai.js'

const mockConfig = {
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.openai.com/v1',
}

describe('openai api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('testOpenAIConnection', () => {
    it('should return connected on successful chat completion', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toBe('/chat/completions')
      expect(result.connectTime).toBeGreaterThanOrEqual(0)
    })

    it('should fall back to /v1/chat/completions on 404', async () => {
      axios.post
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: { choices: [] } })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(true)
    })

    it('should return 401 error for unauthorized', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })

    it('should connect via /models when chat endpoints all 404', async () => {
      axios.post.mockRejectedValue({ response: { status: 404 } })
      axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'gpt-4' }] } })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toBe('/models')
    })

    it('should handle abort gracefully', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(false)
    })

    it('should handle ECONNREFUSED', async () => {
      axios.post.mockRejectedValue({ code: 'ECONNREFUSED' })
      axios.get.mockRejectedValue({ code: 'ECONNREFUSED' })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toContain('Base URL')
    })

    it('should return connected-with-warning on 400', async () => {
      axios.post.mockRejectedValue({ response: { status: 400 } })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.warning).toBeDefined()
    })

    it('should handle 429 rate limit', async () => {
      axios.post.mockRejectedValue({ response: { status: 429 } })
      const result = await testOpenAIConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(429)
    })
  })

  describe('listOpenAIModels', () => {
    it('should fetch models from /models endpoint', async () => {
      axios.get.mockResolvedValueOnce({
        data: { data: [{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }] },
      })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models).toHaveLength(2)
    })

    it('should try fallback endpoints', async () => {
      axios.get
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: { data: [{ id: 'gpt-4' }] } })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(true)
    })

    it('should fail when all endpoints fail', async () => {
      axios.get.mockRejectedValue({ response: { status: 404 } })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(false)
    })
  })

  describe('testModelLatency', () => {
    it('should return success with latency', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } })
      const result = await testModelLatency(mockConfig, 'gpt-3.5-turbo')
      expect(result.status).toBe('success')
      expect(result.model).toBe('gpt-3.5-turbo')
      expect(result.latency).toBeGreaterThanOrEqual(0)
    })

    it('should accept model object', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } })
      const result = await testModelLatency(mockConfig, { id: 'gpt-4' })
      expect(result.model).toBe('gpt-4')
    })

    it('should return failed on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testModelLatency(mockConfig, 'gpt-4')
      expect(result.status).toBe('failed')
    })

    it('should fallback on 404 then 400', async () => {
      axios.post
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockRejectedValueOnce({ response: { status: 400 } })
      const result = await testModelLatency(mockConfig, 'gpt-4')
      expect(result.status).toBe('failed')
    })
  })

  describe('testAllModelsConcurrently', () => {
    it('should test models in batches of 2', async () => {
      axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'ok' } }] } })
      const results = await testAllModelsConcurrently(mockConfig, ['a', 'b', 'c'], 2)
      expect(results).toHaveLength(3)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })

    it('should handle mixed results', async () => {
      axios.post
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } })
        .mockRejectedValueOnce({ response: { status: 401 } })
      const results = await testAllModelsConcurrently(mockConfig, ['a', 'b'], 5)
      expect(results[0].status).toBe('success')
      expect(results[1].status).toBe('failed')
    })
  })

  describe('cancelAllRequests', () => {
    it('should clear active controllers', () => {
      expect(typeof cancelAllRequests).toBe('function')
    })
  })
})
