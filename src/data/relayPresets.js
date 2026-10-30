// 中转站内置提供商模板：只是预填，字段都可改。
// Base URL 以官方文档为准；端砚等平台地址可能调整，建议点「拉取模型」验证是否连通。

export const RELAY_PRESETS = [
  {
    id: 'sensenova',
    name: '商汤日日新',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
    models: ['SenseChat-5', 'SenseNova-V6-Pro'],
    docs: 'https://platform.sensenova.cn/docs',
    note: '兼容模式，需在控制台开通',
  },
  {
    id: 'duanyan',
    name: '书生·端砚',
    baseUrl: 'https://api.intern-ai.org.cn/v1',
    models: [],
    docs: 'https://discovery.intern-ai.org.cn/token-plan/home',
    note: '地址以平台 Token Plan 页为准，建议拉取模型确认',
  },
  {
    id: 'agnes',
    name: 'Agnes AI',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    models: [],
    docs: 'https://agnes-ai.com/zh-Hans/docs/overview',
    note: 'OpenAI 兼容，文本/图像/视频多模态',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini'],
    docs: 'https://platform.openai.com/docs',
    note: '',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    docs: 'https://platform.deepseek.com/api-docs',
    note: '',
  },
  {
    id: 'qwen',
    name: '阿里通义',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus'],
    docs: 'https://help.aliyun.com/zh/model-studio/',
    note: 'DashScope 兼容模式',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus'],
    docs: 'https://open.bigmodel.cn/dev/api',
    note: '',
  },
]

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
