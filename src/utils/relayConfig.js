// 中转站配置归一化：渲染进程（ESM）共用。
// electron/relay.cjs 里有两份等价实现（CJS 侧无法直接 import 本文件），修改时请同步。

// 多客户端 Key：每把 Key 对应一个工具 / 客户端名称，用于日志归因
export function normalizeClientKeys(input) {
  const list = Array.isArray(input) ? input : []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const key = typeof item?.key === 'string' ? item.key.trim() : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    const label = typeof item?.label === 'string' ? item.label.trim() : ''
    result.push({ key, label: label || `客户端${result.length + 1}` })
  }
  return result
}

// 额度窗口：5 小时 / 7 天，按请求次数或积分（墨点）计量
// 与 electron/relay.cjs 的 normalizeQuota 保持同口径
export function normalizeQuota(input) {
  const limit5h = Math.max(0, Number(input?.limit5h) || 0)
  const limitWeek = Math.max(0, Number(input?.limitWeek) || 0)
  // 自然月额度（端砚墨点）：与 5h/7d 互斥
  const windowMode = input?.windowMode === 'calendar-month' ? 'calendar-month' : 'rolling'
  const limitMonth =
    windowMode === 'calendar-month' ? Math.max(0, Number(input?.limitMonth) || 0) : 0

  // 按模型独立额度：模型名 -> { limit5h, limitWeek }
  const modelLimits = {}
  if (input?.modelLimits && typeof input.modelLimits === 'object') {
    for (const [model, value] of Object.entries(input.modelLimits)) {
      const name = typeof model === 'string' ? model.trim() : ''
      if (!name) continue
      const five = Math.max(0, Number(value?.limit5h) || 0)
      const week = Math.max(0, Number(value?.limitWeek) || 0)
      if (five > 0 || week > 0) modelLimits[name] = { limit5h: five, limitWeek: week }
    }
  }

  // 积分制下不同模型可以有不同的 tokens→积分换算率
  const modelRates = {}
  if (input?.modelRates && typeof input.modelRates === 'object') {
    for (const [model, value] of Object.entries(input.modelRates)) {
      const name = typeof model === 'string' ? model.trim() : ''
      const rate = Math.max(0, Number(value) || 0)
      if (name && rate > 0) modelRates[name] = rate
    }
  }

  // 共享组名列表：允许先建组、再往组里添加 Key（空组也要能保存）
  const groups = []
  if (Array.isArray(input?.groups)) {
    for (const item of input.groups) {
      const name = typeof item === 'string' ? item.trim() : ''
      if (name && !groups.includes(name)) groups.push(name)
    }
  }

  // Key 级共享组：明文 Key -> 组名，优先于提供商级默认组
  const keyGroups = {}
  if (input?.keyGroups && typeof input.keyGroups === 'object') {
    for (const [key, value] of Object.entries(input.keyGroups)) {
      const name = typeof key === 'string' ? key.trim() : ''
      const group = typeof value === 'string' ? value.trim() : ''
      if (name && group) keyGroups[name] = group
    }
  }

  return {
    enabled:
      input?.enabled === true &&
      (limit5h > 0 || limitWeek > 0 || limitMonth > 0 || Object.keys(modelLimits).length > 0),
    metric: input?.metric === 'credit' ? 'credit' : 'request',
    windowMode,
    limitMonth,
    limit5h,
    limitWeek,
    creditsPerMillionTokens: Math.max(0, Number(input?.creditsPerMillionTokens) || 0),
    confirmStrikes: Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0))),
    confirmIntervalMinutes: Math.max(0, Number(input?.confirmIntervalMinutes) || 0),
    confirmSpanMinutes: Math.max(0, Number(input?.confirmSpanMinutes) || 0),
    burstWindowMinutes: Math.max(0, Number(input?.burstWindowMinutes) || 0),
    burstStrikes: Math.min(100, Math.max(0, Math.floor(Number(input?.burstStrikes) || 0))),
    reserveRatio: Math.min(0.9, Math.max(0, Number(input?.reserveRatio) || 0)),
    warmupMinutes: Math.max(0, Number(input?.warmupMinutes) || 0),
    perModel: input?.perModel === true,
    group: typeof input?.group === 'string' ? input.group.trim() : '',
    groups,
    keyGroups,
    modelLimits,
    modelRates,
  }
}
