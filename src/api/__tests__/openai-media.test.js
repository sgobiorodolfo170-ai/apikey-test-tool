import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

import {
  cancelAllRequests,
  listImageModels,
  testImageConnection,
  testImageModelLatency,
  testImageModels,
  sendImageChat,
  listSpeechModels,
  testSpeechConnection,
  testSpeechModelLatency,
  testSpeechModels,
  sendSpeechChat,
} from '../openai-media.js'

const mockConfig = {
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.openai.com/v1',
}

describe('openai-media api module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cancelAllRequests()
  })

  describe('image models', () => {
    it('should list only the models detected from the provider (no hardcoded additions)', async () => {
      axios.get.mockResolvedValueOnce({
        data: { data: [{ id: 'gpt-image-1' }, { id: 'gpt-4o' }] },
      })
      const result = await listImageModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['gpt-image-1', 'gpt-4o'])
      expect(result.models.some((m) => /imagen|stable-diffusion|dall-e-3/i.test(m.id))).toBe(false)
      expect(axios.get.mock.calls[0][0]).toBe('https://api.openai.com/v1/models')
    })

    it('should test openai generation models via /images/generations', async () => {
      axios.post.mockResolvedValueOnce({ data: { data: [{ b64_json: 'x' }] } })
      const result = await testImageModelLatency(mockConfig, 'gpt-image-1')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/generations')
      expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer sk-test-key')
    })

    it('should test sd models via sdapi/v1/txt2img', async () => {
      axios.post.mockResolvedValueOnce({ data: { images: ['aaaa'] } })
      const result = await testImageModelLatency(mockConfig, 'stable-diffusion-xl-1024-v1-0')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/sdapi/v1/txt2img')
      expect(axios.post.mock.calls[0][1].prompt).toBeTruthy()
    })

    it('should test imagen models via :predict', async () => {
      axios.post.mockResolvedValueOnce({ data: { predictions: [] } })
      const result = await testImageModelLatency(mockConfig, 'imagen-3.0-generate-001')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][0]).toContain('imagen-3.0-generate-001:predict')
      expect(axios.post.mock.calls[0][2].headers['X-Goog-Api-Key']).toBe('sk-test-key')
    })

    it('should test vision models via /chat/completions with an embedded image', async () => {
      axios.post.mockResolvedValueOnce({ data: { choices: [] } })
      const result = await testImageModelLatency(mockConfig, 'gpt-4o-mini')
      expect(result.status).toBe('success')
      const body = axios.post.mock.calls[0][1]
      expect(body.messages[0].content[0].type).toBe('text')
      expect(body.messages[0].content[1].type).toBe('image_url')
    })

    it('should report failed on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testImageModelLatency(mockConfig, 'gpt-4o')
      expect(result.status).toBe('failed')
      expect(result.error).toBe('API Key无效')
    })

    it('should connect via openai image generation first', async () => {
      axios.post.mockResolvedValueOnce({
        data: { data: [{ b64_json: 'x' }] },
        config: { url: 'https://api.openai.com/v1/images/generations' },
      })
      const result = await testImageConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toContain('/images/generations')
    })

    it('should fall back to the next protocol when openai shape is unavailable', async () => {
      axios.post.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({
        data: { images: ['aaaa'] },
        config: { url: 'https://x/sdapi/v1/txt2img' },
      })
      const result = await testImageConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toContain('/sdapi/v1/txt2img')
    })

    it('should report 401 during connection test', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testImageConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })

    it('should test models in batches', async () => {
      axios.post.mockResolvedValue({ data: { data: [{ b64_json: 'x' }] } })
      const results = await testImageModels(mockConfig, ['gpt-image-1', 'gpt-4o'], 2)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.status === 'success')).toBe(true)
    })

    it('should return image url from chat call', async () => {
      axios.post.mockResolvedValueOnce({
        data: { data: [{ url: 'https://img.test/1.png' }] },
        config: { url: 'https://api.openai.com/v1/images/generations' },
      })
      const text = await sendImageChat(mockConfig, {
        model: 'gpt-image-1',
        messages: [{ role: 'user', content: '画一只猫' }],
      })
      expect(text).toContain('https://img.test/1.png')
      expect(axios.post.mock.calls[0][1].prompt).toBe('画一只猫')
    })

    it('should chat via chat/completions for vision models', async () => {
      axios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { content: '这是一张图片' } }] },
      })
      const text = await sendImageChat(mockConfig, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '看到了什么' }],
      })
      expect(text).toBe('这是一张图片')
    })
  })

  describe('speech models', () => {
    it('should list only the models detected from the provider for speech mode', async () => {
      axios.get.mockResolvedValueOnce({
        data: { data: [{ id: 'tts-1' }, { id: 'whisper-1' }] },
      })
      const result = await listSpeechModels(mockConfig)
      expect(result.success).toBe(true)
      expect(result.models.map((m) => m.id)).toEqual(['tts-1', 'whisper-1'])
      expect(result.models.some((m) => /elevenlabs|azure-zh/i.test(m.id))).toBe(false)
    })

    it('should test openai tts via /audio/speech', async () => {
      axios.post.mockResolvedValueOnce({ data: { byteLength: 2048 } })
      const result = await testSpeechModelLatency(mockConfig, 'tts-1')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/speech')
      expect(axios.post.mock.calls[0][1].input).toBeTruthy()
    })

    it('should test elevenlabs via xi-api-key header', async () => {
      axios.post.mockResolvedValueOnce({ data: { byteLength: 1024 } })
      const result = await testSpeechModelLatency(mockConfig, 'elevenlabs-alloy')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/v1/text-to-speech/alloy')
      expect(axios.post.mock.calls[0][2].headers['xi-api-key']).toBe('sk-test-key')
    })

    it('should test azure tts via Ocp-Apim-Subscription-Key', async () => {
      axios.post.mockResolvedValueOnce({ data: { byteLength: 1024 } })
      const result = await testSpeechModelLatency(mockConfig, 'azure-zh-CN-XiaoxiaoNeural')
      expect(result.status).toBe('success')
      expect(axios.post.mock.calls[0][2].headers['Ocp-Apim-Subscription-Key']).toBe('sk-test-key')
      expect(axios.post.mock.calls[0][2].headers['Content-Type']).toBe('application/ssml+xml')
    })

    it('should test whisper via /audio/transcriptions multipart', async () => {
      axios.post.mockResolvedValueOnce({ data: { text: 'ok' } })
      const result = await testSpeechModelLatency(mockConfig, 'whisper-1')
      expect(result.status).toBe('success')
      const call = axios.post.mock.calls[0]
      expect(call[0]).toBe('https://api.openai.com/v1/audio/transcriptions')
      expect(call[1]).toBeInstanceOf(FormData)
      expect(call[2].headers.Authorization).toBe('Bearer sk-test-key')
      expect(call[2].headers['Content-Type']).toBeUndefined()
    })

    it('should report failed on 401', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testSpeechModelLatency(mockConfig, 'tts-1')
      expect(result.status).toBe('failed')
    })

    it('should connect via openai tts first', async () => {
      axios.post.mockResolvedValueOnce({
        data: { byteLength: 1024 },
        config: { url: 'https://api.openai.com/v1/audio/speech' },
      })
      const result = await testSpeechConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toContain('/audio/speech')
    })

    it('should fall back to whisper transcription when other shapes fail', async () => {
      axios.post
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({
          data: { text: 'ok' },
          config: { url: 'https://api.openai.com/v1/audio/transcriptions' },
        })
      const result = await testSpeechConnection(mockConfig)
      expect(result.connected).toBe(true)
      expect(result.usedEndpoint).toContain('/audio/transcriptions')
    })

    it('should report 401 during connection test', async () => {
      axios.post.mockRejectedValue({ response: { status: 401 } })
      const result = await testSpeechConnection(mockConfig)
      expect(result.connected).toBe(false)
      expect(result.status).toBe(401)
    })

    it('should test models in batches', async () => {
      axios.post.mockResolvedValue({ data: { byteLength: 1024 } })
      const results = await testSpeechModels(mockConfig, ['tts-1', 'whisper-1'], 2)
      expect(results).toHaveLength(2)
    })

    it('should synthesize speech from the last user message', async () => {
      axios.post.mockResolvedValueOnce({ data: { byteLength: 4096 } })
      const text = await sendSpeechChat(mockConfig, {
        model: 'tts-1',
        messages: [{ role: 'user', content: '你好' }],
      })
      expect(text).toContain('4KB')
      expect(axios.post.mock.calls[0][1].input).toBe('你好')
    })
  })
})
