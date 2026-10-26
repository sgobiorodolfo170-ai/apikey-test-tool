import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readChannels: vi.fn(() => Promise.resolve([])),
  saveChannel: vi.fn(),
  deleteChannel: vi.fn(),
  readHistory: vi.fn(() => Promise.resolve([])),
  saveTestRecord: vi.fn(),
  saveProvider: vi.fn(),
  deleteProvider: vi.fn(),
  writeHistory: vi.fn(),
  readProviders: vi.fn(() => Promise.resolve([])),
  readProviderSettings: vi.fn(() => Promise.resolve(null)),
  deleteTestRecord: vi.fn(),
  clearHistory: vi.fn(),
}))

import ChannelPanel from '../ChannelPanel.vue'
import { useChannelStore } from '../../stores/channelStore.js'
import { useHistoryStore } from '../../stores/historyStore.js'
import { readChannels } from '../../utils/storage.js'

const channels = [
  {
    id: 'ch_1',
    name: '渠道A',
    baseUrl: 'https://a.example.com/v1',
    apiMode: 'openai',
    apiKey: 'sk-a',
  },
  {
    id: 'ch_2',
    name: '渠道B',
    baseUrl: 'https://b.example.com/v1',
    apiMode: 'anthropic',
    apiKey: 'sk-b',
  },
]

describe('ChannelPanel', () => {
  let wrapper
  let channelStore

  beforeEach(async () => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    readChannels.mockResolvedValue([])

    const pinia = createPinia()
    setActivePinia(pinia)
    channelStore = useChannelStore()
    wrapper = mount(ChannelPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('shows a hint when no channel is saved', () => {
    expect(wrapper.text()).toContain('还没有保存的渠道')
    expect(wrapper.text()).toContain('存为渠道')
  })

  it('renders saved channels with mode and address', async () => {
    channelStore.channels = channels
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('渠道A')
    expect(wrapper.text()).toContain('渠道B')
    expect(wrapper.text()).toContain('https://a.example.com/v1')
    expect(wrapper.text()).toContain('未体检')
  })

  it('shows the latest checkup score from history for the same base url', async () => {
    channelStore.channels = channels
    const historyStore = useHistoryStore()
    historyStore.records = [
      {
        id: 'r1',
        timestamp: '2026-10-27T01:00:00.000Z',
        config: { baseUrl: 'https://a.example.com/v1' },
        checkup: { verdict: { score: 82, level: '良好', color: 'success' } },
      },
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('82')
    // 渠道B 没有体检记录，仍然显示未体检
    expect(wrapper.text()).toContain('未体检')
  })

  it('applies a channel to the config panel when 使用 is clicked', async () => {
    channelStore.channels = channels
    await wrapper.vm.$nextTick()

    const useButton = wrapper.findAll('button').find((b) => b.text() === '使用')
    await useButton.trigger('click')

    expect(channelStore.pendingApply).toEqual(channels[0])
  })

  it('deletes a channel after confirmation', async () => {
    channelStore.channels = channels
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    const removeSpy = vi.spyOn(channelStore, 'remove').mockResolvedValue(true)
    await wrapper.vm.$nextTick()

    const deleteButton = wrapper.findAll('button').find((b) => b.text() === '删除')
    await deleteButton.trigger('click')

    expect(removeSpy).toHaveBeenCalledWith('ch_1')
  })

  it('does not delete when the confirmation is dismissed', async () => {
    channelStore.channels = channels
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    )
    const removeSpy = vi.spyOn(channelStore, 'remove').mockResolvedValue(true)
    await wrapper.vm.$nextTick()

    const deleteButton = wrapper.findAll('button').find((b) => b.text() === '删除')
    await deleteButton.trigger('click')

    expect(removeSpy).not.toHaveBeenCalled()
  })
})
