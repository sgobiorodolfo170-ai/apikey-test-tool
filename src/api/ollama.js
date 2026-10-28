import http from './http.js'
import { toOllamaMessage } from './multimodal.js'
import {
  getErrorMessage,
  extractProviderError,
  createController,
  releaseController,
  runConcurrentBatch,
  acquireSignal,
} from './utils.js'
import { createNdjsonParser } from './sse.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000

export { cancelAllRequests } from './utils.js'

// Ollama 本地服务默认地址 http://localhost:11434，无需 API Key
export function normalizeOllamaBaseUrl(baseUrl) {
  let base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (/\/api$/i.test(base)) {
    base = base.slice(0, -4)
  }
  return base
}

export async function listOllamaModels(config) {
  const base = normalizeOllamaBaseUrl(config.baseUrl)
  const controller = createController()

  try {
    const response = await http.get(`${base}/api/tags`, {
      timeout: TIMEOUT,
      signal: controller.signal,
    })

    const list = Array.isArray(response.data?.models) ? response.data.models : []
    const models = list
      .map((m) => ({ id: m.name || m.model, name: m.details?.family }))
      .filter((m) => m.id)

    if (models.length > 0) {
      return { success: true, models }
    }
    return {
      success: false,
      models: [],
      error: 'Ollama 已连接但未安装模型，请先执行 ollama pull <模型名>',
    }
  } catch (error) {
    if (error.name === 'CanceledError' || error.name === 'AbortError') {
      return { success: false, models: [], error: '请求已取消' }
    }
    return {
      success: false,
      models: [],
      error:
        extractProviderError(error) ||
        getErrorMessage(error, config.baseUrl) ||
        'Ollama 服务不可用，请确认已启动 Ollama',
      status: error.response?.status,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testOllamaConnection(config) {
  const base = normalizeOllamaBaseUrl(config.baseUrl)
  const startTime = Date.now()
  const controller = createController()

  try {
    await http.get(`${base}/api/tags`, {
      timeout: TIMEOUT,
      signal: controller.signal,
    })

    return {
      connected: true,
      connectTime: Date.now() - startTime,
      usedEndpoint: '/api/tags',
    }
  } catch (error) {
    if (error.name === 'CanceledError' || error.name === 'AbortError') {
      return { connected: false, error: '请求已取消' }
    }
    return {
      connected: false,
      connectTime: Date.now() - startTime,
      error:
        extractProviderError(error) ||
        getErrorMessage(error, config.baseUrl) ||
        'Ollama 服务不可用，请确认已启动 Ollama',
      status: error.response?.status,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testOllamaModelLatency(config, model) {
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const base = normalizeOllamaBaseUrl(config.baseUrl)
  const startTime = Date.now()
  const controller = createController()

  try {
    await http.post(
      `${base}/api/chat`,
      {
        model: modelId,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        stream: false,
        options: { num_predict: 8 },
      },
      {
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
    if (error.response?.status === 404) {
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: `模型 ${modelId} 不存在，请先执行 ollama pull`,
      }
    }

    return {
      model: modelId,
      latency: -1,
      status: 'failed',
      error:
        extractProviderError(error) || getErrorMessage(error, config.baseUrl) || 'Ollama 请求失败',
    }
  } finally {
    releaseController(controller)
  }
}

export async function testOllamaModels(config, models, concurrency = 5) {
  return runConcurrentBatch(models, (model) => testOllamaModelLatency(config, model), concurrency)
}

// 聊天补全（返回助手回复文本），供聊天面板通过统一适配器调用
export async function sendOllamaChat(
  config,
  { model, messages, maxTokens = 500, timeout = 60000 },
) {
  const base = normalizeOllamaBaseUrl(config.baseUrl)
  const controller = createController()

  try {
    const response = await http.post(
      `${base}/api/chat`,
      {
        model,
        messages: messages.map(toOllamaMessage),
        stream: false,
        options: { num_predict: maxTokens },
      },
      {
        timeout,
        signal: controller.signal,
      },
    )
    return response.data?.message?.content || '无响应'
  } finally {
    releaseController(controller)
  }
}

// ---------- 流式聊天（Ollama 用 NDJSON，不是 SSE） ----------
export async function streamOllamaChat(
  config,
  { model, messages, maxTokens = 500, timeout = 120000, signal },
  onDelta,
) {
  const base = normalizeOllamaBaseUrl(config.baseUrl)
  const { signal: abortSignal, release } = acquireSignal(signal)

  try {
    let full = ''
    const parser = createNdjsonParser((json) => {
      const delta = json?.message?.content
      if (typeof delta === 'string' && delta) {
        full += delta
        onDelta?.(delta)
      }
    })

    await http.stream(
      `${base}/api/chat`,
      {
        model,
        messages: messages.map(toOllamaMessage),
        stream: true,
        options: { num_predict: maxTokens },
      },
      { headers: { Accept: 'application/x-ndjson' }, timeout, signal: abortSignal },
      (chunk) => parser.push(chunk),
    )

    parser.flush()
    return full
  } finally {
    release()
  }
}
