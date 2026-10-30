import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EvalPanel from '../EvalPanel.vue'
import { useTestStore } from '../../stores/testStore.js'

describe('EvalPanel', () => {
  let wrapper
  let testStore

  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(EvalPanel, { global: { plugins: [pinia] } })
    testStore = useTestStore()
  })

  it('should not render its own card chrome (title lives on the parent tab)', () => {
    expect(wrapper.find('.card').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模型测评')
  })

  it('should show a hint when there is no tested config', () => {
    expect(wrapper.text()).toContain('请先在「配置」面板填写并测试连接')
  })

  it('should show model options once models are available and config exists', async () => {
    testStore.setCurrentResult({
      connected: true,
      config: { baseUrl: 'https://api.test/v1', apiMode: 'openai', apiKey: 'sk' },
      models: [{ model: 'gpt-4o', status: 'success' }],
    })
    testStore.setAvailableModels(['gpt-4o', 'gpt-4o-mini'])
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.config).toBeTruthy()
    expect(wrapper.vm.modelOptions).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(wrapper.findAll('button').length).toBeGreaterThanOrEqual(2)
  })

  it('should switch between fingerprint, capability, stability and checkup tabs', async () => {
    testStore.setCurrentResult({
      connected: true,
      config: { baseUrl: 'https://api.test/v1', apiMode: 'openai', apiKey: 'sk' },
      models: [{ model: 'gpt-4o', status: 'success' }],
    })
    testStore.setAvailableModels(['gpt-4o'])
    await wrapper.vm.$nextTick()

    const buttonTexts = () => wrapper.findAll('button').map((b) => b.text())

    expect(buttonTexts()).toContain('开始指纹匹配')
    expect(buttonTexts()).not.toContain('开始能力测评')

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '能力')
      .trigger('click')
    await wrapper.vm.$nextTick()
    expect(buttonTexts()).toContain('开始能力测评')
    expect(buttonTexts()).not.toContain('开始指纹匹配')

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '稳定')
      .trigger('click')
    await wrapper.vm.$nextTick()
    expect(buttonTexts()).toContain('开始稳定性测试')

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '一致')
      .trigger('click')
    await wrapper.vm.$nextTick()
    expect(buttonTexts()).toContain('开始一致性探测')

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '体检')
      .trigger('click')
    await wrapper.vm.$nextTick()
    expect(buttonTexts()).toContain('开始体检')

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '指纹')
      .trigger('click')
    await wrapper.vm.$nextTick()
    expect(buttonTexts()).toContain('开始指纹匹配')
  })
})
