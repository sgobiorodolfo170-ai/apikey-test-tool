import { describe, it, expect } from 'vitest'
import {
  parseDataUrl,
  hasImages,
  toOpenAIContent,
  toResponsesContent,
  toAnthropicContent,
  toGeminiParts,
  toOllamaMessage,
  estimateBase64Bytes,
} from '../multimodal.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

describe('parseDataUrl', () => {
  it('extracts mime type and base64 payload', () => {
    expect(parseDataUrl(PNG)).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' })
  })

  it('returns null for non data urls', () => {
    expect(parseDataUrl('https://example.com/a.png')).toBeNull()
    expect(parseDataUrl('')).toBeNull()
    expect(parseDataUrl(null)).toBeNull()
  })
})

describe('hasImages', () => {
  it('detects an images array', () => {
    expect(hasImages({ images: [{ dataUrl: PNG }] })).toBe(true)
    expect(hasImages({ images: [] })).toBe(false)
    expect(hasImages({})).toBe(false)
  })
})

describe('toOpenAIContent', () => {
  it('keeps plain text as a string when there is no image', () => {
    expect(toOpenAIContent({ content: '你好' })).toBe('你好')
  })

  it('builds text + image_url parts', () => {
    const content = toOpenAIContent({
      content: '这是什么？',
      images: [{ dataUrl: PNG, name: 'a.png' }],
    })

    expect(content).toEqual([
      { type: 'text', text: '这是什么？' },
      { type: 'image_url', image_url: { url: PNG } },
    ])
  })

  it('skips invalid images but keeps text', () => {
    const content = toOpenAIContent({ content: '看', images: [{ dataUrl: 'bad' }] })
    expect(content).toBe('看')
  })
})

describe('toResponsesContent', () => {
  it('uses input_text / input_image', () => {
    const content = toResponsesContent({ content: 'hi', images: [{ dataUrl: JPG }] })
    expect(content).toEqual([
      { type: 'input_text', text: 'hi' },
      { type: 'input_image', image_url: JPG },
    ])
  })
})

describe('toAnthropicContent', () => {
  it('puts images first as base64 blocks, then text', () => {
    const content = toAnthropicContent({ content: '描述', images: [{ dataUrl: PNG }] })
    expect(content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
      },
      { type: 'text', text: '描述' },
    ])
  })

  it('returns a plain string without images', () => {
    expect(toAnthropicContent({ content: '只有文字' })).toBe('只有文字')
  })
})

describe('toGeminiParts', () => {
  it('builds inline_data parts', () => {
    const parts = toGeminiParts({ content: '看图', images: [{ dataUrl: PNG }] })
    expect(parts).toEqual([
      { text: '看图' },
      { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
    ])
  })

  it('never returns an empty parts array', () => {
    expect(toGeminiParts({ content: '' })).toEqual([{ text: '' }])
  })
})

describe('toOllamaMessage', () => {
  it('strips the data url prefix for the images array', () => {
    const message = toOllamaMessage({
      role: 'user',
      content: '识别',
      images: [{ dataUrl: PNG }],
    })

    expect(message).toEqual({
      role: 'user',
      content: '识别',
      images: ['iVBORw0KGgoAAAANSUhEUg=='],
    })
  })

  it('omits the images field entirely when there is no image', () => {
    const message = toOllamaMessage({ role: 'user', content: 'hi' })
    expect(message).toEqual({ role: 'user', content: 'hi' })
    expect('images' in message).toBe(false)
  })
})

describe('estimateBase64Bytes', () => {
  it('accounts for padding', () => {
    expect(estimateBase64Bytes('')).toBe(0)
    expect(estimateBase64Bytes('AAAA')).toBe(3)
    expect(estimateBase64Bytes('AAA=')).toBe(2)
    expect(estimateBase64Bytes('AA==')).toBe(1)
  })
})
