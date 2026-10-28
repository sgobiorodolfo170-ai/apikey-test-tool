import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../http.js', () => ({
  default: {
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: {} })),
    stream: vi.fn(async () => ({ status: 200 })),
  },
}))

import http from '../http.js'
import { sendOpenAIChat } from '../openai.js'
import { sendAnthropicChat } from '../anthropic.js'
import { sendGeminiChat } from '../gemini.js'
import { sendOllamaChat } from '../ollama.js'

const PNG = 'data:image/png;base64,AAAA'

const config = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  apiMode: 'openai',
}

const messages = [
  { role: 'user', content: '这张图里是什么？', images: [{ dataUrl: PNG, name: 'a.png' }] },
]

function lastBody() {
  return http.post.mock.calls.at(-1)[1]
}

describe('多模态请求体适配', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('OpenAI：content 变成 text + image_url 数组', async () => {
    await sendOpenAIChat(config, { model: 'gpt-4o', messages })

    expect(lastBody().messages[0].content).toEqual([
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image_url', image_url: { url: PNG } },
    ])
  })

  it('Anthropic：content 变成 image block + text block', async () => {
    await sendAnthropicChat({ ...config, apiMode: 'anthropic' }, { model: 'claude', messages })

    expect(lastBody().messages[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
      { type: 'text', text: '这张图里是什么？' },
    ])
  })

  it('Gemini：parts 里带 inline_data', async () => {
    await sendGeminiChat({ ...config, apiMode: 'gemini' }, { model: 'gemini-1.5-pro', messages })

    expect(lastBody().contents[0].parts).toEqual([
      { text: '这张图里是什么？' },
      { inline_data: { mime_type: 'image/png', data: 'AAAA' } },
    ])
  })

  it('Ollama：图片放进独立的 images 数组且去掉前缀', async () => {
    await sendOllamaChat({ ...config, apiMode: 'ollama' }, { model: 'llava', messages })

    expect(lastBody().messages[0]).toEqual({
      role: 'user',
      content: '这张图里是什么？',
      images: ['AAAA'],
    })
  })

  it('没有图片时保持原来的字符串 content', async () => {
    await sendOpenAIChat(config, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '纯文字' }],
    })

    expect(lastBody().messages[0].content).toBe('纯文字')
  })
})
