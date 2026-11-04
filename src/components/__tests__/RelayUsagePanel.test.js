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

  it('lists every upstream key and uses persisted key usage', async () => {
    relayStore.providers = [
      {
        id: 'p1',
        name: '上游A',
        apiKey: 'sk-aaaa111111',
        apiKeys: ['sk-aaaa111111', 'sk-bbbb222222'],
      },
    ]
    relayStore.keyUsage = [
      {
        id: '上游A::111111',
        provider: '上游A',
        keyTail: '111111',
        calls: 3,
        success: 2,
        prompt: 100,
        completion: 50,
        total: 150,
        lastAt: '2026-11-01T10:00:00.000Z',
        windows: {
          hour: {
            calls: 3,
            success: 2,
            prompt: 100,
            completion: 50,
            total: 150,
            lastAt: '2026-11-01T10:00:00.000Z',
          },
          hours5: {
            calls: 4,
            success: 3,
            prompt: 120,
            completion: 60,
            total: 180,
            lastAt: '2026-11-01T10:00:00.000Z',
          },
          day: {
            calls: 5,
            success: 4,
            prompt: 150,
            completion: 80,
            total: 230,
            lastAt: '2026-11-01T10:00:00.000Z',
          },
          days7: {
            calls: 7,
            success: 6,
            prompt: 300,
            completion: 200,
            total: 500,
            lastAt: '2026-11-01T10:00:00.000Z',
          },
          month: {
            calls: 9,
            success: 8,
            prompt: 400,
            completion: 300,
            total: 700,
            lastAt: '2026-11-01T10:00:00.000Z',
          },
        },
      },
    ]
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).toContain('按 Key 统计')
    // 未调用的 Key 也要列出
    expect(text).toContain('…222222')
    // 已调用的 Key 展示持久化统计
    expect(text).toContain('…111111')
    expect(text).not.toContain('按模型统计')

    // 标题后是五个窗口选项卡，而不是五个表格列
    expect(text).toContain('时调用')
    expect(text).toContain('5小时调用')
    expect(text).toContain('日调用')
    expect(text).toContain('7日调用')
    expect(text).toContain('月调用')
    const headers = wrapper.findAll('thead th').map((th) => th.text())
    expect(headers).toEqual(['提供商', 'Key', '调用', '成功', '输入', '输出', '合计', '最近'])

    const rowCells = () =>
      wrapper
        .findAll('tbody tr')[0]
        .findAll('td')
        .map((cell) => cell.text())
    // 默认时调用窗口
    expect(rowCells().slice(2, 7)).toEqual(['3', '2', '100', '50', '150'])

    // 切到 7 日调用后，列表按该窗口的数据重新统计
    const weekTab = wrapper.findAll('button').find((button) => button.text() === '7日调用')
    await weekTab.trigger('click')
    expect(rowCells().slice(2, 7)).toEqual(['7', '6', '300', '200', '500'])
  })
})
