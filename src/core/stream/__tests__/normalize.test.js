import { describe, expect, it } from 'vitest'
import { STREAM_EVENT_TYPES, isStreamDone, normalizeStreamEvent } from '../normalize.js'

describe('normalizeStreamEvent', () => {
  it('OpenAI delta', () => {
    const event = normalizeStreamEvent({ choices: [{ delta: { content: '你好' } }] }, 'openai')
    expect(event.type).toBe(STREAM_EVENT_TYPES.DELTA)
    expect(event.text).toBe('你好')
  })

  it('OpenAI usage（含 reasoning）', () => {
    const event = normalizeStreamEvent(
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
      'openai',
    )
    expect(event.type).toBe(STREAM_EVENT_TYPES.USAGE)
    expect(event.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 2,
    })
  })

  it('Anthropic content_block_delta', () => {
    const event = normalizeStreamEvent(
      { type: 'content_block_delta', delta: { text: '世界' } },
      'anthropic',
    )
    expect(event.type).toBe(STREAM_EVENT_TYPES.DELTA)
    expect(event.text).toBe('世界')
  })

  it('Anthropic message_start usage', () => {
    const event = normalizeStreamEvent(
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      'anthropic',
    )
    expect(event.type).toBe(STREAM_EVENT_TYPES.USAGE)
    expect(event.usage.inputTokens).toBe(3)
  })

  it('Anthropic error 事件', () => {
    const event = normalizeStreamEvent(
      { type: 'error', error: { message: 'overloaded' } },
      'anthropic',
    )
    expect(event.type).toBe(STREAM_EVENT_TYPES.ERROR)
    expect(event.message).toBe('overloaded')
  })

  it('Gemini parts 文本与 usageMetadata', () => {
    const delta = normalizeStreamEvent(
      { candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] },
      'gemini',
    )
    expect(delta.type).toBe(STREAM_EVENT_TYPES.DELTA)
    expect(delta.text).toBe('AB')

    const usage = normalizeStreamEvent(
      {
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
      },
      'gemini',
    )
    expect(usage.type).toBe(STREAM_EVENT_TYPES.USAGE)
    expect(usage.usage.totalTokens).toBe(10)
  })

  it('Ollama message.content 与 done', () => {
    const delta = normalizeStreamEvent({ message: { content: 'ok' } }, 'ollama')
    expect(delta.type).toBe(STREAM_EVENT_TYPES.DELTA)

    const done = normalizeStreamEvent({ done: true }, 'ollama')
    expect(done.type).toBe(STREAM_EVENT_TYPES.DONE)
  })

  it('Responses output_text.delta 与 response.completed', () => {
    const delta = normalizeStreamEvent(
      { type: 'response.output_text.delta', delta: 'x' },
      'responses',
    )
    expect(delta.type).toBe(STREAM_EVENT_TYPES.DELTA)

    const usage = normalizeStreamEvent(
      { type: 'response.completed', response: { usage: { total_tokens: 9 } } },
      'responses',
    )
    expect(usage.type).toBe(STREAM_EVENT_TYPES.USAGE)
    expect(usage.usage.totalTokens).toBe(9)
  })

  it('未知协议回退 OpenAI 形状', () => {
    const event = normalizeStreamEvent({ choices: [{ delta: { content: 'z' } }] }, 'unknown')
    expect(event.type).toBe(STREAM_EVENT_TYPES.DELTA)
  })

  it('无效输入返回 null', () => {
    expect(normalizeStreamEvent(null, 'openai')).toBeNull()
    expect(normalizeStreamEvent('text', 'openai')).toBeNull()
    expect(normalizeStreamEvent({}, 'openai')).toBeNull()
  })
})

describe('isStreamDone', () => {
  it('识别 [DONE] / DONE', () => {
    expect(isStreamDone('[DONE]')).toBe(true)
    expect(isStreamDone('DONE')).toBe(true)
    expect(isStreamDone('data')).toBe(false)
    expect(isStreamDone('')).toBe(false)
  })
})
