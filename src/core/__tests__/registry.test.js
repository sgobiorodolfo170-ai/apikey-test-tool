import { describe, it, expect } from 'vitest'
import {
  API_MODES,
  API_MODES_WITHOUT_KEY,
  VISION_CAPABLE_MODES,
  PROVIDERS,
  getProvider,
  listProviders,
  validateDescriptor,
  validateRegistry,
  buildAdapters,
} from '../providers/registry.js'
import { RELAY_PRESETS, findPreset, createProviderFromPreset } from '../../data/relayPresets.js'

describe('provider registry', () => {
  it('exposes api modes in the documented order', () => {
    expect(API_MODES.map((mode) => mode.value)).toEqual([
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
    expect(API_MODES_WITHOUT_KEY).toEqual(['ollama'])
    expect(VISION_CAPABLE_MODES).toContain('anthropic')
    expect(VISION_CAPABLE_MODES).not.toContain('openai-image')
  })

  it('validates every provider descriptor', () => {
    for (const provider of PROVIDERS) {
      const result = validateDescriptor(provider)
      expect(result.errors).toEqual([])
      expect(result.ok).toBe(true)
    }
  })

  it('returns copies so callers cannot mutate the registry', () => {
    const provider = getProvider('sensenova')
    expect(provider).not.toBeNull()
    provider.name = 'mutated'
    provider.models.push('should-not-persist')

    expect(getProvider('sensenova').name).toBe('商汤日日新')
    expect(getProvider('sensenova').models).not.toContain('should-not-persist')
    expect(listProviders()).toHaveLength(PROVIDERS.length)
  })

  it('rejects unknown api modes and duplicate ids', () => {
    const unknown = validateDescriptor({
      id: 'x',
      name: 'X',
      apiMode: 'missing',
      baseUrl: 'https://example.com/v1',
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.errors.join('')).toContain('未知 apiMode')

    const duplicated = validateRegistry({
      providers: [
        { id: 'same', name: 'A', apiMode: 'openai', baseUrl: 'https://a.example/v1' },
        { id: 'same', name: 'B', apiMode: 'openai', baseUrl: 'https://b.example/v1' },
      ],
    })
    expect(duplicated.ok).toBe(false)
    expect(duplicated.errors.join('')).toContain('重复的 provider id')
  })

  it('builds adapters for every declared mode and fails loudly on gaps', () => {
    const implementations = Object.fromEntries(
      API_MODES.map((mode) => [mode.value, { marker: mode.value }]),
    )
    const adapters = buildAdapters(implementations)
    expect(Object.keys(adapters)).toHaveLength(API_MODES.length)

    delete implementations['anthropic']
    expect(() => buildAdapters(implementations)).toThrow('缺少适配器实现')
  })

  it('derives relay presets from the same registry', () => {
    expect(RELAY_PRESETS.map((preset) => preset.id)).toEqual(PROVIDERS.map((item) => item.id))
    expect(findPreset('sensenova')?.baseUrl).toBe('https://token.sensenova.cn/v1')
    expect(findPreset('missing')).toBeNull()

    expect(createProviderFromPreset('openai', 'sk-test')).toEqual({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini'],
      apiKey: 'sk-test',
      enabled: true,
      presetId: 'openai',
    })
    expect(createProviderFromPreset('missing')).toBeNull()
  })

  it('keeps the generated CJS snapshot in sync with the JSON source', async () => {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const snapshot = require('../../../electron/generated/providers.cjs')

    expect(snapshot.version).toBe(1)
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(
      PROVIDERS.map((provider) => provider.id),
    )
    expect(snapshot.apiModes.map((mode) => mode.value)).toEqual(API_MODES.map((mode) => mode.value))
  })
})
