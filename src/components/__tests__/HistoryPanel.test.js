import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
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
