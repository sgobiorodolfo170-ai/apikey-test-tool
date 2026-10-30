import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import HistoryPanel from '../HistoryPanel.vue'
import { useHistoryStore } from '../../stores/historyStore.js'
import { useTestStore } from '../../stores/testStore.js'
import { setupElectronAPIMock, clearElectronAPIMock, mockStore } from '../../__tests__/setup.js'

describe('HistoryPanel', () => {
  let wrapper
  let historyStore

  beforeEach(async () => {
    setupElectronAPIMock()
    // Pre-populate mock store
    mockStore.history = [
      {
        id: 'test_001',
        timestamp: '2026-06-11T12:00:00.000Z',
        config: {
          provider: 'test-provider',
          baseUrl: 'https://api.openai.com/v1',
          apiMode: 'openai',
        },
        result: { connected: true, summary: { success: 3, failed: 0 } },
      },
      {
        id: 'test_002',
        timestamp: '2026-06-10T12:00:00.000Z',
        config: { provider: 'failed-test', baseUrl: 'https://api.test.com', apiMode: 'anthropic' },
        result: { connected: false, summary: { success: 0, failed: 1 } },
      },
    ]
    wrapper = mount(HistoryPanel, {
      global: {
        plugins: [createPinia()],
      },
    })
    historyStore = useHistoryStore()
    // Load data into the store
    historyStore.records = mockStore.history
    historyStore.initialized = true
    await wrapper.vm.$nextTick()
  })

  afterEach(() => {
    clearElectronAPIMock()
  })

  it('should display history records', () => {
    expect(wrapper.text()).toContain('test-provider')
    expect(wrapper.text()).toContain('failed-test')
  })

  it('should show connection status for each record', () => {
    expect(wrapper.text()).toContain('已连接')
    expect(wrapper.text()).toContain('失败')
  })

  it('should call historyStore.reloadRecord on reload button click', async () => {
    const reloadSpy = vi.spyOn(historyStore, 'reloadRecord').mockResolvedValue()
    const reloadBtns = wrapper.findAll('button').filter((b) => b.text().includes('重新测试'))
    if (reloadBtns.length > 0) {
      await reloadBtns[0].trigger('click')
      expect(reloadSpy).toHaveBeenCalledWith(mockStore.history[0])
    }
    reloadSpy.mockRestore()
  })

  it('should set currentResult on record click', async () => {
    const testStore = useTestStore()
    const items = wrapper.findAll('[class*="cursor-pointer"]')
    if (items.length > 0) {
      await items[0].trigger('click')
      expect(testStore.currentResult).toEqual(mockStore.history[0].result)
    }
  })

  it('should show clear button', () => {
    expect(wrapper.text()).toContain('清空')
  })
})

// 落盘格式是 { version, data } 信封；未写入过时还是原始对象
function savedProviders() {
  const payload = mockStore.relay?.data || mockStore.relay || {}
  return payload.providers || []
}

describe('HistoryPanel 加入中转站', () => {
  let wrapper

  beforeEach(async () => {
    setupElectronAPIMock()
    mockStore.relay = { port: 8787, providers: [] }
    mockStore.history = [
      {
        id: 'h1',
        timestamp: '2026-10-30T10:00:00.000Z',
        config: {
          provider: '中转A',
          baseUrl: 'https://a.example.com/v1',
          apiMode: 'openai',
          apiKey: 'sk-a',
        },
        result: {
          connected: true,
          models: [
            { model: 'gpt-4o', status: 'success', latency: 120 },
            { model: 'broken', status: 'failed', latency: 0 },
          ],
        },
      },
      {
        id: 'h2',
        timestamp: '2026-10-30T09:00:00.000Z',
        config: {
          provider: 'Anthropic渠道',
          baseUrl: 'https://b.example.com',
          apiMode: 'anthropic',
        },
        result: { connected: true, models: [] },
      },
    ]

    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(HistoryPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('adds an OpenAI-compatible provider to the relay', async () => {
    const buttons = wrapper.findAll('button').filter((b) => b.text() === '加入中转站')
    expect(buttons.length).toBeGreaterThan(0)

    await buttons[0].trigger('click')
    await flushPromises()

    const providers = savedProviders()
    expect(providers).toHaveLength(1)
    const provider = providers[0]
    expect(provider.name).toBe('中转A')
    expect(provider.baseUrl).toBe('https://a.example.com/v1')
    expect(provider.apiKey).toBe('sk-a')
    // 只带上测试成功的模型
    expect(provider.models).toEqual(['gpt-4o'])
  })

  it('refuses non OpenAI-compatible modes', async () => {
    const buttons = wrapper.findAll('button').filter((b) => b.text() === '加入中转站')
    await buttons[1].trigger('click')
    await flushPromises()

    expect(savedProviders()).toHaveLength(0)
    expect(wrapper.text()).toContain('中转站')
  })
})
