import { describe, it, expect } from 'vitest'
import { createSseParser, createNdjsonParser } from '../sse.js'

describe('createSseParser', () => {
  it('should reassemble events split across arbitrary chunk boundaries', () => {
    const events = []
    const parser = createSseParser((e) => events.push(e))

    parser.push('data: {"a"')
    parser.push(':1}\n\ndata: [DONE]\n\n')

    expect(events).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: '[DONE]' },
    ])
  })

  it('should handle CRLF, comments and named events', () => {
    const events = []
    const parser = createSseParser((e) => events.push(e))

    parser.push(': keep-alive\r\n')
    parser.push('event: content_block_delta\r\n')
    parser.push('data: {"text":"hi"}\r\n\r\n')

    expect(events).toEqual([{ event: 'content_block_delta', data: '{"text":"hi"}' }])
  })

  it('should join multi-line data fields', () => {
    const events = []
    const parser = createSseParser((e) => events.push(e))

    parser.push('data: line1\ndata: line2\n\n')

    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
  })

  it('should flush a trailing block without the blank line', () => {
    const events = []
    const parser = createSseParser((e) => events.push(e))

    parser.push('data: tail')
    expect(events).toHaveLength(0)
    parser.flush()

    expect(events).toEqual([{ event: 'message', data: 'tail' }])
  })
})

describe('createNdjsonParser', () => {
  it('should parse newline delimited json across chunks', () => {
    const objects = []
    const parser = createNdjsonParser((o) => objects.push(o))

    parser.push('{"message":{"content":"你"}}\n{"message"')
    parser.push(':{"content":"好"}}\n')

    expect(objects).toEqual([{ message: { content: '你' } }, { message: { content: '好' } }])
  })

  it('should skip malformed lines and flush the remainder', () => {
    const objects = []
    const parser = createNdjsonParser((o) => objects.push(o))

    parser.push('not-json\n{"done":true}')
    parser.flush()

    expect(objects).toEqual([{ done: true }])
  })
})
