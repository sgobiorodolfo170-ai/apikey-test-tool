import { describe, expect, it } from 'vitest'
import {
  STREAM_FORMATS,
  sniffByContentType,
  sniffByFirstChunk,
  sniffStreamFormat,
} from '../sniff.js'

describe('sniffByContentType', () => {
  it('识别 event-stream / ndjson / json', () => {
    expect(sniffByContentType('text/event-stream')).toBe(STREAM_FORMATS.SSE)
    expect(sniffByContentType('application/x-ndjson')).toBe(STREAM_FORMATS.NDJSON)
    expect(sniffByContentType('application/json')).toBe(STREAM_FORMATS.JSON)
    expect(sniffByContentType('text/plain')).toBe(STREAM_FORMATS.UNKNOWN)
    expect(sniffByContentType('')).toBe(STREAM_FORMATS.UNKNOWN)
  })
})

describe('sniffByFirstChunk', () => {
  it('识别标准 SSE', () => {
    expect(sniffByFirstChunk('data: {"a":1}\n\n')).toBe(STREAM_FORMATS.SSE)
    expect(sniffByFirstChunk('event: delta\ndata: x\n\n')).toBe(STREAM_FORMATS.SSE)
  })

  it('识别心跳注释行开头的 SSE', () => {
    expect(sniffByFirstChunk(': ping\n\ndata: {"a":1}\n\n')).toBe(STREAM_FORMATS.SSE)
  })

  it('识别 NDJSON', () => {
    expect(sniffByFirstChunk('{"a":1}\n{"a":2}\n')).toBe(STREAM_FORMATS.NDJSON)
  })

  it('单行 JSON 对象按 NDJSON 处理（行解析器行为一致）', () => {
    expect(sniffByFirstChunk('{"a":1}')).toBe(STREAM_FORMATS.NDJSON)
  })

  it('JSON 数组响应识别为 JSON', () => {
    expect(sniffByFirstChunk('[{"a":1}]')).toBe(STREAM_FORMATS.JSON)
  })

  it('空内容与未知内容返回 unknown', () => {
    expect(sniffByFirstChunk('')).toBe(STREAM_FORMATS.UNKNOWN)
    expect(sniffByFirstChunk('   ')).toBe(STREAM_FORMATS.UNKNOWN)
    expect(sniffByFirstChunk('plain text')).toBe(STREAM_FORMATS.UNKNOWN)
  })
})

describe('sniffStreamFormat', () => {
  it('首块优先于 Content-Type', () => {
    // 上游声称 text/plain 但实际是 SSE
    expect(sniffStreamFormat('data: {"a":1}\n\n', 'text/plain')).toBe(STREAM_FORMATS.SSE)
  })

  it('首块为空时回退到 Content-Type', () => {
    expect(sniffStreamFormat('', 'text/event-stream')).toBe(STREAM_FORMATS.SSE)
    expect(sniffStreamFormat('', 'application/x-ndjson')).toBe(STREAM_FORMATS.NDJSON)
  })

  it('两者都无法识别时返回 unknown', () => {
    expect(sniffStreamFormat('', '')).toBe(STREAM_FORMATS.UNKNOWN)
  })
})
