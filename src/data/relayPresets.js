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
    // 积分与 token 无公开换算，这里按官方 FAQ 的「1500 次 / 5 小时」近似，可改成「按积分」并填换算率。
    // 商汤是按模型分别限次的：Flash-Lite 1500 次 / 5h，DeepSeek V4 Flash 150 次 / 5h（周额度为 10 倍），
    // 因此开启 perModel，让低额度模型先被本地拦住，而不是等上游 429 才发现。
    maxConcurrency: 2,
    rpmLimit: 15,
    quota: {
      enabled: true,
      metric: 'request',
      perModel: true,
      limit5h: 1500,
      limitWeek: 15000,
      modelLimits: {
        'sensenova-6.8-flash-lite': { limit5h: 1500, limitWeek: 15000 },
        'deepseek-v4-flash': { limit5h: 150, limitWeek: 1500 },
        'deepseek-flash': { limit5h: 150, limitWeek: 1500 },
      },
      creditsPerMillionTokens: 0,
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
      confirmSpanMinutes: 9,
      // 高频持续 429 默认不额外判定（0 = 关闭），只靠「3 次 + 1 分钟」防误锁
      burstWindowMinutes: 10,
      burstStrikes: 0,
      // 预留 10% 额度给突发与故障转移重试，避免同一时刻把所有 Key 打满
      reserveRatio: 0.1,
      warmupMinutes: 5,
    },
    docs: 'https://platform.sensenova.cn/docs',
    note: 'Base URL / Bearer 鉴权 / 模型 ID 与官方一致；Token Plan 积分制（12 万 / 5h、120 万 / 周，滚动窗口）。默认按模型独立额度：Flash-Lite 1500 次/5h，DeepSeek V4 Flash 150 次/5h，其余模型按 1500 次/5h 兜底。中转站里每把 Key 默认是独立账号；若多把 Key 属于同一账号，请把它们填进同一个「共享额度组」，否则会把总容量算高。',
  },
  {
    id: 'duanyan',
    name: '书生·端砚',
    baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    models: [],
    // 实测（2026-11）：限频按「每 Key × 每模型 50 RPM」的 60 秒滚动窗口，429 不带 Retry-After；
    // 网关约 8 秒攒批一次；余额不足返回 429 quota_exceeded，与分钟限流是两回事。
    // 墨点按自然月结算（每月 10 墨点、月底清零），因此这里用 calendar-month 而不是滚动 5h/7d。
    strategy: 'duanyan',
    maxConcurrency: 8,
    rpmLimit: 50,
    queueTimeoutMs: 30000,
    quota: {
      enabled: true,
      metric: 'credit',
      windowMode: 'calendar-month',
      limitMonth: 10,
      limit5h: 0,
      limitWeek: 0,
      // 墨点是账号共享，不按模型分池；但结算与预扣仍用各模型单价
      perModel: false,
      creditsPerMillionTokens: 8,
      modelRates: {
        'deepseek-v4.1-flash-1017': 4,
        'glm-5.3': 28,
        'minimax-m3': 8.4,
        'deepseek-v4-pro-0813': 13.5,
      },
      confirmStrikes: 3,
      confirmIntervalMinutes: 1,
      confirmSpanMinutes: 9,
      burstWindowMinutes: 10,
      burstStrikes: 0,
      reserveRatio: 0.1,
      warmupMinutes: 5,
    },
    docs: 'https://discovery.intern-ai.org.cn/token-plan/home',
    note: '墨点按自然月发放（每月 10 墨点、月底清零）；限频实测为「每 Key × 每模型 50 RPM」，多 Key 各自计数、可叠加。余额不足会返回 429 quota_exceeded：本地按模型单价预扣，余额不够直接换 Key，不再排队等 8 秒。网关约 8 秒攒批一次，单请求基线延迟因此会有 0.4–8 秒的波动。模型 ID 请用「拉取模型」确认。',
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
