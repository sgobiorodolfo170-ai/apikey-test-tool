import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  normalizeJevBaseUrl,
  testJevConnection,
  listJevModels,
  testJevModelLatency,
  testJevModels,
  sendJevChat,
} from '../jev.js'

const mockConfig = {
  apiKey: 'jev-key',
  baseUrl: 'https://api.typesafe.ai',
}

describe('jev (typesafe) api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('normalizeJevBaseUrl', () => {
    it('should append /v1 by default', () => {
      expect(normalizeJevBaseUrl('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1')
    })

    it('should keep an explicit version path', () => {
      expect(normalizeJevBaseUrl('https://api.typesafe.ai/v1/')).toBe('https://api.typesafe.ai/v1')
    })
  })

  describe('listJevModels', () => {
    it('should parse model aliases', async () => {
      axios.get.mockResolvedValueOnce({
        data: {
          models: [
            { name: 'jev-latest', description: 'The latest Jev', release_date: '2026-01-01' },
            { name: 'jev-preview', description: 'Preview build', release_date: '2026-01-02' },
          ],
        },
      })
      const result = await listJevModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['jev-latest', 'jev-preview'])
      expect(axios.get.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/models')
      expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer jev-key')
    })

    it('should report 401 reason', async () => {
      axios.get.mockRejectedValue({ response: { status: 401 } })
      const result = await listJevModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('401')
      expect(result.status).toBe(401)
    })

    it('should report cancellation', async () => {
      axios.get.mockRejectedValue({ name: 'CanceledError' })
      const result = await listJevModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toBe('请求已取消')
    })
  })

  describe('testJevConnection', () => {
    it('should return connected on successful systemone call', async () => {
      axios.post.mockResolvedValueOnce({
        data: { model: 'jev-1.13.0', answers: { _connectivity: { type: 'noul', noul: 1.0 } } },
      })
      const result = await testJevConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toBe('/v1/systemone')
      expect(axios.post.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone')
      expect(axios.post.mock.calls[0][1].model).toBe('jev-latest')
      expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer jev-key')
    })

    it('should report 401 error', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testJevConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })

    it('should report rate limit', async () => {
      axios.post.mockRejectedValue({ response: { status: 429 } })
      const result = await testJevConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(429)
    })

    it('should treat 422 as reachable with warning', async () => {
      axios.post.mockRejectedValue({ response: { status: 422 } })
      const result = await testJevConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.warning).toBeDefined()
    })

    it('should handle abort gracefully', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testJevConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toBe('请求已取消')
    })
  })

  describe('testJevModelLatency', () => {
    it('should return success with latency', async () => {
      axios.post.mockResolvedValueOnce({ data: { answers: {} } })
      const result = await testJevModelLatency(mockConfig, 'jev-latest')
      expect(result.status).toBe('success')
      expect(result.model).toBe('jev-latest')
    })

    it('should accept a model object', async () => {
      axios.post.mockResolvedValueOnce({ data: { answers: {} } })
      const result = await testJevModelLatency(mockConfig, { id: 'jev-preview' })
      expect(result.model).toBe('jev-preview')
    })

    it('should fail on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testJevModelLatency(mockConfig, 'jev-latest')
      expect(result.status).toBe('failed')
      expect(result.error).toBe('API Key无效')
    })

    it('should report unknown model on 422', async () => {
      axios.post.mockRejectedValue({ response: { status: 422 } })
      const result = await testJevModelLatency(mockConfig, 'jev-nope')
      expect(result.status).toBe('failed')
      expect(result.error).toContain('不存在或不可用')
    })

    it('should surface provider detail message', async () => {
      axios.post.mockRejectedValue({
        response: { status: 400, data: { detail: 'invalid question' } },
      })
      const result = await testJevModelLatency(mockConfig, 'jev-latest')
      expect(result.status).toBe('failed')
      expect(result.error).toBe('invalid question')
    })
  })

  describe('testJevModels', () => {
    it('should test models in batches', async () => {
      axios.post.mockResolvedValue({ data: { answers: {} } })
      const results = await testJevModels(mockConfig, ['a', 'b'], 5)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })
  })

  describe('sendJevChat', () => {
    it('should evaluate the last user message as state and return a readable judgment', async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          model: 'jev-1.13.0',
          answers: {
            _coherent: { type: 'noul', noul: 0.9 },
            _sentiment: {
              type: 'choice',
              choice: 'negative',
              confidence: 0.85,
            },
          },
        },
      })
      const text = await sendJevChat(mockConfig, {
        model: 'jev-latest',
        messages: [
          { role: 'user', content: 'The integration keeps failing, please help ASAP.' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'I am losing sales.' },
        ],
      })
      expect(text).toContain('Jev 判定结果')
      expect(text).toContain('0.900')
      expect(text).toContain('negative')
      expect(axios.post.mock.calls[0][1].state).toBe('I am losing sales.')
      expect(axios.post.mock.calls[0][1].questions._coherent.type).toBe('noul')
      expect(axios.post.mock.calls[0][1].questions._sentiment.type).toBe('choice')
    })

    it('should propagate API errors', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      await expect(
        sendJevChat(mockConfig, { messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toMatchObject({ response: { status: 401 } })
    })
  })
})
