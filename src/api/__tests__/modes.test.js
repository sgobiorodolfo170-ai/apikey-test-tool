import { describe, it, expect } from 'vitest'
import { API_MODES, getApiAdapter, apiModeNeedsKey, apiModeLabel } from '../modes.js'

describe('api modes registry', () => {
  it('should expose all supported modes', () => {
    const values = API_MODES.map((mode) => mode.value)
    expect(values).toEqual([
      'openai',
      'openai-responses',
      'openai-like',
      'openai-image',
      'openai-speech',
      'anthropic',
      'azure-openai',
      'gemini',
      'ollama',
      'jev',
    ])
  })

  it('should resolve a complete adapter for every mode', () => {
    for (const mode of API_MODES) {
      const adapter = getApiAdapter(mode.value)
      expect(typeof adapter.testConnection).toBe('function')
      expect(typeof adapter.listModels).toBe('function')
      expect(typeof adapter.testModelLatency).toBe('function')
      expect(typeof adapter.testModels).toBe('function')
      expect(typeof adapter.chat).toBe('function')
    }
  })

  it('should fall back to the openai adapter for unknown modes', () => {
    expect(getApiAdapter('unknown-mode')).toBe(getApiAdapter('openai'))
  })

  it('should reuse the openai adapter for openai-like', () => {
    expect(getApiAdapter('openai-like')).toBe(getApiAdapter('openai'))
  })

  it('should only skip api key for ollama', () => {
    expect(apiModeNeedsKey('ollama')).toBe(false)
    for (const mode of API_MODES.filter((m) => m.value !== 'ollama')) {
      expect(apiModeNeedsKey(mode.value)).toBe(true)
    }
  })

  it('should return human readable labels', () => {
    expect(apiModeLabel('gemini')).toBe('Google Gemini')
    expect(apiModeLabel('openai-responses')).toBe('OpenAI Responses')
    expect(apiModeLabel('jev')).toBe('Jev (TypeSafe)')
    expect(apiModeLabel('openai-image')).toBe('OpenAI 图片')
    expect(apiModeLabel('openai-speech')).toBe('OpenAI 语音')
    expect(apiModeLabel('missing')).toBe('missing')
  })
})
