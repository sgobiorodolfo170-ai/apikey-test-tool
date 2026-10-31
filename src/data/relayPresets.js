// 中转站内置提供商模板：只是预填，字段都可改。
// Base URL 以官方文档为准；端砚等平台地址可能调整，建议点「拉取模型」验证是否连通。

export const RELAY_PRESETS = [
  {
    id: 'sensenova',
    name: '商汤日日新',
    baseUrl: 'https://token.sensenova.cn/v1',
    models: [
      'sensenova-6.8-flash-lite',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-flash',
      'glm-5.2',
      'kimi-k3',
    ],
    // Token Plan 公测按积分计（12 万积分 / 滚动 5 小时、120 万 / 滚动周，Flash-Lite 另有独立积分池）；
    // 积分与 token 无公开换算，这里按官方 FAQ 的「1500 次 / 5 小时」近似，可改成「按积分」并填换算率
    quota: {
      enabled: true,
      metric: 'request',
      limit5h: 1500,
      limitWeek: 15000,
      creditsPerMillionTokens: 0,
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
    },
    docs: 'https://platform.sensenova.cn/docs',
    note: 'Base URL / Bearer 鉴权 / 模型 ID 与官方一致；Token Plan 积分制（12 万 / 5h、120 万 / 周，滚动窗口）。中转站里每把 Key 是独立账号，额度按 Key 分别计算；默认按 1500 次/5h 近似，可改成按积分',
  },
  {
    id: 'duanyan',
    name: '书生·端砚',
    baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    models: [],
    rpmLimit: 50,
    // 墨点计划：5 小时最多 10 墨点、7 天最多 50 墨点，所有 Key 共享；这里按 4 墨点/百万 tokens 保守估算
    quota: {
      enabled: true,
      metric: 'credit',
      limit5h: 10,
      limitWeek: 50,
      creditsPerMillionTokens: 4,
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
    },
    docs: 'https://discovery.intern-ai.org.cn/token-plan/home',
    note: '墨点 5h≤10 / 7d≤50；中转站里每把 Key 是独立账号，额度与 50 RPM 都按 Key 分别计算（若同一账号下多 Key 共享，则按官方口径共享）。模型 ID 请用「拉取模型」确认',
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
