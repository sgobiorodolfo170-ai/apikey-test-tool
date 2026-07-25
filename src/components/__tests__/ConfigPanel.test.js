import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ConfigPanel from '../ConfigPanel.vue'

describe('ConfigPanel', () => {
  let wrapper

  beforeEach(() => {
    wrapper = mount(ConfigPanel, {
      global: {
        plugins: [createPinia()],
      },
    })
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
})
