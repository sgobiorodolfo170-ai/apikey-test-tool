// 统一供应商注册表：JSON 是唯一事实来源，渲染层与生成脚本都从这里读取。
// 新增一个 OpenAI 兼容供应商只需要改 providers.json，不需要改代码。

import data from '../../data/providers.json'

export const REGISTRY_VERSION = data.version

export const API_MODES = data.apiModes.map(({ value, label }) => ({ value, label }))
export const API_MODES_WITHOUT_KEY = [...data.modesWithoutKey]
export const VISION_CAPABLE_MODES = [...data.visionModes]

const AUTH_TYPES = new Set(['bearer', 'header', 'oauth', 'none'])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateDescriptor(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return { ok: false, errors: ['必须是对象'] }
  }

  const errors = []
  if (!isNonEmptyString(provider.id)) errors.push('缺少 id')
  if (!isNonEmptyString(provider.name)) errors.push('缺少 name')
  if (!isNonEmptyString(provider.baseUrl) || !/^https?:\/\//i.test(provider.baseUrl)) {
    errors.push('baseUrl 必须是 http(s) 地址')
  }
  if (!API_MODES.some((mode) => mode.value === provider.apiMode)) {
    errors.push(`未知 apiMode：${provider.apiMode}`)
  }
  if (provider.models !== undefined && !Array.isArray(provider.models)) {
    errors.push('models 必须是数组')
  }
  if (provider.auth !== undefined && !AUTH_TYPES.has(provider.auth?.type)) {
    errors.push(`auth.type 无效：${provider.auth?.type}`)
  }
  if (provider.capabilities !== undefined && !Array.isArray(provider.capabilities)) {
    errors.push('capabilities 必须是数组')
  }

  return { ok: errors.length === 0, errors }
}

export function validateRegistry(input = data) {
  if (!input || !Array.isArray(input.providers)) {
    return { ok: false, errors: ['providers 必须是数组'] }
  }

  const errors = []
  const ids = new Set()
  for (const provider of input.providers) {
    const result = validateDescriptor(provider)
    if (!result.ok) {
      errors.push(`${provider?.id || '未命名'}：${result.errors.join('；')}`)
    }
    if (ids.has(provider?.id)) {
      errors.push(`重复的 provider id：${provider.id}`)
    }
    ids.add(provider?.id)
  }

  return { ok: errors.length === 0, errors }
}

const validation = validateRegistry(data)
if (!validation.ok) {
  throw new Error(`供应商注册表无效：${validation.errors.join('；')}`)
}

// 只读快照，调用方拿到的是深拷贝，避免组件或 store 修改注册表常量。
export const PROVIDERS = Object.freeze(data.providers.map((provider) => clone(provider)))

export function listProviders() {
  return PROVIDERS.map((provider) => clone(provider))
}

export function getProvider(id) {
  const provider = PROVIDERS.find((item) => item.id === id)
  return provider ? clone(provider) : null
}

export function listRelayPresets() {
  return listProviders()
}

// 协议实现仍然需要代码；这里只校验 JSON 中声明的每个 apiMode 都有实现，
// 防止新增模式后静默回退到 OpenAI。
export function buildAdapters(implementations = {}) {
  const adapters = {}
  for (const mode of API_MODES) {
    const adapter = implementations[mode.value]
    if (!adapter) throw new Error(`API 模式 ${mode.value} 缺少适配器实现`)
    adapters[mode.value] = adapter
  }
  return adapters
}
