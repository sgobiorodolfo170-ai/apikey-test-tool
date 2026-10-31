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
export function normalizeQuota(input) {
  const limit5h = Math.max(0, Number(input?.limit5h) || 0)
  const limitWeek = Math.max(0, Number(input?.limitWeek) || 0)
  return {
    enabled: input?.enabled === true && (limit5h > 0 || limitWeek > 0),
    metric: input?.metric === 'credit' ? 'credit' : 'request',
    limit5h,
    limitWeek,
    creditsPerMillionTokens: Math.max(0, Number(input?.creditsPerMillionTokens) || 0),
    confirmStrikes: Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0))),
    confirmIntervalMinutes: Math.max(0, Number(input?.confirmIntervalMinutes) || 0),
  }
}
