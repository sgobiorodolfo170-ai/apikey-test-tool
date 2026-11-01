import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../utils/storage.js', () => ({
  initStorage: vi.fn(async () => {}),
  readChannels: vi.fn(async () => []),
  saveChannel: vi.fn(async (channel) => channel),
  deleteChannel: vi.fn(async () => {}),
  readRelay: vi.fn(async () => ({ port: 8787, providers: [] })),
  saveRelay: vi.fn(async (config) => config),
  readHistory: vi.fn(async () => []),
  saveHistory: vi.fn(async () => {}),
  deleteHistory: vi.fn(async () => {}),
  clearHistory: vi.fn(async () => {}),
  readProviders: vi.fn(async () => []),
  readProviderSettings: vi.fn(async () => null),
}))

vi.mock('../stores/updateStore.js', () => ({
  useUpdateStore: () => ({ check: vi.fn() }),
}))

import App from '../App.vue'

const gridStubs = {
  'grid-layout': { template: '<div class="grid-layout-stub"><slot /></div>' },
  'grid-item': {
    props: ['h', 'w', 'x', 'y', 'i', 'isDraggable', 'isResizable'],
    template:
      '<div class="grid-item-stub" :data-h="h" :data-w="w" :data-draggable="String(isDraggable)" :data-resizable="String(isResizable)"><slot /></div>',
  },
  HistoryPanel: { template: '<div class="history-stub"><slot name="actions" /></div>' },
  ChatEvalPanel: { template: '<div class="chat-stub" />' },
  ToastContainer: true,
}

function mountApp() {
  return mount(App, {
    global: { plugins: [createPinia()], stubs: gridStubs },
  })
}

describe('App 单卡工作区', () => {
  beforeEach(() => {
    localStorage.clear()
    window.electronAPI = undefined
    setActivePinia(createPinia())
  })

  it('左右两区合并在同一张卡片内，中间由分割线区分', async () => {
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findAll('.card')).toHaveLength(1)
    const card = wrapper.find('.card')
    expect(card.find('.history-stub').exists()).toBe(true)
    expect(card.find('.chat-stub').exists()).toBe(true)
    expect(card.find('.pane-divider').exists()).toBe(true)
    wrapper.unmount()
  })

  it('折叠后右区与分割线一起隐藏，并持久化折叠状态', async () => {
    const wrapper = mountApp()
    await flushPromises()

    await wrapper.find('button[title="折叠聊天测试区"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pane-divider').exists()).toBe(false)
    expect(wrapper.find('.chat-stub').exists()).toBe(false)
    expect(wrapper.find('.history-stub').exists()).toBe(true)
    expect(localStorage.getItem('dashboard-chat-collapsed')).toBe('1')

    await wrapper.find('button[title="展开聊天测试区"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pane-divider').exists()).toBe(true)
    expect(wrapper.find('.chat-stub').exists()).toBe(true)
    expect(localStorage.getItem('dashboard-chat-collapsed')).toBe('0')
    wrapper.unmount()
  })

  it('折叠状态下启动时不渲染右区', async () => {
    localStorage.setItem('dashboard-chat-collapsed', '1')
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.find('.pane-divider').exists()).toBe(false)
    expect(wrapper.find('.chat-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('历史版本的两张卡片布局迁移为单张卡片，保留较大高度', async () => {
    localStorage.setItem(
      'dashboard-layout',
      JSON.stringify([
        { i: 'history', x: 0, y: 0, w: 7, h: 6, minW: 3, minH: 4 },
        { i: 'chateval', x: 7, y: 0, w: 5, h: 9, minW: 3, minH: 4 },
      ]),
    )
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findAll('.grid-item-stub')).toHaveLength(1)
    expect(wrapper.findAll('.card')).toHaveLength(1)
    wrapper.unmount()
  })

  it('异常的超大行数被收敛到上限，避免行高被压缩到无法微调', async () => {
    localStorage.setItem(
      'dashboard-layout',
      JSON.stringify([{ i: 'history', x: 0, y: 0, w: 6, h: 155, minW: 2, minH: 4 }]),
    )
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findAll('.card')).toHaveLength(1)
    const item = wrapper.find('.grid-item-stub')
    expect(Number(item.attributes('data-h'))).toBe(24)
    expect(Number(item.attributes('data-w'))).toBe(12)
    wrapper.unmount()
  })

  it('窗口间距区域与卡片边缘都可拖动窗口，卡片本身不参与拖动/缩放', async () => {
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findAll('.window-drag')).toHaveLength(4)
    expect(wrapper.findAll('.card-drag')).toHaveLength(4)
    expect(wrapper.find('.edge-handle').exists()).toBe(false)

    const item = wrapper.find('.grid-item-stub')
    expect(item.attributes('data-draggable')).toBe('false')
    expect(item.attributes('data-resizable')).toBe('false')
    wrapper.unmount()
  })

  it('卡片与窗口四边的间距为 10px（容器 padding 5px + 网格 margin 5px）', async () => {
    const wrapper = mountApp()
    await flushPromises()

    const root = wrapper.find('.h-screen')
    expect(root.exists()).toBe(true)
    const rootClass = root.attributes('class')
    expect(rootClass).toContain('pt-[5px]')
    expect(rootClass).toContain('pl-[5px]')
    expect(rootClass).toContain('pr-[5px]')
    expect(rootClass).toContain('pb-[10px]')
    wrapper.unmount()
  })
})
