import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readChannels: vi.fn(),
  saveChannel: vi.fn(),
  deleteChannel: vi.fn(),
}))

import { useChannelStore } from '../channelStore.js'
import { useToastStore } from '../toastStore.js'
import { readChannels, saveChannel, deleteChannel } from '../../utils/storage.js'

const sample = {
  id: 'ch_1',
  name: '渠道A',
  baseUrl: 'https://a.example.com/v1',
  apiMode: 'openai',
  apiKey: 'sk-a',
}

describe('channelStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads channels once and caches the initialized flag', async () => {
    readChannels.mockResolvedValue([sample])
    const store = useChannelStore()

    await store.load()
    expect(store.channels).toHaveLength(1)
    expect(store.count).toBe(1)
    expect(store.initialized).toBe(true)

    await store.load()
    expect(readChannels).toHaveBeenCalledTimes(1)
  })

  it('surfaces a toast when loading fails', async () => {
    readChannels.mockRejectedValue(new Error('boom'))
    const store = useChannelStore()
    const toast = useToastStore()

    await store.load()

    expect(store.initialized).toBe(false)
    expect(toast.toasts.at(-1).type).toBe('error')
  })

  it('upserts and replaces the channel list', async () => {
    saveChannel.mockResolvedValue([sample])
    const store = useChannelStore()

    const ok = await store.upsert(sample)

    expect(ok).toBe(true)
    expect(store.channels).toEqual([sample])
    expect(saveChannel).toHaveBeenCalledWith(sample)
  })

  it('reports failure when saving throws', async () => {
    saveChannel.mockRejectedValue(new Error('disk full'))
    const store = useChannelStore()

    const ok = await store.upsert(sample)

    expect(ok).toBe(false)
    expect(store.channels).toEqual([])
  })

  it('removes a channel by id', async () => {
    deleteChannel.mockResolvedValue([])
    const store = useChannelStore()
    store.channels = [sample]

    await store.remove('ch_1')

    expect(deleteChannel).toHaveBeenCalledWith('ch_1')
    expect(store.channels).toEqual([])
  })

  it('hands a channel over to the config panel once', () => {
    const store = useChannelStore()

    store.apply(sample)
    expect(store.pendingApply).toEqual(sample)

    const applied = store.consumeApply()
    expect(applied).toEqual(sample)
    expect(store.pendingApply).toBeNull()
  })
})
