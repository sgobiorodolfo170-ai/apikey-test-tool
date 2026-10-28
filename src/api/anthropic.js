import http from './http.js'
import { toAnthropicContent } from './multimodal.js'
import {
  buildUrl,
  getErrorMessage,
  createController,
  releaseController,
  runConcurrentBatch,
  acquireSignal,
} from './utils.js'
import { createSseParser } from './sse.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000

export { cancelAllRequests } from './utils.js'

export async function testAnthropicConnection(config) {
  const { apiKey, baseUrl } = config
  const startTime = Date.now()
  const controller = createController()

  try {
    await http.post(
      buildUrl(baseUrl, '/messages'),
      {
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: TEST_PROMPT }],
        max_tokens: 10,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        timeout: TIMEOUT,
        signal: controller.signal,
      },
    )

    return {
      connected: true,
      connectTime: Date.now() - startTime,
    }
  } catch (error) {
    if (error.name === 'CanceledError' || error.name === 'AbortError') {
      return { connected: false, error: '请求已取消' }
    }
    if (error.response?.status === 401) {
      return {
        connected: false,
        connectTime: Date.now() - startTime,
        error: 'API Key无效或已过期',
        status: 401,
      }
    }

    return {
      connected: false,
      connectTime: Date.now() - startTime,
      error: getErrorMessage(error, baseUrl),
      status: error.response?.status,
    }
  } finally {
    releaseController(controller)
  }
}

export async function listAnthropicModels(_config) {
  return {
    success: true,
    models: [
      { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
      { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
      { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
    ],
  }
}

export async function testAnthropicModelLatency(config, model) {
  const { apiKey, baseUrl } = config
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const startTime = Date.now()
  const controller = createController()

  try {
    await http.post(
      buildUrl(baseUrl, '/messages'),
      {
        model: modelId,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        max_tokens: 10,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        timeout: TIMEOUT,
        signal: controller.signal,
      },
    )

    return {
      model: modelId,
      latency: Date.now() - startTime,
      status: 'success',
    }
  } catch (error) {
    if (error.name === 'CanceledError' || error.name === 'AbortError') {
      return { model: modelId, latency: -1, status: 'cancelled', error: '请求已取消' }
    }
    if (error.response?.status === 401) {
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: 'API Key无效',
      }
    }

    return {
      model: modelId,
      latency: -1,
      status: 'failed',
      error: getErrorMessage(error, baseUrl),
    }
  } finally {
    releaseController(controller)
  }
}

export async function testAnthropicModels(config, models, concurrency = 5) {
  return runConcurrentBatch(
    models,
    (model) => testAnthropicModelLatency(config, model),
    concurrency,
  )
}

// 聊天补全（返回助手回复文本），供聊天面板通过统一适配器调用
export async function sendAnthropicChat(
  config,
  { model, messages, maxTokens = 500, timeout = 60000 },
) {
  const { apiKey, baseUrl } = config
  const controller = createController()

  try {
    const response = await http.post(
      buildUrl(baseUrl, '/messages'),
      {
        model,
        messages: messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: toAnthropicContent(m),
        })),
        max_tokens: maxTokens,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        timeout,
        signal: controller.signal,
      },
    )
    return response.data?.content?.[0]?.text || '无响应'
  } finally {
    releaseController(controller)
  }
}

// ---------- 流式聊天 ----------
export async function streamAnthropicChat(
  config,
  { model, messages, maxTokens = 500, timeout = 120000, signal },
  onDelta,
) {
  const { apiKey, baseUrl } = config
  const { signal: abortSignal, release } = acquireSignal(signal)

  try {
    let full = ''
    const parser = createSseParser(({ data }) => {
      let json
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      if (json?.type === 'content_block_delta' && typeof json.delta?.text === 'string') {
        full += json.delta.text
        onDelta?.(json.delta.text)
      }
    })

    await http.stream(
      buildUrl(baseUrl, '/messages'),
      {
        model,
        messages: messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: toAnthropicContent(m),
        })),
        max_tokens: maxTokens,
        stream: true,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          Accept: 'text/event-stream',
        },
        timeout,
        signal: abortSignal,
      },
      (chunk) => parser.push(chunk),
    )

    parser.flush()
    return full
  } finally {
    release()
  }
}
