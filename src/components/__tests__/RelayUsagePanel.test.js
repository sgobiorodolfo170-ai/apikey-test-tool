import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readRelay: vi.fn(() => Promise.resolve({ port: 8787, providers: [], apiKey: '' })),
  saveRelay: vi.fn((config) => Promise.resolve(config)),
}))

import RelayUsagePanel from '../RelayUsagePanel.vue'

const logs = [
  {
    id: 'l3',
    at: '2026-10-31T02:00:02.000Z',
    model: 'm-b',
    provider: '商汤日日新',
    status: 500,
    keyTail: 'aaaaaa',
    usage: null,
    error: 'HTTP 500',
  },
  {
    id: 'l2',
    at: '2026-10-31T02:00:01.000Z',
    model: 'm-a',
    provider: '商汤日日新',
    status: 200,
    keyTail: 'bbbbbb',
    usage: { prompt: 5, completion: 5, total: 10 },
    error: null,
  },
  {
    id: 'l1',
    at: '2026-10-31T02:00:00.000Z',
    model: 'm-a',
    provider: '商汤日日新',
    status: 200,
    keyTail: 'aaaaaa',
    usage: { prompt: 10, completion: 20, total: 30 },
    error: null,
  },
]

describe('RelayUsagePanel', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('aggregates tokens per key and per model', async () => {
    window.electronAPI = {
      relay: {
        logs: vi.fn(async () => ({ ok: true, logs })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const wrapper = mount(RelayUsagePanel, { global: { plugins: [pinia] } })
    await flushPromises()

    expect(wrapper.text()).toContain('共 3 次调用')
    expect(wrapper.text()).toContain('tokens 40')
    expect(wrapper.text()).toContain('按 Key 统计')
    expect(wrapper.text()).toContain('按模型统计')
    expect(wrapper.text()).toContain('…aaaaaa')
    expect(wrapper.text()).toContain('…bbbbbb')
    expect(wrapper.text()).toContain('m-a')
    expect(wrapper.text()).toContain('m-b')
    expect(wrapper.text()).toContain('30')
    expect(wrapper.text()).toContain('10')

    const keyRows = wrapper.findAll('table')[0].findAll('tbody tr')
    expect(keyRows).toHaveLength(2)
    const modelRows = wrapper.findAll('table')[1].findAll('tbody tr')
    expect(modelRows).toHaveLength(2)

    wrapper.unmount()
  })

  it('shows an empty hint before any call', async () => {
    window.electronAPI = {
      relay: {
        logs: vi.fn(async () => ({ ok: true, logs: [] })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const wrapper = mount(RelayUsagePanel, { global: { plugins: [pinia] } })
    await flushPromises()

    expect(wrapper.text()).toContain('还没有 token 统计')

    wrapper.unmount()
  })
})
