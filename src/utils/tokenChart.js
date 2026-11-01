// 中转站 token 图表的数据整理：把按日持久化的用量汇总成日 / 周 / 月时间片
// 日期键统一使用本地时间（YYYY-MM-DD），与主进程 relay.cjs 的切日方式保持一致

export const CHART_GRANULARITIES = [
  { id: 'day', label: '日', span: 30 },
  { id: 'week', label: '周', span: 12 },
  { id: 'month', label: '月', span: 12 },
]

// token 总量统一用 M（百万）/ K（千）表示，避免长串数字挤占空间
export function formatTokenAmount(value) {
  const total = Number(value) || 0
  if (total >= 1e9) return `${(total / 1e9).toFixed(1)}B`
  if (total >= 1e6) return `${(total / 1e6).toFixed(1)}M`
  if (total >= 1e3) return `${(total / 1e3).toFixed(1)}K`
  return String(Math.round(total))
}

const WEEK_SLOTS = 12
const MONTH_SLOTS = 12
const DAY_SLOTS = 30

const pad2 = (value) => String(value).padStart(2, '0')

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// 周一为一周起点
export function startOfWeek(date) {
  const day = startOfDay(date)
  const offset = (day.getDay() + 6) % 7
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - offset)
}

export function dateKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function slotKeyOf(date, granularity) {
  if (granularity === 'week') return dateKeyOf(startOfWeek(date))
  if (granularity === 'month') return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
  return dateKeyOf(date)
}

function emptySlot(key, label, start, end) {
  return {
    key,
    label,
    start,
    end,
    total: 0,
    prompt: 0,
    completion: 0,
    calls: 0,
    models: {},
  }
}

// 生成连续的时间片（缺数据的日期补 0），保证曲线与热力块 x 轴对齐
export function createTokenSlots(granularity, now = new Date()) {
  const today = startOfDay(now)
  const slots = []

  if (granularity === 'week') {
    const thisWeek = startOfWeek(today)
    for (let i = WEEK_SLOTS - 1; i >= 0; i--) {
      const start = new Date(
        thisWeek.getFullYear(),
        thisWeek.getMonth(),
        thisWeek.getDate() - i * 7,
      )
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
      slots.push(
        emptySlot(
          dateKeyOf(start),
          `${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
          start,
          end,
        ),
      )
    }
    return slots
  }

  if (granularity === 'month') {
    for (let i = MONTH_SLOTS - 1; i >= 0; i--) {
      const start = new Date(today.getFullYear(), today.getMonth() - i, 1)
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0)
      slots.push(
        emptySlot(
          `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`,
          `${pad2(start.getMonth() + 1)}月`,
          start,
          end,
        ),
      )
    }
    return slots
  }

  for (let i = DAY_SLOTS - 1; i >= 0; i--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    slots.push(
      emptySlot(dateKeyOf(day), `${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`, day, day),
    )
  }
  return slots
}

// history: [{ date, prompt, completion, total, calls, models: [{ model, total, ... }] }]
export function buildTokenSeries(history, granularity, now = new Date()) {
  const slots = createTokenSlots(granularity, now)
  const byKey = new Map(slots.map((slot) => [slot.key, slot]))

  for (const entry of Array.isArray(history) ? history : []) {
    const date = parseDateKey(entry?.date)
    if (!date) continue
    const slot = byKey.get(slotKeyOf(date, granularity))
    if (!slot) continue

    slot.total += Number(entry.total) || 0
    slot.prompt += Number(entry.prompt) || 0
    slot.completion += Number(entry.completion) || 0
    slot.calls += Number(entry.calls) || 0

    for (const item of Array.isArray(entry.models) ? entry.models : []) {
      const name = item?.model || '未知模型'
      const total = Number(item.total) || 0
      if (total <= 0) continue
      slot.models[name] = (slot.models[name] || 0) + total
    }
  }

  return slots
}

// 按窗口内 token 总量挑选要画曲线的模型
export function collectTopModels(series, limit = 5) {
  const totals = new Map()
  for (const slot of series || []) {
    for (const [model, total] of Object.entries(slot.models || {})) {
      totals.set(model, (totals.get(model) || 0) + (Number(total) || 0))
    }
  }
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([model]) => model)
}

// 热力等级 0（无数据）到 4（最高）
export function heatLevel(value, max, levels = 5) {
  const total = Number(value) || 0
  const peak = Number(max) || 0
  if (total <= 0 || peak <= 0) return 0
  return Math.min(levels - 1, Math.max(1, Math.ceil((total / peak) * (levels - 1))))
}

export function summarizeTokenSeries(series) {
  let total = 0
  let peak = 0
  let active = 0
  for (const slot of series || []) {
    total += slot.total
    peak = Math.max(peak, slot.total)
    if (slot.total > 0) active += 1
  }
  return { total, peak, active }
}
