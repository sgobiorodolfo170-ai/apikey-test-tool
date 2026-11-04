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
        testKey: vi.fn(async () => ({ ok: true, models: 2, ms: 12 })),
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
    const addKeyButton = () =>
      wrapper.findAll('button').find((b) => b.attributes('title') === '增加一个 API Key 输入框')
    await addKeyButton().trigger('click')
    await addKeyButton().trigger('click')

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

    // 提供商选项卡默认直接展示编辑页
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

    // 编辑内容自动保存，不再有「保存修改」按钮
    await wrapper.vm.$nextTick()
    await wrapper.vm.flushAutoSave()
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].apiKeys).toEqual(['k1', 'k2'])
    expect(store.providers[0].models).toEqual(['m1', 'm2'])
    expect(store.providers[0].apiKey).toBe('k1')
  })

  it('submits model aliases from the form', async () => {
    await wrapper.find('input[placeholder="提供商名称"]').setValue('A')
    await wrapper.find('input[placeholder="https://api.example.com/v1"]').setValue('https://a/v1')
    await wrapper.find('input[placeholder="模型名，如 gpt-4o"]').setValue('gpt-4o')
    const aliasInput = wrapper.find('input[placeholder="别名（可选，多个用逗号）"]')
    await aliasInput.setValue('my-model, my-model-2')

    const submit = wrapper.findAll('button').find((b) => b.text() === '添加提供商')
    await submit.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].modelAliases).toEqual({
      'my-model': 'gpt-4o',
      'my-model-2': 'gpt-4o',
    })
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

    // 模型选择后同样自动保存
    await wrapper.vm.$nextTick()
    await wrapper.vm.flushAutoSave()
    await flushPromises()

    expect(store.providers[0].models).toEqual(['m1'])
  })

  it('shows the empty hint when no provider is configured', () => {
    expect(wrapper.text()).toContain('还没有提供商')
  })

  it('offers the add tab instead of a separate add button', async () => {
    expect(wrapper.find('.provider-add-tab').exists()).toBe(true)
    expect(wrapper.findAll('button').filter((b) => b.text() === '+ 添加提供商')).toHaveLength(0)

    await wrapper.find('.provider-add-tab').trigger('click')
    await flushPromises()
    expect(wrapper.find('input[placeholder="提供商名称"]').element.value).toBe('')
  })

  it('shows each provider as a tab and displays its details', async () => {
    await store.addProvider({
      name: 'A',
      baseUrl: 'https://a.example/v1',
      models: ['m-a'],
      apiKeys: ['sk-aaa111'],
      modelAliases: { aliasA: 'm-a' },
    })
    await store.addProvider({
      name: 'B',
      baseUrl: 'https://b.example/v1',
      models: ['m-b'],
      maxConcurrency: 2,
      rpmLimit: 60,
    })
    await flushPromises()

    const tabs = wrapper.findAll('.provider-tab')
    expect(tabs).toHaveLength(2)
    expect(wrapper.text()).toContain('1. A')
    expect(wrapper.text()).toContain('2. B')

    // 默认选中第一个提供商，直接展示可编辑表单
    expect(wrapper.find('input[placeholder="提供商名称"]').element.value).toBe('A')
    expect(wrapper.find('input[placeholder="https://api.example.com/v1"]').element.value).toBe(
      'https://a.example/v1',
    )
    expect(wrapper.find('input[placeholder="模型名，如 gpt-4o"]').element.value).toBe('m-a')
    expect(wrapper.find('input[placeholder="别名（可选，多个用逗号）"]').element.value).toBe(
      'aliasA',
    )
    expect(wrapper.findAll('input[type="password"]')[0].element.value).toBe('sk-aaa111')

    // 点击第二个选项卡后加载第二个提供商的编辑页
    await tabs[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('input[placeholder="提供商名称"]').element.value).toBe('B')
    expect(wrapper.find('input[placeholder="https://api.example.com/v1"]').element.value).toBe(
      'https://b.example/v1',
    )
    expect(wrapper.find('input[placeholder="模型名，如 gpt-4o"]').element.value).toBe('m-b')
  })

  it('adds a delete tab that reveals delete icons', async () => {
    await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await store.addProvider({ name: 'B', baseUrl: 'https://b' })
    await flushPromises()

    expect(wrapper.findAll('.provider-delete-icon')).toHaveLength(0)
    await wrapper.find('.provider-delete-tab').trigger('click')
    expect(wrapper.findAll('.provider-delete-icon')).toHaveLength(2)

    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    try {
      await wrapper.findAll('.provider-delete-icon')[1].trigger('click')
      await flushPromises()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(store.providers.map((item) => item.name)).toEqual(['A'])
  })

  it('collapses extra api keys until show more is clicked', async () => {
    await store.addProvider({
      name: 'A',
      baseUrl: 'https://a',
      apiKeys: ['k1', 'k2', 'k3'],
    })
    await flushPromises()

    // 默认只显示第一把 Key
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(1)
    const more = wrapper.findAll('button').find((b) => b.text().includes('显示更多'))
    expect(more).toBeTruthy()
    expect(more.text()).toContain('3 把')

    await more.trigger('click')
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(3)

    const collapse = wrapper.findAll('button').find((b) => b.text() === '收起 Key')
    await collapse.trigger('click')
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(1)
  })

  it('shows only one add button on the last api key row', async () => {
    const keyAddButtons = () =>
      wrapper.findAll('button').filter((b) => b.attributes('title') === '增加一个 API Key 输入框')
    expect(keyAddButtons()).toHaveLength(1)
    await keyAddButtons()[0].trigger('click')
    expect(keyAddButtons()).toHaveLength(1)
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(2)
  })

  it('shows only one add button on the last model row and keeps aliases inline', async () => {
    const modelAddButtons = () =>
      wrapper.findAll('button').filter((b) => b.attributes('title') === '增加一个模型输入框')
    expect(modelAddButtons()).toHaveLength(1)

    await modelAddButtons()[0].trigger('click')
    expect(modelAddButtons()).toHaveLength(1)
    expect(
      wrapper.findAll('input').filter((i) => i.element.placeholder.startsWith('模型')),
    ).toHaveLength(2)
    // 每个模型行都有一个别名输入框，且不再有单独的别名单行
    expect(wrapper.findAll('input[placeholder="别名（可选，多个用逗号）"]')).toHaveLength(1)
    expect(wrapper.findAll('input[placeholder="别名"]')).toHaveLength(1)
    expect(wrapper.find('input[placeholder="客户端模型名=上游真实模型"]').exists()).toBe(false)
  })

  it('toggles every api key to plain text at once', async () => {
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(1)
    const reveal = wrapper.findAll('button').find((b) => b.text() === '一键明文')
    await reveal.trigger('click')

    const plain = wrapper
      .findAll('input[type="text"]')
      .filter((i) => i.element.placeholder.includes('sk-…'))
    expect(plain).toHaveLength(1)

    const hide = wrapper.findAll('button').find((b) => b.text() === '隐藏明文')
    await hide.trigger('click')
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(1)
  })

  it('tests every api key with one click', async () => {
    await wrapper
      .find('input[placeholder="https://api.example.com/v1"]')
      .setValue('https://multi.example/v1')
    await wrapper.findAll('input[type="password"]')[0].setValue('sk-1')

    const addKey = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '增加一个 API Key 输入框')
    await addKey.trigger('click')
    const keys = wrapper.findAll('input[type="password"]')
    await keys[1].setValue('sk-2')

    const testButton = wrapper.findAll('button').find((b) => b.text() === '一键测通')
    await testButton.trigger('click')
    await flushPromises()

    expect(window.electronAPI.relay.testKey).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.relay.testKey).toHaveBeenCalledWith({
      baseUrl: 'https://multi.example/v1',
      apiKey: 'sk-1',
    })
    expect(wrapper.findAll('span').filter((s) => s.text() === '✓ 12ms')).toHaveLength(2)
  })
})

