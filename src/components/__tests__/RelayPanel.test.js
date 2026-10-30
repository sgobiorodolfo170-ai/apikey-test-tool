import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readRelay: vi.fn(() => Promise.resolve({ port: 8787, providers: [] })),
  saveRelay: vi.fn((config) => Promise.resolve(config)),
}))

import RelayPanel from '../RelayPanel.vue'
import { useRelayStore } from '../../stores/relayStore.js'

describe('RelayPanel', () => {
  let wrapper
  let store

  beforeEach(async () => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        start: vi.fn(async ({ port }) => ({
          ok: true,
          port,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          status: { running: true, port, baseUrl: `http://127.0.0.1:${port}/v1` },
        })),
        stop: vi.fn(async () => ({ ok: true, status: { running: false } })),
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        update: vi.fn(async () => ({ ok: true, status: { running: true } })),
        fetchModels: vi.fn(async () => ({ ok: true, models: ['m1', 'm2'] })),
        logs: vi.fn(async () => ({
          ok: true,
          logs: [
            {
              id: 'l1',
              at: '2026-10-30T12:00:00.000Z',
              model: 'gpt-4o',
              provider: 'A',
              status: 200,
              ms: 34,
            },
          ],
        })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
      openExternal: vi.fn(async () => ({ success: true })),
    }

    const pinia = createPinia()
    setActivePinia(pinia)
    store = useRelayStore()
    wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('shows the endpoint and stopped state by default', () => {
    expect(wrapper.text()).toContain('中转站')
    expect(wrapper.text()).toContain('已停止')
    expect(wrapper.text()).toContain('http://127.0.0.1:8787/v1')
  })

  it('starts and stops the relay', async () => {
    const startButton = wrapper.findAll('button').find((b) => b.text() === '启动')
    await startButton.trigger('click')
    await flushPromises()

    expect(window.electronAPI.relay.start).toHaveBeenCalled()
    expect(wrapper.text()).toContain('运行中')

    const stopButton = wrapper.findAll('button').find((b) => b.text() === '停止')
    await stopButton.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已停止')
  })

  it('prefills the form from a built-in preset', async () => {
    await wrapper.find('select').setValue('agnes')
    await flushPromises()

    const inputs = wrapper.findAll('input')
    const baseUrl = inputs.find((i) => i.element.placeholder.includes('Base URL'))
    expect(baseUrl.element.value).toBe('https://apihub.agnes-ai.com/v1')
  })

  it('adds a provider from the form', async () => {
    await wrapper.find('select').setValue('sensenova')
    await flushPromises()

    const addButton = wrapper.findAll('button').find((b) => b.text() === '添加')
    await addButton.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].name).toBe('商汤日日新')
    expect(wrapper.text()).toContain('商汤日日新')
  })

  it('fetches models for a provider', async () => {
    await store.addProvider({ name: 'A', baseUrl: 'https://a/v1' })
    await flushPromises()

    const fetchButton = wrapper.findAll('button').find((b) => b.text() === '拉取模型')
    await fetchButton.trigger('click')
    await flushPromises()

    expect(window.electronAPI.relay.fetchModels).toHaveBeenCalled()
    expect(store.providers[0].models).toEqual(['m1', 'm2'])
  })

  it('shows the empty hint when no provider is configured', () => {
    expect(wrapper.text()).toContain('还没有提供商')
  })
})

describe('RelayPanel 日志与排序', () => {
  let wrapper
  let store

  beforeEach(async () => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        start: vi.fn(),
        stop: vi.fn(),
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        update: vi.fn(),
        fetchModels: vi.fn(),
        logs: vi.fn(async () => ({
          ok: true,
          logs: [
            {
              id: 'l1',
              at: '2026-10-30T12:00:00.000Z',
              model: 'gpt-4o',
              provider: 'A',
              status: 200,
              ms: 34,
            },
          ],
        })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const pinia = createPinia()
    setActivePinia(pinia)
    store = useRelayStore()
    wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('renders a collapsed request log section', () => {
    expect(wrapper.text()).toContain('请求日志')
  })

  it('shows log entries once loaded', async () => {
    await store.loadLogs()
    await flushPromises()

    expect(wrapper.text()).toContain('gpt-4o')
    expect(wrapper.text()).toContain('34ms')
  })

  it('offers up/down controls for failover order', async () => {
    await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await store.addProvider({ name: 'B', baseUrl: 'https://b' })
    await flushPromises()

    const downButton = wrapper.findAll('button').find((b) => b.text() === '↓')
    await downButton.trigger('click')
    await flushPromises()

    expect(store.providers.map((p) => p.name)).toEqual(['B', 'A'])
  })
})

describe('RelayPanel 限流展示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        start: vi.fn(),
        stop: vi.fn(),
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        update: vi.fn(),
        fetchModels: vi.fn(),
        logs: vi.fn(async () => ({ ok: true, logs: [] })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }
  })

  it('shows the concurrency and rpm for each provider', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await store.addProvider({ name: 'A', baseUrl: 'https://a', maxConcurrency: 2, rpmLimit: 60 })
    await flushPromises()

    expect(wrapper.text()).toContain('2 并发')
    expect(wrapper.text()).toContain('60 RPM')
  })

  it('shows 不限速 when no rpm cap is set', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await flushPromises()

    expect(wrapper.text()).toContain('不限速')
  })
})
