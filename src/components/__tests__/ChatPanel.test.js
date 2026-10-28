import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const prepareImage = vi.fn(async (file) => ({
  dataUrl: 'data:image/png;base64,AAAA',
  name: file.name,
  bytes: 3,
}))

vi.mock('../../utils/image.js', () => ({ prepareImage: (...args) => prepareImage(...args) }))

const chatMock = vi.fn(async () => '我看到了图片')

vi.mock('../../api/modes.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getApiAdapter: vi.fn(() => ({ chat: chatMock })),
  }
})

import ChatPanel from '../ChatPanel.vue'
import { useTestStore } from '../../stores/testStore.js'
import { useChatStore } from '../../stores/chatStore.js'
import { useToastStore } from '../../stores/toastStore.js'

function makeFile(name = 'cat.png', type = 'image/png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

async function mountPanel(mode = 'openai') {
  const pinia = createPinia()
  setActivePinia(pinia)

  const testStore = useTestStore()
  testStore.setCurrentResult({
    connected: true,
    connectTime: 10,
    config: { baseUrl: 'https://api.test/v1', apiMode: mode, apiKey: 'sk' },
    models: [{ model: 'gpt-4o', status: 'success', latency: 100 }],
  })

  const wrapper = mount(ChatPanel, { global: { plugins: [pinia] } })
  await flushPromises()

  // 选中模型
  await wrapper.find('select').setValue('gpt-4o')
  return { wrapper, testStore }
}

describe('ChatPanel 图片输入', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prepareImage.mockImplementation(async (file) => ({
      dataUrl: 'data:image/png;base64,AAAA',
      name: file.name,
      bytes: 3,
    }))
  })

  it('renders the image button and a hidden file input', async () => {
    const { wrapper } = await mountPanel()

    expect(wrapper.find('input[type="file"]').exists()).toBe(true)
    expect(wrapper.find('input[type="file"]').attributes('accept')).toContain('image/png')
    expect(wrapper.findAll('button').some((b) => b.text() === '🖼')).toBe(true)
  })

  it('adds picked images to the attachment strip', async () => {
    const { wrapper } = await mountPanel()

    await wrapper.vm.onFilesPicked({ target: { files: [makeFile('a.png')], value: '' } })
    await flushPromises()

    expect(wrapper.vm.attachments).toHaveLength(1)
    expect(wrapper.vm.attachments[0].name).toBe('a.png')
    expect(wrapper.find('img[alt="a.png"]').exists()).toBe(true)
  })

  it('caps attachments at four images', async () => {
    const { wrapper } = await mountPanel()

    await wrapper.vm.onFilesPicked({
      target: {
        files: [
          makeFile('1.png'),
          makeFile('2.png'),
          makeFile('3.png'),
          makeFile('4.png'),
          makeFile('5.png'),
        ],
        value: '',
      },
    })
    await flushPromises()

    expect(wrapper.vm.attachments).toHaveLength(4)
  })

  it('shows a toast instead of throwing when the image is invalid', async () => {
    const { wrapper } = await mountPanel()
    prepareImage.mockRejectedValueOnce(new Error('不支持的图片格式：image/bmp'))

    await wrapper.vm.onFilesPicked({
      target: { files: [makeFile('a.bmp', 'image/bmp')], value: '' },
    })
    await flushPromises()

    expect(wrapper.vm.attachments).toHaveLength(0)
    expect(useToastStore().toasts.at(-1).message).toContain('不支持的图片格式')
  })

  it('removes an attachment', async () => {
    const { wrapper } = await mountPanel()
    await wrapper.vm.onFilesPicked({ target: { files: [makeFile('a.png')], value: '' } })
    await flushPromises()

    wrapper.vm.removeAttachment(0)
    await flushPromises()

    expect(wrapper.vm.attachments).toHaveLength(0)
  })

  it('sends the image with the user message and keeps it in history', async () => {
    const { wrapper } = await mountPanel()
    const chatStore = useChatStore()

    await wrapper.vm.onFilesPicked({ target: { files: [makeFile('cat.png')], value: '' } })
    await flushPromises()
    wrapper.vm.chatInput = '这是什么'
    await wrapper.vm.sendMessage()
    await flushPromises()

    const userMessage = chatStore.messages[0]
    expect(userMessage.role).toBe('user')
    expect(userMessage.content).toBe('这是什么')
    expect(userMessage.images).toHaveLength(1)

    const payload = chatMock.mock.calls[0][1]
    expect(payload.messages[0].images).toHaveLength(1)
    expect(chatStore.messages[1].content).toBe('我看到了图片')
  })

  it('allows sending an image without any text', async () => {
    const { wrapper } = await mountPanel()
    const chatStore = useChatStore()

    await wrapper.vm.onFilesPicked({ target: { files: [makeFile('cat.png')], value: '' } })
    await flushPromises()
    await wrapper.vm.sendMessage()
    await flushPromises()

    expect(chatMock).toHaveBeenCalled()
    expect(chatStore.messages[0].content).toBe('')
    expect(chatStore.messages[0].images).toHaveLength(1)
  })

  it('blocks images in modes without vision support', async () => {
    const { wrapper } = await mountPanel('openai-image')
    const chatStore = useChatStore()

    await wrapper.vm.onFilesPicked({ target: { files: [makeFile('cat.png')], value: '' } })
    await flushPromises()
    wrapper.vm.chatInput = '看图'
    await wrapper.vm.sendMessage()
    await flushPromises()

    expect(chatMock).not.toHaveBeenCalled()
    expect(chatStore.messages).toHaveLength(0)
    expect(useToastStore().toasts.at(-1).message).toContain('不支持图片输入')
    // 附件保留，方便用户切换模式后重发
    expect(wrapper.vm.attachments).toHaveLength(1)
  })
})
