import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  testResponsesConnection,
  listResponsesModels,
  testResponsesModelLatency,
  testResponsesModels,
  sendResponsesChat,
  extractResponsesText,
} from '../responses.js'

const mockConfig = {
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.openai.com/v1',
}

describe('responses api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('testResponsesConnection', () => {
    it('should return connected on successful response', async () => {
      axios.post.mockResolvedValueOnce({ data: { output_text: 'ok' } })
      const result = await testResponsesConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toBe('/responses')
      expect(result.connectTime).toBeGreaterThanOrEqual(0)
    })

    it('should fall back to /v1/responses on 404', async () => {
      axios.post
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: { output_text: 'ok' } })
      const result = await testResponsesConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toBe('/v1/responses')
    })

    it('should return 401 error for unauthorized', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testResponsesConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })

    it('should return connected-with-warning on 400', async () => {
      axios.post.mockRejectedValue({ response: { status: 400 } })
      const result = await testResponsesConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.warning).toBeDefined()
    })

    it('should handle abort gracefully', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testResponsesConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toBe('请求已取消')
    })

    it('should fail when both endpoints return 404', async () => {
      axios.post.mockRejectedValue({ response: { status: 404 } })
      const result = await testResponsesConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(404)
    })
  })

  describe('listResponsesModels', () => {
    it('should fetch models from /models endpoint', async () => {
      axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'gpt-4o' }] } })
      const result = await listResponsesModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models).toHaveLength(1)
    })
  })

  describe('testResponsesModelLatency', () => {
    it('should return success with latency', async () => {
      axios.post.mockResolvedValueOnce({ data: { output_text: 'ok' } })
      const result = await testResponsesModelLatency(mockConfig, 'gpt-4o')
      expect(result.status).toBe('success')
      expect(result.model).toBe('gpt-4o')
    })

    it('should return failed on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testResponsesModelLatency(mockConfig, 'gpt-4o')
      expect(result.status).toBe('failed')
    })

    it('should fall back on 404 then fail', async () => {
      axios.post.mockRejectedValue({ response: { status: 404 } })
      const result = await testResponsesModelLatency(mockConfig, 'gpt-4o')
      expect(result.status).toBe('failed')
      expect(result.error).toContain('不存在或不支持')
    })

    it('should send max_output_tokens instead of max_tokens', async () => {
      axios.post.mockResolvedValueOnce({ data: { output_text: 'ok' } })
      await testResponsesModelLatency(mockConfig, 'gpt-4o')
      expect(axios.post.mock.calls[0][1].max_output_tokens).toBe(16)
      expect(axios.post.mock.calls[0][1].max_tokens).toBeUndefined()
    })
  })

  describe('testResponsesModels', () => {
    it('should test models in batches', async () => {
      axios.post.mockResolvedValue({ data: { output_text: 'ok' } })
      const results = await testResponsesModels(mockConfig, ['a', 'b', 'c'], 2)
      expect(results).toHaveLength(3)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })
  })

  describe('extractResponsesText', () => {
    it('should prefer output_text', () => {
      expect(extractResponsesText({ output_text: 'hello' })).toBe('hello')
    })

    it('should join output content parts', () => {
      const data = {
        output: [
          { type: 'reasoning', content: [] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'foo' },
              { type: 'output_text', text: 'bar' },
            ],
          },
        ],
      }
      expect(extractResponsesText(data)).toBe('foobar')
    })

    it('should fall back to placeholder', () => {
      expect(extractResponsesText({})).toBe('无响应')
    })
  })

  describe('sendResponsesChat', () => {
    it('should return assistant text', async () => {
      axios.post.mockResolvedValueOnce({ data: { output_text: 'hi there' } })
      const text = await sendResponsesChat(mockConfig, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      })
      expect(text).toBe('hi there')
      expect(axios.post.mock.calls[0][1].input).toEqual([{ role: 'user', content: 'hello' }])
    })
  })
})
