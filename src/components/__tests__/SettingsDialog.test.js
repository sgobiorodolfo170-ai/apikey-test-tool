import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsDialog from '../SettingsDialog.vue'

let pinia

function mountDialog(open = true) {
  return mount(SettingsDialog, {
    props: { open },
    global: { plugins: [pinia] },
  })
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    window.electronAPI = {
      getDataDir: vi.fn(async () => ({ ok: true, dataDir: 'D:/apkey/data' })),
      chooseDataDir: vi.fn(async () => ({ ok: true, dataDir: 'E:/apkey/data' })),
    }
  })

  afterEach(() => {
    delete window.electronAPI
  })

  it('renders the current data directory', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('数据目录')
    expect(wrapper.text()).toContain('D:/apkey/data')
    wrapper.unmount()
  })

  it('emits close from the close button and the mask', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.find('button[title="关闭"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()

    await wrapper.find('.fixed.inset-0').trigger('click')
    expect(wrapper.emitted('close').length).toBe(2)
    wrapper.unmount()
  })

  it('switches the data directory through the bridge', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const button = wrapper.findAll('button').find((b) => b.text().includes('更改目录'))
    expect(button).toBeTruthy()
    await button.trigger('click')
    await flushPromises()

    expect(window.electronAPI.chooseDataDir).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('E:/apkey/data')
    wrapper.unmount()
  })

  it('does not render when closed', () => {
    const wrapper = mountDialog(false)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
