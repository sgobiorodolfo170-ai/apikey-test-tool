import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RelayDiagnosticsPanel from '../RelayDiagnosticsPanel.vue'
import { useRelayStore } from '../../stores/relayStore.js'

const SAMPLE = [
  {
    id: 'diag_3',
    at: '2026-11-04T10:00:03.000Z',
    level: 'error',
    category: '上游',
    message: '所有上游均失败，请求返回 502',
    detail: '模型 gpt-4o · 路径 /chat/completions · 连接超时',
  },
  {
    id: 'diag_2',
    at: '2026-11-04T10:00:02.000Z',
    level: 'warn',
    category: '额度',
    message: 'Key 额度耗尽，已锁定 5 小时窗口',
    detail: '上游 A · 模型 gpt-4o · Key …abc123',
  },
  {
    id: 'diag_1',
    at: '2026-11-04T10:00:01.000Z',
    level: 'info',
    category: '启动',
    message: '中转站已启动',
    detail: '监听 http://127.0.0.1:8787/v1',
  },
]

describe('RelayDiagnosticsPanel', () => {
  let wrapper
  let relayStore

  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    relayStore = useRelayStore()
    relayStore.diagnostics = SAMPLE
    wrapper = mount(RelayDiagnosticsPanel, { global: { plugins: [pinia] } })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.unstubAllGlobals()
  })

  it('renders summary counts and every diagnostic event', () => {
    const text = wrapper.text()
    expect(text).toContain('共 3 条诊断事件')
    expect(text).toContain('错误 1')
    expect(text).toContain('警告 1')
    expect(text).toContain('信息 1')
    expect(text).toContain('所有上游均失败，请求返回 502')
    expect(text).toContain('Key 额度耗尽，已锁定 5 小时窗口')
    expect(text).toContain('中转站已启动')
    expect(text).toContain('连接超时')
  })

  it('filters events by level', async () => {
    const warningButton = wrapper.findAll('button').find((button) => button.text() === '警告')
    await warningButton.trigger('click')

    const text = wrapper.text()
    expect(text).toContain('Key 额度耗尽，已锁定 5 小时窗口')
    expect(text).not.toContain('所有上游均失败，请求返回 502')
    expect(text).not.toContain('中转站已启动')
  })

  it('switches to the long-term provider observation view', async () => {
    const button = wrapper.findAll('button').find((item) => item.text() === '提供商观察')
    await button.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('长期观察')
    expect(wrapper.text()).toContain('还没有长期观察数据')
  })

  it('shows an empty state when there are no diagnostics', async () => {
    relayStore.diagnostics = []
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('还没有诊断日志')
  })

  it('clears diagnostics after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    const clearSpy = vi.spyOn(relayStore, 'clearDiagnostics').mockResolvedValue()

    const clearButton = wrapper.findAll('button').find((button) => button.text() === '清空')
    await clearButton.trigger('click')

    expect(clearSpy).toHaveBeenCalledTimes(1)
    clearSpy.mockRestore()
  })
})
