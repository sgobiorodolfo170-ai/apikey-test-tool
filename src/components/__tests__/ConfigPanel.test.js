import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 组件会触发真实的模型列表拉取，必须挡住网络，否则测试会卡在 DNS/连接上
vi.mock('axios')

vi.mock('../../utils/storage.js', () => ({
  readProviders: vi.fn(() => Promise.resolve([])),
  readProviderSettings: vi.fn(() => Promise.resolve(null)),
  readHistory: vi.fn(() => Promise.resolve([])),
}))

import ConfigPanel from '../ConfigPanel.vue'
import { useTestStore } from '../../stores/testStore.js'
import { useUpdateStore } from '../../stores/updateStore.js'
import { readProviders, readProviderSettings, readHistory } from '../../utils/storage.js'

describe('ConfigPanel', () => {
  let wrapper
  let testStore

  beforeEach(() => {
    vi.clearAllMocks()
    readProviders.mockResolvedValue([])
    readProviderSettings.mockResolvedValue(null)
    readHistory.mockResolvedValue([])

    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(ConfigPanel, {
      global: {
        plugins: [pinia],
        stubs: {
          teleport: true,
        },
      },
    })
    testStore = useTestStore()
  })

  it('should render the form fields', () => {
    expect(wrapper.text()).toContain('提供商名称')
    expect(wrapper.text()).toContain('API 模式')
    expect(wrapper.text()).toContain('Base URL')
    expect(wrapper.text()).toContain('API Key')
  })

  it('should have default API mode as openai', () => {
    const select = wrapper.find('select')
    expect(select.element.value).toBe('openai')
  })

  it('should have empty default Base URL', () => {
    expect(wrapper.vm.config.baseUrl).toBe('')
  })

  it('should have test button disabled when config is empty', () => {
    const btn = wrapper.findAll('button').filter((b) => b.text() === '开始测试')
    expect(btn.length).toBe(1)
  })

  it('should render API mode options', () => {
    const options = wrapper.findAll('option')
    const optionTexts = options.map((o) => o.text())
    expect(optionTexts).toContain('OpenAI')
    expect(optionTexts).toContain('Anthropic')
    expect(optionTexts).toContain('OpenAI-like')
    expect(optionTexts).toContain('OpenAI Responses')
    expect(optionTexts).toContain('Azure OpenAI')
    expect(optionTexts).toContain('Google Gemini')
    expect(optionTexts).toContain('Ollama')
    expect(optionTexts).toContain('Jev (TypeSafe)')
    expect(optionTexts).toContain('OpenAI 图片')
    expect(optionTexts).toContain('OpenAI 语音')
  })

  it('should fill inputs and enable test button', async () => {
    const providerInput = wrapper.find('input[placeholder="选择或输入提供商"]')
    await providerInput.setValue('test-provider')

    const urlInput = wrapper.find('input[placeholder="https://api.openai.com/v1"]')
    await urlInput.setValue('https://api.openai.com/v1')

    const keyInput = wrapper.find('input[placeholder="sk-..."]')
    await keyInput.setValue('sk-test')

    wrapper.vm.config.baseUrl = 'https://api.openai.com/v1'
    wrapper.vm.config.apiKey = 'sk-test'
    await wrapper.vm.$nextTick()

    const testBtn = wrapper.findAll('button').filter((b) => b.text() === '开始测试')
    expect(testBtn[0].attributes('disabled')).toBeUndefined()
  })

  it('should render single model test section', () => {
    expect(wrapper.text()).toContain('指定模型测试')
    expect(wrapper.text()).toContain('测试该模型')
    expect(wrapper.find('input[placeholder="从检测出的模型中选择或手动输入"]').exists()).toBe(true)
    expect(
      wrapper.findAll('button').filter((b) => b.attributes('title') === '展开模型列表').length,
    ).toBe(1)
  })

  it('should show loading state while fetching models', async () => {
    testStore.isFetchingModels = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('正在获取模型列表')
  })

  it('should show detection failure reason', async () => {
    testStore.modelsError = 'API Key无效或未授权 (HTTP 401)'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('API Key无效或未授权 (HTTP 401)')
  })

  it('should retry model detection from refresh button', async () => {
    const spy = vi.spyOn(testStore, 'fetchModels').mockResolvedValue()
    wrapper.vm.config.baseUrl = 'https://api.openai.com/v1'
    wrapper.vm.config.apiKey = 'sk-test'
    await wrapper.vm.$nextTick()

    const btn = wrapper.findAll('button').filter((b) => b.text() === '重新获取')
    expect(btn.length).toBe(1)
    expect(btn[0].attributes('disabled')).toBeUndefined()

    await btn[0].trigger('click')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('should disable single model test button when no model specified', () => {
    const btn = wrapper.findAll('button').filter((b) => b.text() === '测试该模型')
    expect(btn.length).toBe(1)
    expect(btn[0].attributes('disabled')).toBeDefined()
  })

  it('should enable single model test button after specifying a model', async () => {
    wrapper.vm.config.baseUrl = 'https://api.openai.com/v1'
    wrapper.vm.config.apiKey = 'sk-test'
    wrapper.vm.modelToTest = 'gpt-4'
    await wrapper.vm.$nextTick()

    const btn = wrapper.findAll('button').filter((b) => b.text() === '测试该模型')
    expect(btn[0].attributes('disabled')).toBeUndefined()
  })

  it('should call testSingleModel when quick test on a detected model is clicked', async () => {
    const spy = vi.spyOn(testStore, 'testSingleModel').mockResolvedValue({ success: true })
    testStore.setAvailableModels(['gpt-4', 'gpt-3.5-turbo'])
    await wrapper.vm.$nextTick()

    wrapper.vm.config.baseUrl = 'https://api.openai.com/v1'
    wrapper.vm.config.apiKey = 'sk-test'
    await wrapper.vm.$nextTick()

    const quickTest = wrapper.findAll('span').filter((s) => s.text() === '⚡')
    expect(quickTest.length).toBe(2)

    await quickTest[0].trigger('click')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }),
      'gpt-4',
    )
  })

  it('should call testSingleModel from the specify-model input', async () => {
    const spy = vi.spyOn(testStore, 'testSingleModel').mockResolvedValue({ success: true })
    wrapper.vm.config.baseUrl = 'https://api.openai.com/v1'
    wrapper.vm.config.apiKey = 'sk-test'
    wrapper.vm.modelToTest = '  gpt-4  '
    await wrapper.vm.$nextTick()

    const btn = wrapper.findAll('button').filter((b) => b.text() === '测试该模型')
    await btn[0].trigger('click')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'gpt-4')
  })

  it('should fill the specify-model input when a detected model is clicked', async () => {
    testStore.setAvailableModels(['gpt-4'])
    await wrapper.vm.$nextTick()

    const nameSpan = wrapper.findAll('span').find((s) => s.text() === 'gpt-4')
    expect(nameSpan).toBeDefined()
    await nameSpan.trigger('click')

    expect(wrapper.vm.modelToTest).toBe('gpt-4')
  })

  it('should fill the specify-model input when quick testing a detected model', async () => {
    const spy = vi.spyOn(testStore, 'testSingleModel').mockResolvedValue({ success: true })
    testStore.setAvailableModels(['gpt-4'])
    wrapper.vm.config.baseUrl = 'https://api.openai.com/v1'
    wrapper.vm.config.apiKey = 'sk-test'
    await wrapper.vm.$nextTick()

    const quickTest = wrapper.findAll('span').filter((s) => s.text() === '⚡')
    await quickTest[0].trigger('click')

    expect(wrapper.vm.modelToTest).toBe('gpt-4')
    expect(spy).toHaveBeenCalled()
  })

  it('should autofill base url and api mode when a saved provider is selected', async () => {
    vi.spyOn(testStore, 'fetchModels').mockResolvedValue()
    readProviderSettings.mockResolvedValue({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiMode: 'gemini',
    })

    const input = wrapper.find('input[placeholder="选择或输入提供商"]')
    await input.setValue('my-gemini')
    await input.trigger('change')
    await flushPromises()

    expect(readProviderSettings).toHaveBeenCalledWith('my-gemini')
    expect(wrapper.vm.config.baseUrl).toBe('https://generativelanguage.googleapis.com')
    expect(wrapper.vm.config.apiMode).toBe('gemini')
  })

  it('should refresh the saved provider list after saving a result', async () => {
    const saveSpy = vi.spyOn(testStore, 'saveResult').mockResolvedValue()
    testStore.hasResult = true
    readProviders.mockResolvedValue(['prov-a', 'prov-b'])

    await wrapper.vm.onSave()
    await flushPromises()

    expect(saveSpy).toHaveBeenCalled()
    expect(wrapper.vm.savedProviders).toEqual(['prov-a', 'prov-b'])
  })

  it('should allow testing without api key in ollama mode', async () => {
    vi.spyOn(testStore, 'fetchModels').mockResolvedValue()
    wrapper.vm.config.baseUrl = 'http://localhost:11434'
    wrapper.vm.config.apiMode = 'ollama'
    await wrapper.vm.$nextTick()

    const testBtn = wrapper.findAll('button').filter((b) => b.text() === '开始测试')
    expect(testBtn[0].attributes('disabled')).toBeUndefined()
  })

  it('should list all detected models when the model dropdown is opened', async () => {
    testStore.setAvailableModels(['gpt-4', 'gpt-4o'])
    await wrapper.vm.$nextTick()

    const toggle = wrapper.findAll('button').filter((b) => b.attributes('title') === '展开模型列表')
    expect(toggle.length).toBe(1)
    await toggle[0].trigger('mousedown')
    await wrapper.vm.$nextTick()

    const options = wrapper
      .findAll('button')
      .filter((b) => ['gpt-4', 'gpt-4o'].includes(b.text().trim()))
    expect(options.length).toBe(2)

    await options[0].trigger('click')
    expect(wrapper.vm.modelToTest).toBe('gpt-4')
    expect(wrapper.vm.modelDropdown.visible).toBe(false)
  })

  it('should list saved providers when the provider dropdown is opened', async () => {
    readProviders.mockResolvedValue(['prov-a', 'prov-b'])
    await wrapper.vm.loadSavedProviders()
    await flushPromises()

    const toggle = wrapper
      .findAll('button')
      .filter((b) => b.attributes('title') === '展开提供商列表')
    expect(toggle.length).toBe(1)
    await toggle[0].trigger('mousedown')
    await wrapper.vm.$nextTick()

    const options = wrapper
      .findAll('button')
      .filter((b) => ['prov-a', 'prov-b'].includes(b.text().trim()))
    expect(options.length).toBe(2)

    readProviderSettings.mockResolvedValue({
      baseUrl: 'https://api.test.com',
      apiMode: 'anthropic',
    })
    await options[0].trigger('click')
    await flushPromises()

    expect(wrapper.vm.config.provider).toBe('prov-a')
    expect(wrapper.vm.config.baseUrl).toBe('https://api.test.com')
    expect(wrapper.vm.config.apiMode).toBe('anthropic')
    expect(wrapper.vm.providerDropdown.visible).toBe(false)
  })

  it('should include providers from history records in the provider menu', async () => {
    readProviders.mockResolvedValue(['prov-a'])
    readHistory.mockResolvedValue([
      { config: { provider: 'prov-a', baseUrl: 'https://a.com', apiMode: 'openai' } },
      { config: { provider: 'prov-c', baseUrl: 'https://c.com', apiMode: 'gemini' } },
    ])

    await wrapper.vm.loadSavedProviders()
    await flushPromises()

    expect(wrapper.vm.savedProviders).toEqual(['prov-a', 'prov-c'])
  })

  it('should load config from the latest history record when selecting a provider without saved settings', async () => {
    readProviders.mockResolvedValue(['hist-prov'])
    readProviderSettings.mockResolvedValue(null)
    readHistory.mockResolvedValue([
      {
        config: {
          provider: 'hist-prov',
          baseUrl: 'https://hist.com',
          apiMode: 'anthropic',
          apiKey: 'sk-hist',
        },
      },
    ])
    await wrapper.vm.loadSavedProviders()
    await flushPromises()

    const toggle = wrapper
      .findAll('button')
      .filter((b) => b.attributes('title') === '展开提供商列表')
    await toggle[0].trigger('mousedown')
    await wrapper.vm.$nextTick()

    const option = wrapper.findAll('button').find((b) => b.text().trim() === 'hist-prov')
    await option.trigger('click')
    await flushPromises()

    expect(wrapper.vm.config.baseUrl).toBe('https://hist.com')
    expect(wrapper.vm.config.apiMode).toBe('anthropic')
    expect(wrapper.vm.config.apiKey).toBe('sk-hist')
  })

  it('should load api key from history even when saved settings exist', async () => {
    readProviders.mockResolvedValue(['prov-a'])
    readProviderSettings.mockResolvedValue({
      baseUrl: 'https://settings.com',
      apiMode: 'openai',
    })
    readHistory.mockResolvedValue([
      {
        config: {
          provider: 'prov-a',
          baseUrl: 'https://settings.com',
          apiMode: 'openai',
          apiKey: 'sk-from-history',
        },
      },
    ])
    await wrapper.vm.loadSavedProviders()
    await flushPromises()

    const toggle = wrapper
      .findAll('button')
      .filter((b) => b.attributes('title') === '展开提供商列表')
    await toggle[0].trigger('mousedown')
    await wrapper.vm.$nextTick()

    const option = wrapper.findAll('button').find((b) => b.text().trim() === 'prov-a')
    await option.trigger('click')
    await flushPromises()

    expect(wrapper.vm.config.baseUrl).toBe('https://settings.com')
    expect(wrapper.vm.config.apiMode).toBe('openai')
    expect(wrapper.vm.config.apiKey).toBe('sk-from-history')
  })
})

