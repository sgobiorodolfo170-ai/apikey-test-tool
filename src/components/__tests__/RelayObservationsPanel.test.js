import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RelayObservationsPanel from '../RelayObservationsPanel.vue'
import { useRelayStore } from '../../stores/relayStore.js'

function dateKey(daysAgo = 0) {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function makeRow(overrides = {}) {
  return {
    id: `row-${Math.random()}`,
    providerId: 'p1',
    provider: '商汤日日新',
    model: 'm1',
    date: dateKey(),
    calls: 0,
    success: 0,
    rateLimited: 0,
    quotaLimited: 0,
    authFailed: 0,
    clientErrors: 0,
    serverErrors: 0,
    networkErrors: 0,
    aborted: 0,
    latency: { sum: 0, max: 0, buckets: [0, 0, 0, 0, 0, 0] },
    tokens: { prompt: 0, completion: 0, total: 0 },
    hourCalls: Array(24).fill(0),
    hourRateLimited: Array(24).fill(0),
    hourQuotaLimited: Array(24).fill(0),
    locks: { probe: 0, '5h': 0, week: 0 },
    recoveries: 0,
    recoveryMsSum: 0,
    firstAt: '',
    lastAt: '',
    ...overrides,
  }
}

const SAMPLE = [
  makeRow({
    calls: 4,
    success: 3,
    rateLimited: 1,
    quotaLimited: 1,
    latency: { sum: 400, max: 200, buckets: [1, 2, 1, 0, 0, 0] },
    tokens: { prompt: 80, completion: 40, total: 120 },
    locks: { probe: 1, '5h': 0, week: 0 },
    recoveries: 1,
    recoveryMsSum: 300000,
    hourCalls: Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 4 : 0)),
    hourRateLimited: Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 1 : 0)),
  }),
  makeRow({
    id: 'row-2',
    providerId: 'p2',
    provider: '书生·端砚',
    model: 'm2',
    calls: 2,
    success: 1,
    rateLimited: 1,
    quotaLimited: 1,
    latency: { sum: 8000, max: 7000, buckets: [0, 1, 0, 0, 1, 0] },
    tokens: { prompt: 20, completion: 10, total: 30 },
  }),
  makeRow({
    id: 'row-old',
    providerId: 'p1',
    provider: '商汤日日新',
    model: 'm1',
    date: dateKey(100),
    calls: 10,
    success: 10,
  }),
]

describe('RelayObservationsPanel', () => {
  let wrapper
  let relayStore

  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    relayStore = useRelayStore()
    window.electronAPI = {
      relay: {
        observations: vi.fn(async () => ({ ok: true, observations: SAMPLE })),
      },
    }
    wrapper = mount(RelayObservationsPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.unstubAllGlobals()
  })

  it('summarizes real calls, errors and peak hours', () => {
    const text = wrapper.text()
    expect(text).toContain('长期观察')
    expect(text).toContain('180 天')
    expect(text).toContain('商汤日日新')
    expect(text).toContain('书生·端砚')
    expect(text).toContain('10 点 4 次')
    expect(text).toContain('5 分钟')
  })

  it('filters by provider and model', async () => {
    const selects = wrapper.findAll('select')
    await selects[0].setValue('书生·端砚')
    await flushPromises()

    let text = wrapper.find('tbody').text()
    expect(text).toContain('书生·端砚')
    expect(text).not.toContain('商汤日日新')

    await selects[1].setValue('m2')
    await flushPromises()
    text = wrapper.find('tbody').text()
    expect(text).toContain('m2')
    expect(text).not.toContain('m1')
  })

  it('shows an empty state when no observation data exists', async () => {
    relayStore.observations = []
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('还没有长期观察数据')
  })

  it('distinguishes "no data" from "no data after filtering"', async () => {
    // 有数据，但筛选组合没有命中任何行 → 提示筛选为空，而不是「还没有数据」
    const selects = wrapper.findAll('select')
    await selects[0].setValue('书生·端砚')
    await selects[1].setValue('m1')
    await flushPromises()
    expect(wrapper.text()).toContain('当前筛选条件下没有观察数据')
    expect(wrapper.text()).not.toContain('还没有长期观察数据')
  })

  it('copies filtered rows as JSON', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const copyButton = wrapper.findAll('button').find((button) => button.text() === '复制 JSON')
    await copyButton.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(writeText.mock.calls[0][0])
    expect(payload.rows).toHaveLength(2)
    expect(payload.rows.some((row) => row.provider === '书生·端砚')).toBe(true)
    // 默认 90 天，100 天前的数据不导出
    expect(payload.rows.some((row) => row.id === 'row-old')).toBe(false)
  })
})
