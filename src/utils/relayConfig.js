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

// 自动额度探测：周期性对每把 Key 发最小化真实调用，推断额度与有效性。
// 与 electron/relay.cjs 的 normalizeAutoProbe 保持同口径。
export function normalizeAutoProbe(input) {
  const probe = input && typeof input === 'object' ? input : {}
  const intervalRaw = Number(probe.intervalMinutes)
  return {
    enabled: probe.enabled === true,
    intervalMinutes: intervalRaw > 0 ? Math.min(720, Math.max(1, Math.floor(intervalRaw))) : 30,
    model: typeof probe.model === 'string' ? probe.model.trim() : '',
  }
}

// 自动额度保护：不再按请求次数 / 积分 / 墨点配置额度。
// 只保留真实 429 的确认参数、渐进恢复与共享账号组；
// 5 小时 / 7 天窗口由主进程按真实调用结果自动升级。
// 与 electron/relay.cjs 的 normalizeQuota 保持同口径。
export function normalizeQuota(input) {
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
    enabled: input?.enabled === true,
    confirmStrikes: Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0))),
    confirmIntervalMinutes: Math.max(0, Number(input?.confirmIntervalMinutes) || 0),
    confirmSpanMinutes: Math.max(0, Number(input?.confirmSpanMinutes) || 0),
    burstWindowMinutes: Math.max(0, Number(input?.burstWindowMinutes) || 0),
    burstStrikes: Math.min(100, Math.max(0, Math.floor(Number(input?.burstStrikes) || 0))),
    warmupMinutes: Math.max(0, Number(input?.warmupMinutes) || 0),
    group: typeof input?.group === 'string' ? input.group.trim() : '',
    groups,
    keyGroups,
  }
}
