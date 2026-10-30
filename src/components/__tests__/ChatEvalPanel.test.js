import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readChannels: vi.fn(() => Promise.resolve([])),
  saveChannel: vi.fn(),
  deleteChannel: vi.fn(),
  readRelay: vi.fn(() => Promise.resolve({ port: 8787, providers: [] })),
  saveRelay: vi.fn((config) => Promise.resolve(config)),
  readHistory: vi.fn(() => Promise.resolve([])),
  readProviders: vi.fn(() => Promise.resolve([])),
  readProviderSettings: vi.fn(() => Promise.resolve(null)),
}))

import ChatEvalPanel from '../ChatEvalPanel.vue'
import { useTestStore } from '../../stores/testStore.js'

describe('ChatEvalPanel', () => {
  let wrapper

  beforeEach(async () => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        logs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const pinia = createPinia()
    setActivePinia(pinia)
    // 测评面板需要有测试结果才会显示页签
    useTestStore().setCurrentResult({
      connected: true,
      connectTime: 10,
      config: { baseUrl: 'https://api.test/v1', apiMode: 'openai', apiKey: 'sk' },
      models: [{ model: 'gpt-4o', status: 'success', latency: 100 }],
    })
    wrapper = mount(ChatEvalPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('renders both tabs and defaults to chat', () => {
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels).toContain('聊天测试')
    expect(labels).toContain('模型测评')
    // 聊天面板的输入区在
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('switches to the eval tab', async () => {
    const evalTab = wrapper.findAll('button').find((b) => b.text() === '模型测评')
    await evalTab.trigger('click')
    await flushPromises()

    // 测评面板自带的页签
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels).toContain('能力')
    expect(labels).toContain('体检')
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('renders children without their own card chrome', async () => {
    // embedded 模式下子组件不再带 card 类
    expect(wrapper.findAll('.card')).toHaveLength(1)
  })
})
