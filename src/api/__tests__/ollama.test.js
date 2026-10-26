import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  normalizeOllamaBaseUrl,
  testOllamaConnection,
  listOllamaModels,
  testOllamaModelLatency,
  testOllamaModels,
  sendOllamaChat,
} from '../ollama.js'

const mockConfig = {
  apiKey: '',
  baseUrl: 'http://localhost:11434',
}

describe('ollama api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('normalizeOllamaBaseUrl', () => {
    it('should strip trailing slashes', () => {
      expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434')
    })

    it('should strip a trailing /api suffix', () => {
      expect(normalizeOllamaBaseUrl('http://localhost:11434/api')).toBe('http://localhost:11434')
    })
  })

  describe('testOllamaConnection', () => {
    it('should return connected on /api/tags', async () => {
      axios.get.mockResolvedValueOnce({ data: { models: [] } })
      const result = await testOllamaConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(axios.get.mock.calls[0][0]).toBe('http://localhost:11434/api/tags')
    })

    it('should report refused connection', async () => {
      axios.get.mockRejectedValue({ code: 'ECONNREFUSED' })
      const result = await testOllamaConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toContain('Base URL')
    })

    it('should handle abort gracefully', async () => {
      axios.get.mockRejectedValue({ name: 'CanceledError' })
      const result = await testOllamaConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toBe('请求已取消')
    })
  })

  describe('listOllamaModels', () => {
    it('should parse installed models', async () => {
      axios.get.mockResolvedValueOnce({
        data: { models: [{ name: 'llama3:latest' }, { model: 'qwen2:7b' }] },
      })
      const result = await listOllamaModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['llama3:latest', 'qwen2:7b'])
    })

    it('should suggest pulling a model when none installed', async () => {
      axios.get.mockResolvedValueOnce({ data: { models: [] } })
      const result = await listOllamaModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('ollama pull')
    })

    it('should report refused connection', async () => {
      axios.get.mockRejectedValue({ code: 'ECONNREFUSED' })
      const result = await listOllamaModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Base URL')
    })
  })

  describe('testOllamaModelLatency', () => {
    it('should return success with latency', async () => {
      axios.post.mockResolvedValueOnce({ data: { message: { content: 'ok' } } })
      const result = await testOllamaModelLatency(mockConfig, 'llama3:latest')
      expect(result.status).toBe('success')
      expect(result.model).toBe('llama3:latest')
      expect(axios.post.mock.calls[0][1].stream).toBe(false)
    })

    it('should report missing model on 404', async () => {
      axios.post.mockRejectedValue({ response: { status: 404 } })
      const result = await testOllamaModelLatency(mockConfig, 'nope')
      expect(result.status).toBe('failed')
      expect(result.error).toContain('ollama pull')
    })

    it('should handle cancellation', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testOllamaModelLatency(mockConfig, 'llama3')
      expect(result.status).toBe('cancelled')
    })
  })

  describe('testOllamaModels', () => {
    it('should test all models', async () => {
      axios.post.mockResolvedValue({ data: { message: { content: 'ok' } } })
      const results = await testOllamaModels(mockConfig, ['a', 'b'], 5)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })
  })

  describe('sendOllamaChat', () => {
    it('should return assistant text', async () => {
      axios.post.mockResolvedValueOnce({ data: { message: { content: 'hi' } } })
      const text = await sendOllamaChat(mockConfig, {
        model: 'llama3',
        messages: [{ role: 'user', content: 'hello' }],
      })
      expect(text).toBe('hi')
      expect(axios.post.mock.calls[0][0]).toBe('http://localhost:11434/api/chat')
    })
  })
})
