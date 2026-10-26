import http from './http.js'
import {
  buildUrl,
  getErrorMessage,
  extractProviderError,
  createController,
  releaseController,
  runConcurrentBatch,
  acquireSignal,
  isAbortError,
} from './utils.js'
import { createSseParser } from './sse.js'
import { listOpenAIModels } from './openai.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000
const DEFAULT_MODEL = 'gpt-4o-mini'

export { cancelAllRequests } from './utils.js'

// OpenAI Responses API 的模型列表与 Chat Completions 共用 /models 端点
export const listResponsesModels = listOpenAIModels

export function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text
  const outputs = Array.isArray(data?.output) ? data.output : []
  const text = outputs
    .filter((item) => item?.type === 'message' || Array.isArray(item?.content))
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((part) => part?.text || '')
    .join('')
  return text || '无响应'
}

export async function testResponsesConnection(config) {
  const { apiKey, baseUrl } = config
  const startTime = Date.now()
  const controller = createController()
  const endpoints = ['/responses', '/v1/responses']

  try {
    for (const endpoint of endpoints) {
      try {
        await http.post(
          buildUrl(baseUrl, endpoint),
          {
            model: DEFAULT_MODEL,
            input: TEST_PROMPT,
            max_output_tokens: 16,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: TIMEOUT,
            signal: controller.signal,
          },
        )

        return {
          connected: true,
          connectTime: Date.now() - startTime,
          usedEndpoint: endpoint,
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
        if (error.response?.status === 429) {
          return {
            connected: false,
            connectTime: Date.now() - startTime,
            error: '请求过多，请稍后再试 (429)',
            status: 429,
          }
        }
        if (error.response?.status === 400) {
          return {
            connected: true,
            connectTime: Date.now() - startTime,
            usedEndpoint: endpoint,
            warning: extractProviderError(error) || 'API可访问，但测试模型可能不存在或参数不受支持',
          }
        }
        if (error.response?.status === 404) {
          continue
        }
        return {
          connected: false,
          connectTime: Date.now() - startTime,
          error: extractProviderError(error) || getErrorMessage(error, baseUrl),
          status: error.response?.status,
        }
      }
    }

    return {
      connected: false,
      connectTime: Date.now() - startTime,
      error: '未找到 Responses API 端点 (404)，请检查Base URL路径',
      status: 404,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testResponsesModelLatency(config, model) {
  const { apiKey, baseUrl } = config
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const startTime = Date.now()
  const controller = createController()
  const endpoints = ['/responses', '/v1/responses']

  try {
    for (const endpoint of endpoints) {
      try {
        await http.post(
          buildUrl(baseUrl, endpoint),
          {
            model: modelId,
            input: TEST_PROMPT,
            max_output_tokens: 16,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
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
        if (error.response?.status === 404 || error.response?.status === 400) {
          continue
        }

        return {
          model: modelId,
          latency: -1,
          status: 'failed',
          error: extractProviderError(error) || getErrorMessage(error, baseUrl),
        }
      }
    }

    return {
      model: modelId,
      latency: -1,
      status: 'failed',
      error: `模型 ${modelId} 不存在或不支持 Responses API`,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testResponsesModels(config, models, concurrency = 5) {
  return runConcurrentBatch(
    models,
    (model) => testResponsesModelLatency(config, model),
    concurrency,
  )
}

// 聊天补全（返回助手回复文本），供聊天面板通过统一适配器调用
export async function sendResponsesChat(
  config,
  { model, messages, maxTokens = 500, timeout = 60000 },
) {
  const { apiKey, baseUrl } = config
  const controller = createController()
  const endpoints = ['/responses', '/v1/responses']

  try {
    let lastError = null

    for (const endpoint of endpoints) {
      try {
        const response = await http.post(
          buildUrl(baseUrl, endpoint),
          {
            model,
            input: messages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
            max_output_tokens: maxTokens,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout,
            signal: controller.signal,
          },
        )
        return extractResponsesText(response.data)
      } catch (error) {
        if (error.name === 'CanceledError' || error.name === 'AbortError') {
          throw error
        }
        lastError = error
      }
    }

    throw lastError || new Error('请求失败')
  } finally {
    releaseController(controller)
  }
}

// ---------- 流式聊天 ----------
export async function streamResponsesChat(
  config,
  { model, messages, maxTokens = 500, timeout = 120000, signal },
  onDelta,
) {
  const { apiKey, baseUrl } = config
  const { signal: abortSignal, release } = acquireSignal(signal)

  try {
    const endpoints = ['/responses', '/v1/responses']
    let lastError = null

    for (const endpoint of endpoints) {
      try {
        let full = ''
        const parser = createSseParser(({ data }) => {
          let json
          try {
            json = JSON.parse(data)
          } catch {
            return
          }
          if (json?.type === 'response.output_text.delta' && typeof json.delta === 'string') {
            full += json.delta
            onDelta?.(json.delta)
          }
        })

        await http.stream(
          buildUrl(baseUrl, endpoint),
          {
            model,
            input: messages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
            max_output_tokens: maxTokens,
            stream: true,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            timeout,
            signal: abortSignal,
          },
          (chunk) => parser.push(chunk),
        )

        parser.flush()
        return full
      } catch (error) {
        if (isAbortError(error)) throw error
        if (error.response?.status === 404) {
          lastError = error
          continue
        }
        throw error
      }
    }

    throw lastError || new Error('请求失败')
  } finally {
    release()
  }
}
