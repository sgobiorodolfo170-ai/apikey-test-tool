import { describe, it, expect } from 'vitest'
import {
  CHART_GRANULARITIES,
  HISTORY_SPANS,
  buildHourlyTokenSeries,
  buildTokenSeries,
  collectTopModels,
  createTokenSlots,
  dateKeyOf,
  formatTokenAmount,
  heatLevel,
  hourKeyOf,
  parseDateKey,
  startOfWeek,
  summarizeModelTotals,
  summarizeTokenSeries,
} from '../tokenChart.js'

const NOW = new Date(2026, 10, 1) // 2026-11-01（本地时区）

const HISTORY = [
  {
    date: '2026-11-01',
    prompt: 60,
    completion: 40,
    total: 100,
    calls: 2,
    models: [
      { model: 'model-a', total: 70, prompt: 40, completion: 30, calls: 1 },
      { model: 'model-b', total: 30, prompt: 20, completion: 10, calls: 1 },
    ],
  },
  {
    date: '2026-10-31',
    prompt: 30,
    completion: 20,
    total: 50,
    calls: 1,
    models: [{ model: 'model-a', total: 50, prompt: 30, completion: 20, calls: 1 }],
  },
]

describe('tokenChart', () => {
  it('parses and formats local date keys', () => {
    const date = parseDateKey('2026-11-01')
    expect(dateKeyOf(date)).toBe('2026-11-01')
    expect(parseDateKey('bad')).toBeNull()
    expect(parseDateKey('2026-13-40')).not.toBeNull()
  })

  it('creates 30 continuous day slots ending today', () => {
    const slots = createTokenSlots('day', NOW)
    expect(slots).toHaveLength(30)
    expect(slots[29].key).toBe('2026-11-01')
    expect(slots[0].key).toBe('2026-10-03')
    expect(slots[0].total).toBe(0)
  })

  it('creates 12 week slots starting on Monday', () => {
    const slots = createTokenSlots('week', NOW)
    expect(slots).toHaveLength(12)
    expect(slots[11].key).toBe(dateKeyOf(startOfWeek(NOW)))
    expect(slots[11].start.getDay()).toBe(1)
  })

  it('creates 12 month slots ending with the current month', () => {
    const slots = createTokenSlots('month', NOW)
    expect(slots).toHaveLength(12)
    expect(slots[11].key).toBe('2026-11')
    expect(slots[0].key).toBe('2025-12')
  })

  it('aggregates daily usage by day', () => {
    const series = buildTokenSeries(HISTORY, 'day', NOW)
    const today = series[series.length - 1]
    const yesterday = series[series.length - 2]
    expect(today.total).toBe(100)
    expect(today.prompt).toBe(60)
    expect(today.completion).toBe(40)
    expect(today.calls).toBe(2)
    expect(today.models['model-a']).toBe(70)
    expect(today.models['model-b']).toBe(30)
    expect(yesterday.total).toBe(50)
    expect(summarizeTokenSeries(series)).toEqual({ total: 150, peak: 100, active: 2 })
  })

  it('aggregates into the same week slot', () => {
    const series = buildTokenSeries(HISTORY, 'week', NOW)
    const last = series[series.length - 1]
    const weekStart = startOfWeek(NOW)
    const oct31 = parseDateKey('2026-10-31')
    const sameWeek = dateKeyOf(startOfWeek(oct31)) === dateKeyOf(weekStart)
    expect(last.key).toBe(dateKeyOf(weekStart))
    if (sameWeek) {
      expect(last.total).toBe(150)
      expect(last.models['model-a']).toBe(120)
    }
  })

  it('aggregates into monthly slots', () => {
    const series = buildTokenSeries(HISTORY, 'month', NOW)
    const current = series[series.length - 1]
    const previous = series[series.length - 2]
    expect(current.key).toBe('2026-11')
    expect(current.total).toBe(100)
    expect(previous.key).toBe('2026-10')
    expect(previous.total).toBe(50)
  })

  it('ignores unknown dates and missing models', () => {
    const series = buildTokenSeries(
      [{ date: '2020-01-01', total: 999 }, { date: 'bad', total: 1 }, null],
      'day',
      NOW,
    )
    expect(summarizeTokenSeries(series).total).toBe(0)
  })

  it('collects top models by total tokens', () => {
    const series = buildTokenSeries(HISTORY, 'day', NOW)
    expect(collectTopModels(series)).toEqual(['model-a', 'model-b'])
    expect(collectTopModels(series, 1)).toEqual(['model-a'])
    expect(collectTopModels([])).toEqual([])
  })

  it('maps token values to heat levels', () => {
    expect(heatLevel(0, 100)).toBe(0)
    expect(heatLevel(1, 100)).toBe(1)
    expect(heatLevel(25, 100)).toBe(1)
    expect(heatLevel(26, 100)).toBe(2)
    expect(heatLevel(50, 100)).toBe(2)
    expect(heatLevel(75, 100)).toBe(3)
    expect(heatLevel(100, 100)).toBe(4)
    expect(heatLevel(10, 0)).toBe(0)
  })

  it('formats token totals with M / K units', () => {
    expect(formatTokenAmount(0)).toBe('0')
    expect(formatTokenAmount(999)).toBe('999')
    expect(formatTokenAmount(1000)).toBe('1.0K')
    expect(formatTokenAmount(15414)).toBe('15.4K')
    expect(formatTokenAmount(25316172)).toBe('25.3M')
    expect(formatTokenAmount(1_200_000_000)).toBe('1.2B')
  })

  it('exposes the hour / day / week / month granularities', () => {
    expect(CHART_GRANULARITIES.map((item) => item.label)).toEqual(['时', '日', '周', '月'])
  })

  it('creates 24 continuous hour slots ending with the current hour', () => {
    const now = new Date(2026, 10, 1, 10, 30)
    const slots = createTokenSlots('hour', now)
    expect(slots).toHaveLength(24)
    expect(slots[23].key).toBe('2026-11-01T10')
    expect(slots[0].key).toBe('2026-10-31T11')
    expect(slots[23].label).toBe('10:00')
  })

  it('can create the full history window for chart panning', () => {
    const now = new Date(2026, 10, 1, 10, 30)
    expect(createTokenSlots('day', now, 400)).toHaveLength(400)
    expect(createTokenSlots('week', now, 52)).toHaveLength(52)
    expect(createTokenSlots('month', now, 13)).toHaveLength(13)
    expect(createTokenSlots('hour', now, 168)).toHaveLength(168)
    expect(createTokenSlots('day', now, 400).at(-1).key).toBe('2026-11-01')
    expect(HISTORY_SPANS.day).toBe(400)
    expect(HISTORY_SPANS.hour).toBe(168)
  })

  it('aggregates hourly usage and model totals', () => {
    const now = new Date(2026, 10, 1, 10, 30)
    const hourly = [
      {
        hour: '2026-11-01T09',
        prompt: 40,
        completion: 20,
        total: 60,
        calls: 1,
        models: [{ model: 'model-a', prompt: 40, completion: 20, total: 60, calls: 1 }],
      },
      {
        hour: hourKeyOf(now),
        prompt: 10,
        completion: 5,
        total: 15,
        calls: 1,
        models: [{ model: 'model-a', prompt: 10, completion: 5, total: 15, calls: 1 }],
      },
    ]

    const series = buildHourlyTokenSeries(hourly, now)
    expect(series[23].key).toBe('2026-11-01T10')
    expect(series[23].total).toBe(15)
    expect(series[22].total).toBe(60)
    expect(summarizeTokenSeries(series)).toEqual({ total: 75, peak: 60, active: 2 })
    expect(summarizeModelTotals(series)['model-a']).toEqual({
      prompt: 50,
      completion: 25,
      total: 75,
      calls: 2,
    })
  })
})
