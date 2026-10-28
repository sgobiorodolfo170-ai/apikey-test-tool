import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ChannelCompare from '../ChannelCompare.vue'
import { useToastStore } from '../../stores/toastStore.js'

const rows = [
  {
    key: 'https://a',
    name: '渠道A',
    baseUrl: 'https://a',
    apiMode: 'openai',
    model: 'gpt-4o',
    score: 88,
    level: '优秀',
    color: 'success',
    scoreVersion: 2,
    capability: 85,
    stability: 100,
    consistency: 90,
    checkedAt: '2026-10-29T01:00:00.000Z',
    delta: 6,
  },
  {
    key: 'https://b',
    name: '渠道B',
    baseUrl: 'https://b',
    apiMode: 'anthropic',
    model: 'claude',
    score: 52,
    level: '存疑',
    color: 'danger',
    scoreVersion: 2,
    capability: 40,
    stability: 80,
    consistency: 50,
    checkedAt: '2026-10-28T01:00:00.000Z',
    delta: -12,
  },
]

describe('ChannelCompare', () => {
  let wrapper

  beforeEach(() => {
    setActivePinia(createPinia())
    wrapper = mount(ChannelCompare, {
      props: { visible: true, rows },
    })
  })

  it('renders nothing when hidden', () => {
    const hidden = mount(ChannelCompare, { props: { visible: false, rows } })
    expect(hidden.text()).toBe('')
  })

  it('renders every channel row with its score', () => {
    expect(wrapper.text()).toContain('渠道A')
    expect(wrapper.text()).toContain('渠道B')
    expect(wrapper.text()).toContain('88')
    expect(wrapper.text()).toContain('52')
    expect(wrapper.text()).toContain('100%')
  })

  it('marks the best and worst channel', () => {
    expect(wrapper.text()).toContain('最优')
    expect(wrapper.text()).toContain('最低')
  })

  it('shows the delta with an arrow', () => {
    expect(wrapper.text()).toContain('↑6')
    expect(wrapper.text()).toContain('↓12')
  })

  it('emits close when the close button is clicked', async () => {
    const closeButton = wrapper.findAll('button').find((b) => b.text() === '关闭')
    await closeButton.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('copies a markdown table to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    const copyButton = wrapper.findAll('button').find((b) => b.text() === '复制表格')
    await copyButton.trigger('click')

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('| 渠道A | 88 |')
    expect(useToastStore().toasts.at(-1).type).toBe('success')
  })

  it('shows a hint when there is no data', () => {
    const empty = mount(ChannelCompare, { props: { visible: true, rows: [] } })
    expect(empty.text()).toContain('还没有体检记录')
  })
})
