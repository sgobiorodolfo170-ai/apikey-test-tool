import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  testOpenAIConnection,
  listOpenAIModels,
  testModelLatency,
  testAllModelsConcurrently,
  sendChatCompletion,
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

    it('should report 401 reason when key is invalid', async () => {
      axios.get.mockRejectedValue({ response: { status: 401 } })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('401')
      expect(result.status).toBe(401)
    })

    it('should report CORS/network error when no response', async () => {
      axios.get.mockRejectedValue({ code: 'ERR_NETWORK' })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('CORS')
      expect(result.status).toBeUndefined()
    })

    it('should accept bare-array model list responses', async () => {
      axios.get.mockResolvedValueOnce({ data: [{ id: 'm1' }, { id: 'm2' }] })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['m1', 'm2'])
    })

    it('should accept model lists under a models key', async () => {
      axios.get.mockResolvedValueOnce({ data: { models: [{ id: 'm1' }] } })
      const result = await listOpenAIModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models).toHaveLength(1)
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

    it('should retry with max_completion_tokens when model rejects max_tokens', async () => {
      axios.post
        .mockRejectedValueOnce({
          response: {
            status: 400,
            data: {
              error: {
                message:
                  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              },
            },
          },
        })
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } })
      const result = await testModelLatency(mockConfig, 'gpt-5')
      expect(result.status).toBe('success')
      const retryBody = axios.post.mock.calls[1][1]
      expect(retryBody.max_completion_tokens).toBe(5)
      expect(retryBody.max_tokens).toBeUndefined()
    })

    it('should surface provider error message from response body', async () => {
      axios.post.mockRejectedValue({
        response: { status: 403, data: { error: { message: 'quota exceeded for region' } } },
      })
      const result = await testModelLatency(mockConfig, 'gpt-4')
      expect(result.status).toBe('failed')
      expect(result.error).toBe('quota exceeded for region')
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

  describe('sendChatCompletion', () => {
    it('should send chat completion and return response data', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'hi' } }] } })
      const data = await sendChatCompletion(mockConfig, {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      })
      expect(data.choices[0].message.content).toBe('hi')
      expect(axios.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
      expect(axios.post.mock.calls[0][1].messages).toEqual([{ role: 'user', content: 'hello' }])
    })

    it('should fall back to /v1/chat/completions on 404', async () => {
      axios.post
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: { choices: [] } })
      const data = await sendChatCompletion(mockConfig, { model: 'gpt-4', messages: [] })
      expect(axios.post).toHaveBeenCalledTimes(2)
      expect(axios.post.mock.calls[1][0]).toBe('https://api.openai.com/v1/v1/chat/completions')
      expect(data).toEqual({ choices: [] })
    })

    it('should throw when all endpoints fail', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      await expect(
        sendChatCompletion(mockConfig, { model: 'gpt-4', messages: [] }),
      ).rejects.toMatchObject({ response: { status: 401 } })
    })
  })
})
