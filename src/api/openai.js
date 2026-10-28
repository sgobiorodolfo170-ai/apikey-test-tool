import http from './http.js'
import { toOpenAIContent } from './multimodal.js'
import {
  buildUrl,
  getErrorMessage,
  extractProviderError,
  describeListError,
  createController,
  releaseController,
  runConcurrentBatch,
  acquireSignal,
  isAbortError,
} from './utils.js'
import { createSseParser } from './sse.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000

export { cancelAllRequests } from './utils.js'

// 新版 OpenAI 模型已废弃 max_tokens 参数（要求 max_completion_tokens），
// 收到对应的 400 错误时需要换参数重试
function needsMaxCompletionTokens(error) {
  const text = `${extractProviderError(error) || ''} ${error?.message || ''}`.toLowerCase()
  return text.includes('max_completion_tokens') || text.includes('max_tokens')
}

async function postChatCompletion(url, apiKey, body, controller, timeout = TIMEOUT) {
  const requestOptions = {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout,
    signal: controller.signal,
  }
  try {
    return await http.post(url, body, requestOptions)
  } catch (error) {
    if (
      error.response?.status === 400 &&
      body.max_tokens !== undefined &&
      needsMaxCompletionTokens(error)
    ) {
      const { max_tokens, ...rest } = body
      return await http.post(url, { ...rest, max_completion_tokens: max_tokens }, requestOptions)
    }
    throw error
  }
}

// 兼容各家 OpenAI 兼容实现的模型列表响应格式:
// {"data": [...]}, 裸数组 [...], {"models": [...]}
function parseModelsPayload(data) {
  let list = null
  if (Array.isArray(data)) {
    list = data
  } else if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data.data)) list = data.data
    else if (Array.isArray(data.models)) list = data.models
  }
  if (!list) return []
  return list
    .map((m) =>
      typeof m === 'string'
        ? { id: m }
        : { id: m.id, object: m.object, created: m.created, owned_by: m.owned_by },
    )
    .filter((m) => m.id)
}

export async function testOpenAIConnection(config) {
  const { apiKey, baseUrl } = config
  const startTime = Date.now()
  const controller = createController()

  try {
    const testEndpoints = ['/chat/completions', '/v1/chat/completions']

    for (const endpoint of testEndpoints) {
      try {
        const url = buildUrl(baseUrl, endpoint)

        await postChatCompletion(
          url,
          apiKey,
          {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: TEST_PROMPT }],
            max_tokens: 5,
          },
          controller,
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
            warning: 'API可访问，但测试模型可能不存在',
          }
        }

        if (error.response?.status === 404) {
          continue
        }
      }
    }

    try {
      await http.get(buildUrl(baseUrl, '/models'), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
        signal: controller.signal,
      })

      return {
        connected: true,
        connectTime: Date.now() - startTime,
        usedEndpoint: '/models',
        warning: 'API可访问(通过models端点确认)',
      }
    } catch (error) {
      if (error.name === 'CanceledError' || error.name === 'AbortError') {
        return { connected: false, error: '请求已取消' }
      }
      return {
        connected: false,
        connectTime: Date.now() - startTime,
        error: extractProviderError(error) || getErrorMessage(error, baseUrl),
        status: error.response?.status,
      }
    }
  } finally {
    releaseController(controller)
  }
}

