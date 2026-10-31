import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/storage.js', () => ({
  readRelay: vi.fn(() => Promise.resolve({ port: 8787, providers: [] })),
  saveRelay: vi.fn((config) => Promise.resolve(config)),
}))

import RelayPanel from '../RelayPanel.vue'
import { useRelayStore } from '../../stores/relayStore.js'

describe('RelayPanel', () => {
  let wrapper
  let store

  beforeEach(async () => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        start: vi.fn(async ({ port }) => ({
          ok: true,
          port,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          status: { running: true, port, baseUrl: `http://127.0.0.1:${port}/v1` },
        })),
        stop: vi.fn(async () => ({ ok: true, status: { running: false } })),
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        update: vi.fn(async () => ({ ok: true, status: { running: true } })),
        fetchModels: vi.fn(async () => ({ ok: true, models: ['m1', 'm2'] })),
        logs: vi.fn(async () => ({
          ok: true,
          logs: [
            {
              id: 'l1',
              at: '2026-10-30T12:00:00.000Z',
              model: 'gpt-4o',
              provider: 'A',
              status: 200,
              ms: 34,
            },
          ],
        })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
      openExternal: vi.fn(async () => ({ success: true })),
    }

    const pinia = createPinia()
    setActivePinia(pinia)
    store = useRelayStore()
    wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('shows the endpoint and stopped state by default', () => {
    expect(wrapper.text()).toContain('已停止')
    expect(wrapper.text()).toContain('http://127.0.0.1:8787/v1')
  })

  it('starts and stops the relay', async () => {
    const startButton = wrapper.findAll('button').find((b) => b.text() === '启动')
    await startButton.trigger('click')
    await flushPromises()

    expect(window.electronAPI.relay.start).toHaveBeenCalled()
    expect(wrapper.text()).toContain('运行中')

    const stopButton = wrapper.findAll('button').find((b) => b.text() === '停止')
    await stopButton.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已停止')
  })

  it('prefills the form from a built-in preset', async () => {
    await wrapper.find('select').setValue('agnes')
    await flushPromises()

    const inputs = wrapper.findAll('input')
    const baseUrl = inputs.find((i) => i.element.placeholder.includes('https://'))
    expect(baseUrl.element.value).toBe('https://apihub.agnes-ai.com/v1')
  })

  it('prefills the 端砚 preset with the discovery base url', async () => {
    await wrapper.find('select').setValue('duanyan')
    await flushPromises()

    const baseUrl = wrapper.findAll('input').find((i) => i.element.placeholder.includes('https://'))
    expect(baseUrl.element.value).toBe('https://discovery-api.intern-ai.org.cn/v1')
  })

  it('adds key / model inputs and submits every value', async () => {
    const addKey = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '增加一个 API Key 输入框')
    await addKey.trigger('click')
    await addKey.trigger('click')

    expect(wrapper.findAll('input[type="password"]')).toHaveLength(3)

    const modelInputs = () =>
      wrapper.findAll('input').filter((i) => i.element.placeholder.startsWith('模型'))
    expect(modelInputs()).toHaveLength(1)

    const addModel = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '增加一个模型输入框')
    await addModel.trigger('click')
    expect(modelInputs()).toHaveLength(2)

    await wrapper.find('input[placeholder="提供商名称"]').setValue('多Key上游')
    await wrapper
      .find('input[placeholder="https://api.example.com/v1"]')
      .setValue('https://multi.example/v1')

    const keys = wrapper.findAll('input[type="password"]')
    await keys[0].setValue('sk-1')
    await keys[1].setValue('sk-2')

    await modelInputs()[0].setValue('m1')
    await modelInputs()[1].setValue('m2')

    const submit = wrapper.findAll('button').find((b) => b.text() === '添加提供商')
    await submit.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].apiKeys).toEqual(['sk-1', 'sk-2'])
    expect(store.providers[0].apiKey).toBe('sk-1')
    expect(store.providers[0].models).toEqual(['m1', 'm2'])
  })

  it('edits an existing provider and saves added keys / models', async () => {
    await store.addProvider({ name: 'A', baseUrl: 'https://a', apiKeys: ['k1'], models: ['m1'] })
    await flushPromises()

    const editButton = wrapper.findAll('button').find((b) => b.text() === '编辑')
    await editButton.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('编辑提供商')
    expect(wrapper.find('input[placeholder="提供商名称"]').element.value).toBe('A')

    const addKey = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '增加一个 API Key 输入框')
    await addKey.trigger('click')
    const addModel = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '增加一个模型输入框')
    await addModel.trigger('click')

    const keys = wrapper.findAll('input[type="password"]')
    await keys[1].setValue('k2')
    const models = wrapper.findAll('input').filter((i) => i.element.placeholder.startsWith('模型'))
    await models[1].setValue('m2')

    const save = wrapper.findAll('button').find((b) => b.text() === '保存修改')
    await save.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].apiKeys).toEqual(['k1', 'k2'])
    expect(store.providers[0].models).toEqual(['m1', 'm2'])
    expect(store.providers[0].apiKey).toBe('k1')
  })

  it('submits model aliases from the form', async () => {
    await wrapper.find('input[placeholder="提供商名称"]').setValue('A')
    await wrapper.find('input[placeholder="https://api.example.com/v1"]').setValue('https://a/v1')
    const aliasInput = wrapper.find('input[placeholder="客户端模型名=上游真实模型"]')
    await aliasInput.setValue('my-model=gpt-4o')

    const submit = wrapper.findAll('button').find((b) => b.text() === '添加提供商')
    await submit.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].modelAliases).toEqual({ 'my-model': 'gpt-4o' })
  })

  it('adds a provider from the form', async () => {
    await wrapper.find('select').setValue('sensenova')
    await flushPromises()

    const addButton = wrapper.findAll('button').find((b) => b.text() === '添加提供商')
    await addButton.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].name).toBe('商汤日日新')
    expect(wrapper.text()).toContain('商汤日日新')
  })

  it('prefills the 商汤 preset with the token base url', async () => {
    await wrapper.find('select').setValue('sensenova')
    await flushPromises()

    const baseUrl = wrapper.findAll('input').find((i) => i.element.placeholder.includes('https://'))
    expect(baseUrl.element.value).toBe('https://token.sensenova.cn/v1')
  })

  it('pulls models into the picker and inserts the chosen one', async () => {
    await store.addProvider({ name: 'A', baseUrl: 'https://a/v1' })
    await flushPromises()

    const editButton = wrapper.findAll('button').find((b) => b.text() === '编辑')
    await editButton.trigger('click')
    await flushPromises()

    const pickerButton = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '从上游拉取模型并选择一个')
    await pickerButton.trigger('click')
    await flushPromises()

    expect(window.electronAPI.relay.fetchModels).toHaveBeenCalled()

    const options = [...document.body.querySelectorAll('button')].filter(
      (b) => b.textContent.trim() === 'm1',
    )
    expect(options.length).toBeGreaterThan(0)
    options[0].click()
    await flushPromises()

    const save = wrapper.findAll('button').find((b) => b.text() === '保存修改')
    await save.trigger('click')
    await flushPromises()

    expect(store.providers[0].models).toEqual(['m1'])
  })

  it('shows the empty hint when no provider is configured', () => {
    expect(wrapper.text()).toContain('还没有提供商')
  })
})

