import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RelayTokenChart from '../RelayTokenChart.vue'
import { useRelayStore } from '../../stores/relayStore.js'
import { dateKeyOf } from '../../utils/tokenChart.js'

function mountChart(pinia) {
  return mount(RelayTokenChart, {
    global: { plugins: [pinia] },
  })
}

describe('RelayTokenChart', () => {
  let wrapper
  let relayStore
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mountChart(pinia)
    relayStore = useRelayStore()
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  it('shows an empty hint without token history', () => {
    expect(wrapper.text()).toContain('还没有可展示的 token 数据')
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('renders a heat block per day plus one line per model', async () => {
    const today = dateKeyOf(new Date())
    relayStore.tokenHistory = [
      {
        date: today,
        prompt: 70,
        completion: 50,
        total: 120,
        calls: 2,
        models: [
          { model: 'model-a', total: 80, prompt: 50, completion: 30, calls: 1 },
          { model: 'model-b', total: 40, prompt: 20, completion: 20, calls: 1 },
        ],
      },
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.text()).toContain('合计 120 tokens')
    // 日统计：30 个连续时间片
    expect(wrapper.findAll('rect')).toHaveLength(30)
    // 两个模型各一条曲线（白色描边 + 彩色主线）
    expect(wrapper.findAll('polyline')).toHaveLength(4)
    expect(wrapper.text()).toContain('model-a')
    expect(wrapper.text()).toContain('model-b')
  })

  it('switches between day / week / month granularities', async () => {
    const today = dateKeyOf(new Date())
    relayStore.tokenHistory = [
      {
        date: today,
        total: 30,
        prompt: 20,
        completion: 10,
        calls: 1,
        models: [{ model: 'model-a', total: 30, prompt: 20, completion: 10, calls: 1 }],
      },
    ]
    await wrapper.vm.$nextTick()

    const weekButton = wrapper.findAll('button').find((button) => button.text().includes('周统计'))
    await weekButton.trigger('click')
    expect(wrapper.findAll('rect')).toHaveLength(12)

    const monthButton = wrapper.findAll('button').find((button) => button.text().includes('月统计'))
    await monthButton.trigger('click')
    expect(wrapper.findAll('rect')).toHaveLength(12)

    const dayButton = wrapper.findAll('button').find((button) => button.text().includes('日统计'))
    await dayButton.trigger('click')
    expect(wrapper.findAll('rect')).toHaveLength(30)
  })
})
