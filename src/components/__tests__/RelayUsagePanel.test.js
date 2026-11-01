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

  it('breaks cache hit rate down by path and client, excluding streaming', async () => {
    const log = (overrides) => ({
      at: '2026-11-01T10:00:00.000Z',
      provider: '上游A',
      model: 'm',
      status: 200,
      ms: 10,
      stream: false,
      keyTail: 'abcd',
      ...overrides,
    })

    relayStore.logs = [
      // 非流式 chat：一次真实调用
      log({ id: 'l1', requestId: 'r1', path: '/chat/completions', client: '脚本' }),
      // 非流式 chat：一次命中
      log({
        id: 'l2',
        requestId: 'r2',
        path: '/chat/completions',
        client: '脚本',
        provider: '缓存',
        cached: true,
        stream: false,
        keyTail: '',
        cachedUsage: { prompt: 1, completion: 1, total: 2 },
      }),
      // 流式请求：不参与缓存命中率，不能进分母
      log({ id: 'l3', requestId: 'r3', path: '/chat/completions', client: '聊天', stream: true }),
      // embeddings：一次未命中
      log({ id: 'l4', requestId: 'r4', path: '/embeddings', client: '脚本', model: 'e' }),
    ]
    relayStore.tokenHistory = [
      {
        date: '2026-11-01',
        prompt: 16,
        completion: 0,
        total: 16,
        calls: 1,
        models: [],
        cached: { prompt: 15, completion: 0, total: 15, calls: 1, models: [] },
      },
    ]
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).toContain('缓存命中')
    expect(text).toContain('50%（1/2）')
    expect(text).toContain('0%（0/1）')
    // 节省率 = 15 / (16 + 15) ≈ 48%
    expect(text).toContain('48%')
    expect(text).toContain('客户端：脚本')
  })
})
