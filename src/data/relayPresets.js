// 中转站内置供应商模板：从统一注册表派生，字段与旧版保持一致。
// 新增供应商请改 src/data/providers.json，不要在这里追加数组项。

import { listRelayPresets } from '../core/providers/registry.js'

export const RELAY_PRESETS = listRelayPresets()

export function findPreset(id) {
  return RELAY_PRESETS.find((preset) => preset.id === id) || null
}

export function createProviderFromPreset(presetId, apiKey = '') {
  const preset = findPreset(presetId)
  if (!preset) return null
  return {
    name: preset.name,
    baseUrl: preset.baseUrl,
    models: [...preset.models],
    apiKey,
    enabled: true,
    presetId: preset.id,
  }
}
