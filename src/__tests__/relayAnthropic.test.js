import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

describe('Anthropic /v1/messages 网关（端到端）', () => {
  let upstream
  let relayInfo
  const received = []

  const post = (path, body) =>
    fetch(`http://127.0.0.1:${relayInfo.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        received.push(parsed)
        if (JSON.stringify(parsed.messages || '').includes('流式分片')) {
          // 故意把多字节 UTF-8 字符「河」切成两半写：前 2 字节先发，
          // 20ms 后再发尾字节——强制在 chunk 边界上截断字符
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(Buffer.from('data: {"choices":[{"delta":{"content":"'))
          res.write(Buffer.from('河流', 'utf8').subarray(0, 2))
          setTimeout(() => {
            res.write(Buffer.from('河流', 'utf8').subarray(2))
            res.write(Buffer.from('"}}]}\n\n'))
            res.write('data: [DONE]\n\n')
            res.end()
          }, 20)
        } else if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' } }] })}\n\n`)
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`,
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'chatcmpl-anthropic',
              model: parsed.model,
              choices: [
                { message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
          )
        }
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${upstream.address().port}/v1`
    relayInfo = await relay.start({
      port: 0,
      providers: [
        { id: 'a', name: '上游A', baseUrl: base, apiKey: 'sk-a', models: ['m-a'], enabled: true },
        { id: 'b', name: '上游B', baseUrl: base, apiKey: 'sk-b', models: ['m-b'], enabled: true },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
  })

  beforeEach(() => {
    received.length = 0
    relay.clearLogs()
  })

  it('非流式：Anthropic 请求转 OpenAI 上游，响应转回 Anthropic message', async () => {
    const response = await post('/v1/messages', {
      model: 'm-a',
      max_tokens: 64,
      system: '你是助手',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-relay-provider')).toBe(encodeURIComponent('上游A'))
    const payload = await response.json()
    expect(payload.type).toBe('message')
    expect(payload.role).toBe('assistant')
    expect(payload.content).toEqual([{ type: 'text', text: '你好，世界' }])
    expect(payload.stop_reason).toBe('end_turn')
    expect(payload.usage).toEqual({ input_tokens: 4, output_tokens: 2 })
    // 上游收到的是 OpenAI 格式（system 归一为 message，max_tokens 透传）
    expect(received[0].messages[0]).toEqual({ role: 'system', content: '你是助手' })
    expect(received[0].max_tokens).toBe(64)
    expect(relay.getLogs()[0].path).toBe('/v1/messages')
  })

  it('流式：上游 OpenAI SSE 归一为 Anthropic 事件流', async () => {
    const response = await post('/v1/messages', {
      model: 'm-a',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: content_block_start')
    expect(text).toContain('event: content_block_delta')
    expect(text).toContain('event: message_stop')
    const deltas = [...text.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1])
    expect(deltas.join('')).toBe('你好，世界')
    expect(received[0].stream).toBe(true)
  })

  it('流式：多字节 UTF-8 跨 chunk 边界不产生乱码', async () => {
    const response = await post('/v1/messages', {
      model: 'm-a',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: '流式分片' }],
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    const deltas = [...text.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1])
    expect(deltas.join('')).toBe('河流')
  })

  it('模型未命中 → 404 model_not_found', async () => {
    const response = await post('/v1/messages', { model: 'm-unknown', messages: [] })
    const payload = await response.json()
    expect(response.status).toBe(404)
    expect(payload.error.type).toBe('model_not_found')
  })

  it('/v1/responses 未启用 → 明确 501', async () => {
    const response = await post('/v1/responses', { model: 'm-a', input: 'hi' })
    const payload = await response.json()
    expect(response.status).toBe(501)
    expect(payload.error.type).toBe('not_implemented')
  })

  it('/v1/models 仍广播所有启用上游', async () => {
    const response = await fetch(`http://127.0.0.1:${relayInfo.port}/v1/models`)
    const payload = await response.json()
    expect(payload.data.map((m) => m.id)).toEqual(['m-a', 'm-b'])
  })
})
