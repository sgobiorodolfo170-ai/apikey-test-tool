// 渠道横向对比：把历史记录按「渠道」聚合成一行，用于判断哪条该退。
// 纯函数，不依赖 DOM / store，方便单测。

function consistencyScore(checkup) {
  const value = checkup?.consistency
  if (!value) return null
  const agreement = Number(value.agreement) || 0
  const accuracy = Number(value.accuracy) || 0
  return Math.round((agreement + accuracy) / 2)
}

// records 需按时间倒序（historyStore 已是倒序）；同渠道取最近一次，再往前一次算变化
export function buildChannelComparison(records = [], channels = []) {
  const grouped = new Map()

  for (const record of records) {
    const verdict = record?.checkup?.verdict
    if (!verdict) continue
    const key = record.config?.baseUrl || record.id
    if (!key) continue
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(record)
  }

  const rows = []
  for (const [key, list] of grouped) {
    const latest = list[0]
    const previous = list[1]
    const channel = channels.find((item) => item.baseUrl === key)
    const verdict = latest.checkup.verdict

    rows.push({
      key,
      name: channel?.name || latest.config?.provider || key,
      baseUrl: key,
      apiMode: latest.config?.apiMode || channel?.apiMode || '',
      model: latest.checkup.model || '',
      score: verdict.score,
      level: verdict.level,
      color: verdict.color,
      scoreVersion: verdict.scoreVersion ?? 1,
      capability: latest.checkup.capability?.overall ?? null,
      stability: latest.checkup.stability?.successRate ?? null,
      consistency: consistencyScore(latest.checkup),
      checkedAt: latest.timestamp || null,
      delta: previous ? verdict.score - previous.checkup.verdict.score : null,
    })
  }

  return rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'))
}

function formatDate(timestamp) {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function cell(value, suffix = '') {
  return value === null || value === undefined ? '-' : `${value}${suffix}`
}

function deltaText(delta) {
  if (delta === null || delta === undefined) return '-'
  if (delta === 0) return '持平'
  return `${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}`
}

export function toComparisonMarkdown(rows = []) {
  if (rows.length === 0) return ''
  const lines = [
    '| 渠道 | 综合 | 变化 | 能力 | 稳定性 | 一致性 | 最近体检 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]

  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.score} | ${deltaText(row.delta)} | ${cell(
        row.capability,
      )} | ${cell(row.stability, '%')} | ${cell(row.consistency)} | ${formatDate(row.checkedAt)} |`,
    )
  }

  return lines.join('\n')
}

export { formatDate as formatCompareDate, deltaText as formatDelta }
