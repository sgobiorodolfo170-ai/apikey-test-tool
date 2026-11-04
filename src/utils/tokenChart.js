// 中转站 token 图表的数据整理：把持久化的用量汇总成时 / 日 / 周 / 月时间片
// 时间键统一使用本地时间（YYYY-MM-DD / YYYY-MM-DDTHH），与主进程 relay.cjs 的切分方式保持一致

export const CHART_GRANULARITIES = [
  { id: 'hour', label: '时', span: 24 },
  { id: 'day', label: '日', span: 30 },
  { id: 'week', label: '周', span: 12 },
  { id: 'month', label: '月', span: 12 },
]

// 可拖动查看的历史范围：与主进程保留期对齐（小时 7 天、日 400 天）
export const HISTORY_SPANS = { hour: 24 * 7, day: 400, week: 52, month: 13 }

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
const HOUR_SLOTS = 24

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

export function startOfHour(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours())
}

export function dateKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function hourKeyOf(date) {
  return `${dateKeyOf(date)}T${pad2(date.getHours())}`
}

export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

export function parseHourKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(String(key || ''))
  if (!match) return null
  const hour = Number(match[4])
  if (hour < 0 || hour > 23) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour)
  return Number.isNaN(date.getTime()) ? null : date
}

function slotKeyOf(date, granularity) {
  if (granularity === 'hour') return hourKeyOf(date)
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
    // 模型 -> token 总量，供曲线与图例排序使用
    models: {},
    // 模型 -> 完整统计，供图例悬停展示
    modelStats: {},
  }
}

function defaultSlotCount(granularity) {
  if (granularity === 'hour') return HOUR_SLOTS
  if (granularity === 'week') return WEEK_SLOTS
  if (granularity === 'month') return MONTH_SLOTS
  return DAY_SLOTS
}

// 生成连续的时间片（缺数据的时段补 0），保证曲线与热力块 x 轴对齐
// count 省略时只生成图表一屏的点数；传入历史范围时可拖动查看更早数据
export function createTokenSlots(granularity, now = new Date(), count) {
  const today = startOfDay(now)
  const slots = []
  const requested = Number(count)
  const total =
    Number.isFinite(requested) && requested > 0
      ? Math.round(requested)
      : defaultSlotCount(granularity)

  if (granularity === 'hour') {
    const currentHour = startOfHour(now)
    for (let i = total - 1; i >= 0; i--) {
      const hour = new Date(
        currentHour.getFullYear(),
        currentHour.getMonth(),
        currentHour.getDate(),
        currentHour.getHours() - i,
      )
      slots.push(emptySlot(hourKeyOf(hour), `${pad2(hour.getHours())}:00`, hour, hour))
    }
    return slots
  }

  if (granularity === 'week') {
    const thisWeek = startOfWeek(today)
    for (let i = total - 1; i >= 0; i--) {
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
    for (let i = total - 1; i >= 0; i--) {
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

  for (let i = total - 1; i >= 0; i--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    slots.push(
      emptySlot(dateKeyOf(day), `${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`, day, day),
    )
  }
  return slots
}

// entry: { date / hour, prompt, completion, total, calls, models: [{ model, total, ... }] }
function addEntryToSlot(slot, entry) {
  slot.total += Number(entry.total) || 0
  slot.prompt += Number(entry.prompt) || 0
  slot.completion += Number(entry.completion) || 0
  slot.calls += Number(entry.calls) || 0

  for (const item of Array.isArray(entry.models) ? entry.models : []) {
    const name = item?.model || '未知模型'
    const total = Number(item.total) || 0
    if (total <= 0) continue
    slot.models[name] = (slot.models[name] || 0) + total

    const stat = slot.modelStats[name] || { prompt: 0, completion: 0, total: 0, calls: 0 }
    stat.prompt += Number(item.prompt) || 0
    stat.completion += Number(item.completion) || 0
    stat.total += total
    stat.calls += Number(item.calls) || 0
    slot.modelStats[name] = stat
  }
}

// history: [{ date, prompt, completion, total, calls, models: [{ model, total, ... }] }]
export function buildTokenSeries(history, granularity, now = new Date(), slotCount) {
  const slots = createTokenSlots(granularity, now, slotCount)
  const byKey = new Map(slots.map((slot) => [slot.key, slot]))

  for (const entry of Array.isArray(history) ? history : []) {
    const date = parseDateKey(entry?.date)
    if (!date) continue
    const slot = byKey.get(slotKeyOf(date, granularity))
    if (!slot) continue
    addEntryToSlot(slot, entry)
  }

  return slots
}

// hourlyHistory: [{ hour: '2026-11-04T10', prompt, completion, total, calls, models }]
export function buildHourlyTokenSeries(hourlyHistory, now = new Date(), slotCount) {
  const slots = createTokenSlots('hour', now, slotCount)
  const byKey = new Map(slots.map((slot) => [slot.key, slot]))

  for (const entry of Array.isArray(hourlyHistory) ? hourlyHistory : []) {
    const key = typeof entry?.hour === 'string' ? entry.hour : ''
    if (!parseHourKey(key)) continue
    const slot = byKey.get(key)
    if (!slot) continue
    addEntryToSlot(slot, entry)
  }

  return slots
}

// 把窗口内每个模型的统计汇总起来（图例悬停展示用）
export function summarizeModelTotals(series) {
  const totals = {}
  for (const slot of series || []) {
    for (const [model, stat] of Object.entries(slot.modelStats || {})) {
      const row = totals[model] || { prompt: 0, completion: 0, total: 0, calls: 0 }
      row.prompt += Number(stat.prompt) || 0
      row.completion += Number(stat.completion) || 0
      row.total += Number(stat.total) || 0
      row.calls += Number(stat.calls) || 0
      totals[model] = row
    }
  }
  return totals
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