describe('RelayPanel 日志与排序', () => {
  let wrapper
  let store

  beforeEach(async () => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        start: vi.fn(),
        stop: vi.fn(),
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        update: vi.fn(),
        fetchModels: vi.fn(),
        logs: vi.fn(async () => ({
          ok: true,
          logs: [
            {
              id: 'l1',
              at: '2026-10-30T12:00:00.000Z',
              model: 'gpt-4o',
              provider: 'A',
              status: 200,
              ms: 34,
            },
          ],
        })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }

    const pinia = createPinia()
    setActivePinia(pinia)
    store = useRelayStore()
    wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('renders a collapsed request log section', () => {
    expect(wrapper.text()).toContain('请求日志')
  })

  it('shows log entries once loaded', async () => {
    await store.loadLogs()
    await flushPromises()

    expect(wrapper.text()).toContain('gpt-4o')
    expect(wrapper.text()).toContain('34ms')
  })

  it('offers up/down controls for failover order', async () => {
    await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await store.addProvider({ name: 'B', baseUrl: 'https://b' })
    await flushPromises()

    const downButton = wrapper.findAll('button').find((b) => b.text() === '↓')
    await downButton.trigger('click')
    await flushPromises()

    expect(store.providers.map((p) => p.name)).toEqual(['B', 'A'])
  })
})

describe('RelayPanel 限流展示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.electronAPI = {
      relay: {
        start: vi.fn(),
        stop: vi.fn(),
        status: vi.fn(async () => ({ ok: true, status: { running: false } })),
        update: vi.fn(),
        fetchModels: vi.fn(),
        logs: vi.fn(async () => ({ ok: true, logs: [] })),
        clearLogs: vi.fn(async () => ({ ok: true, logs: [] })),
      },
    }
  })

  it('shows the concurrency and rpm for each provider', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await store.addProvider({ name: 'A', baseUrl: 'https://a', maxConcurrency: 2, rpmLimit: 60 })
    await flushPromises()

    expect(wrapper.text()).toContain('2 并发')
    expect(wrapper.text()).toContain('60 RPM')
  })

  it('shows 不限速 when no rpm cap is set', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await flushPromises()

    expect(wrapper.text()).toContain('不限速')
  })

  it('toggles session stickiness', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    const label = wrapper.findAll('label').find((item) => item.text().includes('会话粘性'))
    expect(label).toBeTruthy()

    await label.find('input[type="checkbox"]').setValue(true)
    await flushPromises()

    expect(store.sticky).toBe(true)
    expect(label.find('input[type="checkbox"]').element.checked).toBe(true)
  })

  it('adds a client key and lists it', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    const button = wrapper.findAll('button').find((item) => item.text() === '+ 添加客户端')
    expect(button).toBeTruthy()

    await button.trigger('click')
    await flushPromises()

    expect(store.clientKeys).toHaveLength(1)
    expect(wrapper.text()).toContain(store.clientKeys[0].key)
    expect(wrapper.text()).toContain('已设 1 个')
  })

  it('applies preset quota and shows the 5h / 7d limits', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await wrapper.find('select').setValue('sensenova')
    await flushPromises()

    const quotaLabel = wrapper.findAll('label').find((item) => item.text().includes('额度窗口'))
    expect(quotaLabel).toBeTruthy()
    expect(quotaLabel.find('input[type="checkbox"]').element.checked).toBe(true)
    const numbers = wrapper.findAll('input[type="number"]').map((item) => item.element.value)
    expect(numbers).toContain('1500')
    expect(numbers).toContain('15000')
  })
})