describe('RelayPanel 日志', () => {
  let wrapper

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
    wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('no longer renders the request log section', () => {
    expect(wrapper.text()).not.toContain('请求日志')
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

    const numbers = wrapper.findAll('input[type="number"]').map((item) => item.element.value)
    // 0 是端口，1 是并发，2 是每分钟 RPM
    expect(numbers[1]).toBe('2')
    expect(numbers[2]).toBe('60')
  })

  it('keeps rpm at 0 when no cap is set', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await store.addProvider({ name: 'A', baseUrl: 'https://a' })
    await flushPromises()

    expect(wrapper.findAll('input[type="number"]')[2].element.value).toBe('0')
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

  it('applies per-model limits from the sensenova preset', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    await wrapper.find('select').setValue('sensenova')
    await flushPromises()

    const perModel = wrapper.findAll('label').find((item) => item.text().includes('按模型独立'))
    expect(perModel).toBeTruthy()
    expect(perModel.find('input[type="checkbox"]').element.checked).toBe(true)
    expect(wrapper.text()).toContain('deepseek-v4-flash')

    const add = wrapper.findAll('button').find((b) => b.text() === '添加提供商')
    await add.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].quota.perModel).toBe(true)
    expect(store.providers[0].quota.modelLimits['deepseek-v4-flash']).toEqual({
      limit5h: 150,
      limitWeek: 1500,
    })
    expect(store.providers[0].maxConcurrency).toBe(2)
    expect(store.providers[0].rpmLimit).toBe(15)
  })

  it('collapses extra shared groups until 显示更多 is clicked', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    const quotaLabel = wrapper.findAll('label').find((item) => item.text().includes('额度窗口'))
    await quotaLabel.find('input[type="checkbox"]').setValue(true)
    await flushPromises()

    // 初始没有组：只显示「新建组」按钮，不占一个空输入框
    expect(wrapper.find('input[placeholder="新组名，如 account-a"]').exists()).toBe(false)

    const addGroup = async (name) => {
      await wrapper
        .findAll('button')
        .find((b) => b.text() === '新建组')
        .trigger('click')
      await flushPromises()
      await wrapper.find('input[placeholder="新组名，如 account-a"]').setValue(name)
      await wrapper
        .findAll('button')
        .find((b) => b.text() === '确定')
        .trigger('click')
      await flushPromises()
    }
    const groupInputs = () => wrapper.findAll('input[title="修改组名会同步更新已加入该组的 Key"]')

    await addGroup('account-a')
    await addGroup('account-b')

    // 新增后自动展开，避免新组藏在折叠区外
    expect(groupInputs()).toHaveLength(2)

    const collapse = wrapper.findAll('button').find((b) => b.text() === '收起组')
    await collapse.trigger('click')
    expect(groupInputs()).toHaveLength(1)

    const more = wrapper.findAll('button').find((b) => b.text().includes('显示更多'))
    expect(more).toBeTruthy()
    expect(more.text()).toContain('2 个')
    await more.trigger('click')
    expect(groupInputs()).toHaveLength(2)
    expect(store.providers).toHaveLength(0)
  })

  it('manages shared groups and assigns keys to them', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRelayStore()
    const wrapper = mount(RelayPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    // 启用额度窗口后，API Key 区域才出现共享组组件
    const quotaLabel = wrapper.findAll('label').find((item) => item.text().includes('额度窗口'))
    await quotaLabel.find('input[type="checkbox"]').setValue(true)
    await flushPromises()

    // 新建一个组：点「新建组」才出现输入行，避免常驻空输入框
    const createGroupButton = wrapper.findAll('button').find((b) => b.text() === '新建组')
    await createGroupButton.trigger('click')
    await flushPromises()
    const groupNameInput = wrapper.find('input[placeholder="新组名，如 account-a"]')
    expect(groupNameInput.exists()).toBe(true)
    await groupNameInput.setValue('account-a')
    const createGroup = wrapper.findAll('button').find((b) => b.text() === '确定')
    await createGroup.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('account-a')

    // 添加第二把 Key，并把两把 Key 都放进新组
    const addKey = wrapper
      .findAll('button')
      .find((b) => b.attributes('title') === '增加一个 API Key 输入框')
    await addKey.trigger('click')
    await flushPromises()

    const keyInputs = wrapper.findAll('input[type="password"]')
    await keyInputs[0].setValue('sk-1')
    await keyInputs[1].setValue('sk-2')

    const groupSelects = wrapper.findAll('select').filter((item) => item.text().includes('未分组'))
    expect(groupSelects).toHaveLength(2)
    await groupSelects[0].setValue('account-a')
    await groupSelects[1].setValue('account-a')
    await flushPromises()

    // 组卡片显示成员数
    expect(wrapper.text()).toContain('2 把')

    await wrapper.find('input[placeholder="提供商名称"]').setValue('商汤')
    await wrapper
      .find('input[placeholder="https://api.example.com/v1"]')
      .setValue('https://token.sensenova.cn/v1')
    await wrapper.find('input[placeholder="模型名，如 gpt-4o"]').setValue('m')

    const add = wrapper.findAll('button').find((b) => b.text() === '添加提供商')
    await add.trigger('click')
    await flushPromises()

    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].quota.groups).toEqual(['account-a'])
    expect(store.providers[0].quota.keyGroups).toEqual({
      'sk-1': 'account-a',
      'sk-2': 'account-a',
    })
  })
})
