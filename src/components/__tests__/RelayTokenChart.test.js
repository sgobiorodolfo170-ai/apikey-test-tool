import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RelayTokenChart from '../RelayTokenChart.vue'
import { useRelayStore } from '../../stores/relayStore.js'
import { dateKeyOf, hourKeyOf } from '../../utils/tokenChart.js'

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

  it('renders hour statistics by default and switches to day', async () => {
    const today = dateKeyOf(new Date())
    const models = [
      { model: 'model-a', total: 80, prompt: 50, completion: 30, calls: 1 },
      { model: 'model-b', total: 40, prompt: 20, completion: 20, calls: 1 },
    ]
    relayStore.tokenHourly = [
      {
        hour: hourKeyOf(new Date()),
        prompt: 70,
        completion: 50,
        total: 120,
        calls: 2,
        models,
      },
    ]
    relayStore.tokenHistory = [
      {
        date: today,
        prompt: 70,
        completion: 50,
        total: 120,
        calls: 2,
        models,
      },
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.text()).toContain('合计 120 tokens')
    // 默认时统计：24 个连续时间片
    expect(wrapper.findAll('rect')).toHaveLength(24)
    expect(wrapper.findAll('polyline')).toHaveLength(4)
    expect(wrapper.text()).toContain('model-a')
    expect(wrapper.text()).toContain('model-b')

    const dayButton = wrapper.findAll('button').find((button) => button.text().includes('日统计'))
    await dayButton.trigger('click')
    expect(wrapper.findAll('rect')).toHaveLength(30)
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

  it('supports hour statistics and shows model totals on legend hover', async () => {
    const now = new Date()
    relayStore.tokenHourly = [
      {
        hour: hourKeyOf(now),
        prompt: 30,
        completion: 20,
        total: 50,
        calls: 1,
        models: [{ model: 'model-a', prompt: 30, completion: 20, total: 50, calls: 1 }],
      },
    ]
    await wrapper.vm.$nextTick()

    const hourButton = wrapper.findAll('button').find((button) => button.text().includes('时统计'))
    await hourButton.trigger('click')
    expect(wrapper.findAll('rect')).toHaveLength(24)

    const legend = wrapper
      .findAll('span')
      .find((span) => span.attributes('title')?.includes('合计 50 tokens'))
    expect(legend).toBeTruthy()
    expect(legend.attributes('title')).toContain('1 次调用')
  })

  it('pans the chart to older data and returns to latest', async () => {
    const today = dateKeyOf(new Date())
    relayStore.tokenHistory = [
      {
        date: today,
        prompt: 20,
        completion: 10,
        total: 30,
        calls: 1,
        models: [{ model: 'model-a', prompt: 20, completion: 10, total: 30, calls: 1 }],
      },
    ]
    await wrapper.vm.$nextTick()

    // 默认时统计没有小时数据，切到日统计后测试 400 天历史平移
    const dayButton = wrapper.findAll('button').find((button) => button.text().includes('日统计'))
    await dayButton.trigger('click')

    const lastTitle = () => wrapper.findAll('title').at(-1).text()
    const before = lastTitle()
    expect(before).toContain(today)

    wrapper.vm.onDragStart({ clientX: 500 })
    wrapper.vm.onDragMove({ clientX: 800 })
    wrapper.vm.onDragEnd({})
    await wrapper.vm.$nextTick()

    const after = lastTitle()
    expect(after).not.toBe(before)
    expect(after).not.toContain(today)
    expect(wrapper.text()).toContain('回到最新')

    const backButton = wrapper.findAll('button').find((button) => button.text() === '回到最新')
    await backButton.trigger('click')
    expect(lastTitle()).toBe(before)
  })
})
