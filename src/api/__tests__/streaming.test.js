import { describe, it, expect, afterEach, vi } from 'vitest'
import { streamOpenAIChat } from '../openai.js'
import { streamAnthropicChat } from '../anthropic.js'
import { streamGeminiChat } from '../gemini.js'
import { streamOllamaChat } from '../ollama.js'
import { streamResponsesChat } from '../responses.js'
import { streamAzureChat } from '../azure.js'

const openaiConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }

function bridge(chunks, meta = {}) {
  const stream = vi.fn(async (payload, onEvent) => {
    for (const chunk of chunks) {
      onEvent({ requestId: payload.requestId, type: 'chunk', text: chunk })
    }
    onEvent({ requestId: payload.requestId, type: 'done' })
    return { ok: true, status: 200, statusText: 'OK', headers: {}, ...meta }
  })
  window.electronAPI = { stream, abortRequest: vi.fn() }
  return stream
}

const collect = () => {
  const deltas = []
  return { deltas, onDelta: (d) => deltas.push(d) }
}

describe('streaming chat adapters', () => {
  afterEach(() => {
    delete window.electronAPI
  })

  it('OpenAI: assembles SSE deltas and streams the right request', async () => {
    const stream = bridge([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
    ])
    const { deltas, onDelta } = collect()

    const text = await streamOpenAIChat(
      openaiConfig,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      onDelta,
    )

    expect(deltas).toEqual(['你', '好'])
    expect(text).toBe('你好')

    const payload = stream.mock.calls[0][0]
    expect(payload.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(payload.body.stream).toBe(true)
    expect(payload.body.model).toBe('gpt-4o')
    expect(payload.headers.Authorization).toBe('Bearer sk-test')
  })

  it('OpenAI: falls back to the /v1 endpoint on 404', async () => {
    const stream = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 404,
        statusText: 'Not Found',
        headers: {},
        text: '{"error":"nf"}',
      })
      .mockImplementationOnce(async (payload, onEvent) => {
        onEvent({
          requestId: payload.requestId,
          type: 'chunk',
          text: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        })
        return { ok: true, status: 200, headers: {} }
      })
    window.electronAPI = { stream, abortRequest: vi.fn() }

    const text = await streamOpenAIChat(openaiConfig, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(text).toBe('ok')
    expect(stream.mock.calls[1][0].url).toBe('https://api.openai.com/v1/v1/chat/completions')
  })

  it('Anthropic: reads content_block_delta events', async () => {
    bridge([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"你"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"好"}}\n\n',
    ])
    const { deltas, onDelta } = collect()

    const text = await streamAnthropicChat(
      { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant' },
      { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] },
      onDelta,
    )

    expect(text).toBe('你好')
    expect(deltas).toEqual(['你', '好'])
  })

  it('Gemini: reads candidate parts from the SSE stream', async () => {
    const stream = bridge([
      'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}\n\n',
    ])

    const text = await streamGeminiChat(
      { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'g-key' },
      { model: 'models/gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] },
    )

    expect(text).toBe('你好')
    expect(stream.mock.calls[0][0].url).toContain(':streamGenerateContent?alt=sse')
    expect(stream.mock.calls[0][0].headers['x-goog-api-key']).toBe('g-key')
  })

  it('Ollama: reads NDJSON message chunks', async () => {
    const stream = bridge([
      '{"message":{"content":"你"}}\n',
      '{"message":{"content":"好"}}\n',
      '{"done":true}\n',
    ])

    const text = await streamOllamaChat(
      { baseUrl: 'http://localhost:11434', apiKey: '' },
      { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
    )

    expect(text).toBe('你好')
    expect(stream.mock.calls[0][0].url).toBe('http://localhost:11434/api/chat')
    expect(stream.mock.calls[0][0].body.stream).toBe(true)
  })

  it('Responses: reads response.output_text.delta events', async () => {
    const stream = bridge([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
    ])

    const text = await streamResponsesChat(openaiConfig, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(text).toBe('你好')
    expect(stream.mock.calls[0][0].url).toBe('https://api.openai.com/v1/responses')
  })

  it('Azure: streams from the deployment endpoint with api-version', async () => {
    const stream = bridge(['data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'])

    const text = await streamAzureChat(
      { baseUrl: 'https://res.openai.azure.com', apiKey: 'az-key' },
      { model: 'dep-1', messages: [{ role: 'user', content: 'hi' }] },
    )

    expect(text).toBe('你好')
    expect(stream.mock.calls[0][0].url).toContain(
      '/deployments/dep-1/chat/completions?api-version=2024-06-01',
    )
    expect(stream.mock.calls[0][0].headers['api-key']).toBe('az-key')
  })

  it('should not start a request when the signal is already aborted', async () => {
    window.electronAPI = { stream: vi.fn(), abortRequest: vi.fn() }
    const controller = new AbortController()
    controller.abort()

    await expect(
      streamOpenAIChat(
        openaiConfig,
        { model: 'gpt-4o', messages: [], signal: controller.signal },
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'CanceledError' })

    expect(window.electronAPI.stream).not.toHaveBeenCalled()
  })
})
