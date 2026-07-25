import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ResultPanel from '../ResultPanel.vue'
import { useTestStore } from '../../stores/testStore.js'
import { setupElectronAPIMock, clearElectronAPIMock } from '../../__tests__/setup.js'

describe('ResultPanel', () => {
  let wrapper
  let testStore

  beforeEach(() => {
    setupElectronAPIMock()
    wrapper = mount(ResultPanel, {
      global: {
        plugins: [createPinia()],
      },
    })
    testStore = useTestStore()
  })

  afterEach(() => {
    clearElectronAPIMock()
  })

  it('should show empty state initially', () => {
    expect(wrapper.text()).toContain('暂无测试结果')
  })

  it('should show loading state', async () => {
    testStore.setCurrentResult({
      connected: false,
      connectTime: 0,
      models: [],
      error: '正在测试连接...',
    })
    testStore.isTesting = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('正在测试')
  })

  it('should display connection success', async () => {
    testStore.setCurrentResult({
      connected: true,
      connectTime: 150,
      models: [],
      summary: { success: 1, failed: 0, avgLatency: 150 },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('已连接')
    expect(wrapper.text()).toContain('150ms')
  })

  it('should display connection failure', async () => {
    testStore.setCurrentResult({
      connected: false,
      connectTime: 5000,
      error: 'API Key无效',
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('失败')
    expect(wrapper.text()).toContain('API Key无效')
  })

  it('should display model test results sorted by latency', async () => {
    testStore.setCurrentResult({
      connected: true,
      connectTime: 100,
      models: [
        { model: 'gpt-4', latency: 300, status: 'success' },
        { model: 'gpt-3.5-turbo', latency: 150, status: 'success' },
        { model: 'gpt-4-turbo', latency: -1, status: 'failed', error: 'timeout' },
      ],
      summary: { success: 2, failed: 1, avgLatency: 225 },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('gpt-3.5-turbo')
    expect(wrapper.text()).toContain('gpt-4')
    expect(wrapper.text()).toContain('gpt-4-turbo')
    expect(wrapper.text()).toContain('225ms')
  })

  it('should show warning card when present', async () => {
    testStore.setCurrentResult({
      connected: true,
      connectTime: 200,
      warning: 'API可访问(通过models端点确认)',
      models: [],
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('通过models端点确认')
  })

  it('should clear result', async () => {
    testStore.setCurrentResult({
      connected: true,
      connectTime: 100,
      models: [],
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('已连接')

    testStore.clearResult()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('暂无测试结果')
  })
})
