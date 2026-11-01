import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RelayUsagePanel from '../RelayUsagePanel.vue'
import { useRelayStore } from '../../stores/relayStore.js'

function mountPanel(pinia) {
  return mount(RelayUsagePanel, {
    global: {
      plugins: [pinia],
      stubs: { RelayTokenChart: true },
    },
  })
}

describe('RelayUsagePanel 缓存节省', () => {
  let wrapper
  let relayStore
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mountPanel(pinia)
    relayStore = useRelayStore()
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  it('shows cached savings separately from real usage', async () => {
    relayStore.logs = [
      {
        at: '2026-11-01T10:00:00.000Z',
        provider: '上游A',
        model: 'm',
        status: 200,
        ms: 20,
        usage: { prompt: 10, completion: 5, total: 15 },
        keyTail: 'abcd',
      },
    ]
    relayStore.tokenHistory = [
      {
        date: '2026-11-01',
        prompt: 10,
        completion: 5,
        total: 15,
        calls: 2,
        models: [],
        cached: { prompt: 3, completion: 2, total: 5, calls: 1, models: [] },
      },
    ]
    await wrapper.vm.$nextTick()

    // 真实用量只显示 15，缓存命中的 5 单列为节省
    expect(wrapper.text()).toContain('tokens 15')
    expect(wrapper.text()).toContain('缓存节省')
    expect(wrapper.text()).toContain('1 次命中')
  })

  it('hides the cached hint when nothing was served from cache', async () => {
    relayStore.tokenHistory = [
      {
        date: '2026-11-01',
        prompt: 10,
        completion: 5,
        total: 15,
        calls: 2,
        models: [],
        cached: { prompt: 0, completion: 0, total: 0, calls: 0, models: [] },
      },
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('缓存节省')
  })
})