describe('ConfigPanel 版本与更新', () => {
  let wrapper
  let updateStore

  beforeEach(async () => {
    vi.clearAllMocks()
    const pinia = createPinia()
    setActivePinia(pinia)
    updateStore = useUpdateStore()
    wrapper = mount(ConfigPanel, { global: { plugins: [pinia] } })
    await flushPromises()
  })

  it('always shows the current version next to the title', () => {
    expect(wrapper.text()).toContain(`v${updateStore.currentVersion}`)
  })

  it('hides the update button when already up to date', () => {
    expect(wrapper.findAll('button').some((b) => b.text().includes('更新'))).toBe(false)
  })

  it('shows the update button when a newer release exists', async () => {
    updateStore.latest = { version: '99.0.0', url: 'https://github.com/x/y/releases/tag/v99.0.0' }
    await wrapper.vm.$nextTick()

    const updateButton = wrapper.findAll('button').find((b) => b.text().includes('更新'))
    expect(updateButton).toBeTruthy()
    expect(updateButton.attributes('title')).toContain('99.0.0')
  })

  it('opens the release page through the bridge', async () => {
    const openExternal = vi.fn(async () => ({ success: true }))
    window.electronAPI = { ...(window.electronAPI || {}), openExternal }
    updateStore.latest = { version: '99.0.0', url: 'https://github.com/x/y/releases/tag/v99.0.0' }
    await wrapper.vm.$nextTick()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('更新'))
      .trigger('click')

    expect(openExternal).toHaveBeenCalledWith('https://github.com/x/y/releases/tag/v99.0.0')
  })
})

describe('ConfigPanel 内嵌测试结果', () => {
  it('renders the result section below the form', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConfigPanel, { global: { plugins: [pinia] } })
    await flushPromises()

    expect(wrapper.text()).toContain('暂无测试结果')
    // 结果区嵌在配置卡片里，不应再出现独立的 card 容器
    expect(wrapper.findAll('.card')).toHaveLength(1)
  })
})
