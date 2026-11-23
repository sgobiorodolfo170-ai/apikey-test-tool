import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  anthropicToOpenAI,
  openAIToAnthropic,
  createAnthropicSseTransform,
  aggregateOpenAIStream,
  normalizeContent,
  mapStopReason,
} = require('../../electron/gateway/adapters/anthropic.cjs')

function parseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      const event = lines
        .find((l) => l.startsWith('event:'))
        ?.slice(6)
        .trim()
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      return { event, data: data ? JSON.parse(data) : null }
    })
}

describe('anthropicToOpenAI', () => {
  it('system 字符串与消息归一为 OpenAI messages', () => {
    const out = anthropicToOpenAI({
      model: 'claude-3',
      system: '你是助手',
      max_tokens: 100,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
      ],
    })
    expect(out.model).toBe('claude-3')
    expect(out.max_tokens).toBe(100)
    expect(out.messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
    ])
  })

  it('system 块数组拼接，温度/top_p/stop_sequences 映射', () => {
    const out = anthropicToOpenAI({
      model: 'm',
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ],
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['STOP'],
      messages: [],
    })
    expect(out.messages[0]).toEqual({ role: 'system', content: 'AB' })
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
    expect(out.stop).toEqual(['STOP'])
  })

  it('文本块数组拼成字符串，图片块转 image_url', () => {
    const out = anthropicToOpenAI({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看这张图' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: '图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
      ],
    })
    expect(out.messages[0].content).toBe('看这张图')
    expect(out.messages[1].content).toEqual([
      { type: 'text', text: '图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
  })

  it('stream 标志透传', () => {
    expect(anthropicToOpenAI({ model: 'm', stream: true, messages: [] }).stream).toBe(true)
    expect(anthropicToOpenAI({ model: 'm', messages: [] }).stream).toBe(false)
  })
})

describe('openAIToAnthropic', () => {
  it('非流式响应转 Anthropic message 与 usage', () => {
    const out = openAIToAnthropic(
      {
        id: 'chatcmpl-1',
        model: 'gpt-x',
        choices: [{ message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 5 },
      },
      'fallback',
    )
    expect(out.type).toBe('message')
    expect(out.role).toBe('assistant')
    expect(out.model).toBe('gpt-x')
    expect(out.content).toEqual([{ type: 'text', text: '回答' }])
    expect(out.stop_reason).toBe('end_turn')
    expect(out.usage).toEqual({ input_tokens: 7, output_tokens: 5 })
  })

  it('缺响应时回退 model 与空文本', () => {
    const out = openAIToAnthropic({}, 'fallback')
    expect(out.model).toBe('fallback')
    expect(out.content).toEqual([{ type: 'text', text: '' }])
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('mapStopReason / normalizeContent', () => {
  it('finish_reason 映射', () => {
    expect(mapStopReason('stop')).toBe('end_turn')
    expect(mapStopReason('length')).toBe('max_tokens')
    expect(mapStopReason('tool_calls')).toBe('tool_use')
    expect(mapStopReason(undefined)).toBe('end_turn')
  })
  it('normalizeContent 处理字符串与纯文本块', () => {
    expect(normalizeContent('abc')).toBe('abc')
    expect(
      normalizeContent([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab')
    expect(normalizeContent(null)).toBe('')
  })
})

describe('createAnthropicSseTransform', () => {
  const stream =
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
    'data: [DONE]\n\n'

  it('完整流归一为 Anthropic 事件序列', () => {
    const transform = createAnthropicSseTransform('claude-3')
    const events = parseEvents(transform.push(stream))
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[0].data.message.model).toBe('claude-3')
    expect(events[3].data.delta.text).toBe('Hel')
    expect(events[4].data.delta.text).toBe('lo')
    expect(events[6].data.delta.stop_reason).toBe('end_turn')
    expect(events[6].data.usage.output_tokens).toBe(2)
  })

  it('跨 chunk 拆分与一次性喂入结果一致', () => {
    // message_start.id 取自创建时刻的 Date.now()；冻结时钟避免两个实例跨毫秒导致 id 不同
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      const whole = parseEvents(createAnthropicSseTransform('m').push(stream))
      const transform = createAnthropicSseTransform('m')
      let out = ''
      // 逐字符喂入，模拟任意分块
      for (const ch of stream) out += transform.push(ch)
      out += transform.end()
      expect(parseEvents(out)).toEqual(whole)
    } finally {
      vi.useRealTimers()
    }
  })

  it('无 [DONE] 时 end() 补收尾事件', () => {
    const transform = createAnthropicSseTransform('m')
    const head = transform.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    const tail = transform.end()
    const events = parseEvents(head + tail)
    expect(events.map((e) => e.event)).toContain('message_stop')
    expect(events.at(-1).event).toBe('message_stop')
  })

  it('空流 end() 仍产出完整骨架', () => {
    const events = parseEvents(createAnthropicSseTransform('m').end())
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })
})

describe('aggregateOpenAIStream', () => {
  it('把 SSE 文本聚合为单个非流式响应', () => {
    const text =
      'data: {"model":"gpt-x","choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
      'data: [DONE]\n\n'
    const json = aggregateOpenAIStream(text)
    expect(json.choices[0].message.content).toBe('Hello')
    expect(json.choices[0].finish_reason).toBe('stop')
    expect(json.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 })
    const message = openAIToAnthropic(json, 'fallback')
    expect(message.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(message.model).toBe('gpt-x')
  })
})
