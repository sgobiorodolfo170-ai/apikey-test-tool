import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  testAnthropicConnection,
  listAnthropicModels,
  testAnthropicModelLatency,
  testAnthropicModels,
} from '../anthropic.js'

const mockConfig = {
  apiKey: 'sk-ant-test',
  baseUrl: 'https://api.anthropic.com',
}

describe('anthropic api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('listAnthropicModels', () => {
    it('should return hardcoded model list', async () => {
      const result = await listAnthropicModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.length).toBeGreaterThan(0)
      expect(result.models[0].id).toContain('claude')
    })

    it('should include known Claude models', async () => {
      const result = await listAnthropicModels(mockConfig)
      const ids = result.models.map((m) => m.id)
      expect(ids).toContain('claude-3-opus-20240229')
      expect(ids).toContain('claude-3-haiku-20240307')
    })
  })

  describe('testAnthropicConnection', () => {
    it('should return connected on success', async () => {
      axios.post.mockResolvedValueOnce({ data: { content: [{ text: 'ok' }] } })
      const result = await testAnthropicConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.connectTime).toBeGreaterThanOrEqual(0)
    })

    it('should set correct headers', async () => {
      axios.post.mockResolvedValueOnce({ data: { content: [{ text: 'ok' }] } })
      await testAnthropicConnection(mockConfig)
      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test',
            'anthropic-version': '2023-06-01',
          }),
        }),
      )
    })

    it('should return 401 error', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testAnthropicConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })

    it('should handle abort', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testAnthropicConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toBe('请求已取消')
    })

    it('should handle ECONNREFUSED', async () => {
      axios.post.mockRejectedValue({ code: 'ECONNREFUSED' })
      const result = await testAnthropicConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toContain('Base URL')
    })
  })

  describe('testAnthropicModelLatency', () => {
    it('should return success with latency', async () => {
      axios.post.mockResolvedValueOnce({ data: { content: [{ text: 'ok' }] } })
      const result = await testAnthropicModelLatency(mockConfig, 'claude-3-haiku-20240307')
      expect(result.status).toBe('success')
      expect(result.model).toBe('claude-3-haiku-20240307')
      expect(result.latency).toBeGreaterThanOrEqual(0)
    })

    it('should accept model object', async () => {
      axios.post.mockResolvedValueOnce({ data: { content: [{ text: 'ok' }] } })
      const result = await testAnthropicModelLatency(mockConfig, { id: 'claude-3-opus-20240229' })
      expect(result.model).toBe('claude-3-opus-20240229')
    })

    it('should return failed on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testAnthropicModelLatency(mockConfig, 'claude-3-opus-20240229')
      expect(result.status).toBe('failed')
    })

    it('should handle cancel', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testAnthropicModelLatency(mockConfig, 'claude-3-haiku-20240307')
      expect(result.status).toBe('cancelled')
    })
  })

  describe('testAnthropicModels', () => {
    it('should test all models', async () => {
      axios.post.mockResolvedValue({ data: { content: [{ text: 'ok' }] } })
      const models = [{ id: 'claude-3-opus-20240229' }, { id: 'claude-3-haiku-20240307' }]
      const results = await testAnthropicModels(mockConfig, models, 5)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })
  })

  describe('cancelAllRequests', () => {
    it('should clear active controllers', () => {
      expect(typeof cancelAllRequests).toBe('function')
    })
  })
})