export async function listOpenAIModels(config) {
  const { apiKey, baseUrl } = config
  const controller = createController()

  try {
    const listEndpoints = ['/models', '/v1/models', '/v1/models/list']

    let lastError = null

    for (const path of listEndpoints) {
      try {
        const url = buildUrl(baseUrl, path)
        const response = await http.get(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: TIMEOUT,
          signal: controller.signal,
        })

        const models = parseModelsPayload(response.data)

        if (models.length > 0) {
          return { success: true, models }
        }
      } catch (error) {
        if (error.name === 'CanceledError' || error.name === 'AbortError') {
          return { success: false, models: [], error: '请求已取消' }
        }
        lastError = describeListError(error)
        console.log('获取模型列表失败:', path, error.response?.status)
      }
    }

    return {
      success: false,
      models: [],
      error: lastError?.message || '无法获取模型列表，请手动输入模型名称测试',
      status: lastError?.status,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testModelLatency(config, model) {
  const { apiKey, baseUrl } = config
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const startTime = Date.now()
  const controller = createController()

  try {
    const testEndpoints = ['/chat/completions', '/v1/chat/completions']

    for (const endpoint of testEndpoints) {
      try {
        const url = buildUrl(baseUrl, endpoint)

        await postChatCompletion(
          url,
          apiKey,
          {
            model: modelId,
            messages: [{ role: 'user', content: TEST_PROMPT }],
            max_tokens: 5,
          },
          controller,
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
      error: `模型 ${modelId} 不存在或不支持`,
    }
  } finally {
    releaseController(controller)
  }
}

// 聊天补全（OpenAI 兼容协议），供聊天面板使用，与测试逻辑共享参数重试与端点回退
export async function sendChatCompletion(
  config,
  { model, messages, maxTokens = 500, timeout = 60000 },
) {
  const { apiKey, baseUrl } = config
  const controller = createController()

  try {
    const endpoints = ['/chat/completions', '/v1/chat/completions']
    let lastError = null

    for (const endpoint of endpoints) {
      try {
        const response = await postChatCompletion(
          buildUrl(baseUrl, endpoint),
          apiKey,
          {
            model,
            messages: messages.map((m) => ({ role: m.role, content: toOpenAIContent(m) })),
            max_tokens: maxTokens,
          },
          controller,
          timeout,
        )
        return response.data
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

// 聊天补全（返回助手回复文本），供聊天面板通过统一适配器调用
export async function sendOpenAIChat(
  config,
  { model, messages, maxTokens = 500, timeout = 60000 },
) {
  const data = await sendChatCompletion(config, { model, messages, maxTokens, timeout })
  return data?.choices?.[0]?.message?.content || '无响应'
}

export async function testAllModelsConcurrently(config, models, concurrency = 5) {
  return runConcurrentBatch(models, (model) => testModelLatency(config, model), concurrency)
}

// ---------- 流式聊天 ----------

async function streamOpenAIOnce(url, apiKey, body, signal, timeout, onDelta) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }

  const run = async (payload) => {
    let full = ''
    const parser = createSseParser(({ data }) => {
      if (data === '[DONE]') return
      let json
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      const delta = json?.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) {
        full += delta
        onDelta?.(delta)
      }
    })

    await http.stream(url, { ...payload, stream: true }, { headers, timeout, signal }, (chunk) =>
      parser.push(chunk),
    )
    parser.flush()
    return full
  }

  try {
    return await run(body)
  } catch (error) {
    // 新版 OpenAI 模型拒绝 max_tokens：换 max_completion_tokens 重试一次
    if (
      error.response?.status === 400 &&
      body.max_tokens !== undefined &&
      needsMaxCompletionTokens(error)
    ) {
      const { max_tokens, ...rest } = body
      return await run({ ...rest, max_completion_tokens: max_tokens })
    }
    throw error
  }
}

export async function streamOpenAIChat(
  config,
  { model, messages, maxTokens = 500, timeout = 120000, signal },
  onDelta,
) {
  const { apiKey, baseUrl } = config
  const { signal: abortSignal, release } = acquireSignal(signal)

  try {
    const endpoints = ['/chat/completions', '/v1/chat/completions']
    let lastError = null

    for (const endpoint of endpoints) {
      try {
        return await streamOpenAIOnce(
          buildUrl(baseUrl, endpoint),
          apiKey,
          {
            model,
            messages: messages.map((m) => ({ role: m.role, content: toOpenAIContent(m) })),
            max_tokens: maxTokens,
          },
          abortSignal,
          timeout,
          onDelta,
        )
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
