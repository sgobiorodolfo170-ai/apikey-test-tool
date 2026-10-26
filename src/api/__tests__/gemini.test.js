import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  normalizeGeminiBaseUrl,
  testGeminiConnection,
  listGeminiModels,
  testGeminiModelLatency,
  testGeminiModels,
  sendGeminiChat,
  extractGeminiText,
} from '../gemini.js'

const mockConfig = {
  apiKey: 'gemini-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
}

function apiKeyError() {
  return {
    response: {
      status: 400,
      data: {
        error: {
          message: 'API key not valid. Please pass a valid API key.',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      },
    },
  }
}

describe('gemini api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('normalizeGeminiBaseUrl', () => {
    it('should append /v1beta by default', () => {
      expect(normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com')).toBe(
        'https://generativelanguage.googleapis.com/v1beta',
      )
    })

    it('should keep an explicit version path', () => {
      expect(normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta/')).toBe(
        'https://generativelanguage.googleapis.com/v1beta',
      )
    })
  })

  describe('testGeminiConnection', () => {
    it('should return connected on success', async () => {
      axios.post.mockResolvedValueOnce({
        data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
      })
      const result = await testGeminiConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toContain('gemini-2.0-flash')
      expect(axios.post.mock.calls[0][2].headers['x-goog-api-key']).toBe('gemini-key')
    })

    it('should mark invalid api key as not connected', async () => {
      axios.post.mockRejectedValue(apiKeyError())
      const result = await testGeminiConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toContain('API Key')
    })

    it('should try fallback models on 404', async () => {
      axios.post
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: { candidates: [] } })
      const result = await testGeminiConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toContain('gemini-1.5-flash')
    })

    it('should handle abort gracefully', async () => {
      axios.post.mockRejectedValue({ name: 'CanceledError' })
      const result = await testGeminiConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.error).toBe('请求已取消')
    })
  })

  describe('listGeminiModels', () => {
    it('should strip the models/ prefix and keep generateContent models', async () => {
      axios.get.mockResolvedValueOnce({
        data: {
          models: [
            {
              name: 'models/gemini-2.0-flash',
              displayName: 'Gemini 2.0 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/text-embedding-004',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        },
      })
      const result = await listGeminiModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['gemini-2.0-flash'])
    })

    it('should report 401 reason', async () => {
      axios.get.mockRejectedValue({ response: { status: 401 } })
      const result = await listGeminiModels(mockConfig)
      expect(result.success).toBe(false)
      expect(result.error).toContain('401')
    })
  })

  describe('testGeminiModelLatency', () => {
    it('should return success with latency', async () => {
      axios.post.mockResolvedValueOnce({ data: { candidates: [] } })
      const result = await testGeminiModelLatency(mockConfig, 'models/gemini-2.0-flash')
      expect(result.status).toBe('success')
      expect(result.model).toBe('gemini-2.0-flash')
    })

    it('should fail on unknown model', async () => {
      axios.post.mockRejectedValue({ response: { status: 404 } })
      const result = await testGeminiModelLatency(mockConfig, 'gemini-nope')
      expect(result.status).toBe('failed')
      expect(result.error).toContain('不存在')
    })

    it('should fail on invalid key', async () => {
      axios.post.mockRejectedValue(apiKeyError())
      const result = await testGeminiModelLatency(mockConfig, 'gemini-2.0-flash')
      expect(result.status).toBe('failed')
      expect(result.error).toBe('API Key无效')
    })
  })

  describe('testGeminiModels', () => {
    it('should test models in batches', async () => {
      axios.post.mockResolvedValue({ data: { candidates: [] } })
      const results = await testGeminiModels(mockConfig, ['a', 'b'], 5)
      expect(results).toHaveLength(2)
    })
  })

  describe('extractGeminiText', () => {
    it('should join candidate parts', () => {
      expect(
        extractGeminiText({
          candidates: [{ content: { parts: [{ text: 'foo' }, { text: 'bar' }] } }],
        }),
      ).toBe('foobar')
    })

    it('should fall back to placeholder', () => {
      expect(extractGeminiText({})).toBe('无响应')
    })
  })

  describe('sendGeminiChat', () => {
    it('should map assistant role to model and keep systemInstruction', async () => {
      axios.post.mockResolvedValueOnce({
        data: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      })
      const text = await sendGeminiChat(mockConfig, {
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: 'be nice' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      })
      expect(text).toBe('hi')
      const body = axios.post.mock.calls[0][1]
      expect(body.contents[0].role).toBe('user')
      expect(body.contents[1].role).toBe('model')
      expect(body.systemInstruction.parts[0].text).toBe('be nice')
    })
  })
})
