import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readRelay: vi.fn(() => Promise.resolve({ port: 8787, providers: [], apiKey: '' })),
  saveRelay: vi.fn((config) => Promise.resolve(config)),
}))

import RelayStatsPanel from '../RelayStatsPanel.vue'

const logs = [
  {
    id: 'l2',
    at: '2026-10-31T02:00:01.000Z',
    model: 'SenseChat-5',
    provider: '商汤日日新',
    client: '工具A',
    status: 200,
    ms: 80,
    attempt: 2,
    keyTail: 'aaaaaa',
    failover: true,
    requestId: 'req_abc123',
    usage: { prompt: 10, completion: 20, total: 30 },
    error: null,
  },
  {
    id: 'l1',
    at: '2026-10-31T02:00:00.000Z',
    model: 'SenseChat-5',
    provider: '商汤日日新',
    status: 429,
    ms: 20,
    attempt: 1,
    keyTail: 'bbbbbb',
    failover: false,
    requestId: 'req_abc123',
    usage: null,
    error: 'HTTP 429',
  },
]

function mountPanel(pinia) {
  return mount(RelayStatsPanel, { global: { plugins: [pinia] } })
}

describe('RelayStatsPanel', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('groups attempts by request_id and marks key failover', async () => {
    window.electronAPI = {
      relay: {
        logs: vi.fn(async () => ({ ok: true, logs })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const wrapper = mountPanel(pinia)
    await flushPromises()

    expect(wrapper.text()).toContain('共 1 个请求')
    expect(wrapper.text()).toContain('请求成功率 100%')
    expect(wrapper.text()).toContain('尝试成功率 50%')
    expect(wrapper.text()).toContain('req_abc123')
    expect(wrapper.text()).toContain('商汤日日新')
    expect(wrapper.text()).toContain('SenseChat-5')
    expect(wrapper.text()).toContain('客户端')
    expect(wrapper.text()).toContain('工具A')
    expect(wrapper.text()).toContain('50%')
    expect(wrapper.text()).toContain('(1/2)')
    expect(wrapper.text()).toContain('100%')
    expect(wrapper.text()).toContain('100ms')
    expect(wrapper.text()).toContain('30 tokens')

    const failoverCell = wrapper.findAll('td').find((td) => td.text() === '是')
    expect(failoverCell).toBeTruthy()
    expect(failoverCell.attributes('title')).toContain('…bbbbbb → …aaaaaa')

    wrapper.unmount()
  })

  it('shows an empty hint before any call', async () => {
    window.electronAPI = {
      relay: {
        logs: vi.fn(async () => ({ ok: true, logs: [] })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const wrapper = mountPanel(pinia)
    await flushPromises()

    expect(wrapper.text()).toContain('还没有调用记录')

    wrapper.unmount()
  })

  it('shows 取消 for a request aborted by the client', async () => {
    window.electronAPI = {
      relay: {
        logs: vi.fn(async () => ({
          ok: true,
          logs: [
            {
              id: 'l3',
              at: '2026-10-31T02:10:00.000Z',
              model: 'm',
              provider: 'A',
              client: '工具B',
              status: 499,
              ms: 12,
              attempt: 1,
              keyTail: '',
              failover: false,
              requestId: 'req_abort',
              usage: null,
              error: '客户端已断开',
              aborted: true,
            },
          ],
        })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const wrapper = mountPanel(pinia)
    await flushPromises()

    expect(wrapper.text()).toContain('取消')
    expect(wrapper.text()).toContain('工具B')

    wrapper.unmount()
  })
})
