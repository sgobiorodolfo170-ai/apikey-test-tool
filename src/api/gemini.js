import http from './http.js'
import {
  getErrorMessage,
  extractProviderError,
  describeListError,
  createController,
  releaseController,
  runConcurrentBatch,
  acquireSignal,
} from './utils.js'
import { createSseParser } from './sse.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000
const DEFAULT_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-pro']

export { cancelAllRequests } from './utils.js'

export function normalizeGeminiBaseUrl(baseUrl) {
  let base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!/\/(v1beta|v1)$/i.test(base)) {
    base += '/v1beta'
  }
  return base
}

function geminiHeaders(apiKey) {
  return {
    'x-goog-api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

function isGeminiKeyError(error) {
  const status = error.response?.status
  if (status === 401 || status === 403) return true
  if (status !== 400) return false
  const details = error.response?.data?.error?.details
  const reason = Array.isArray(details) ? details.find((d) => d?.reason)?.reason : null
  const message = error.response?.data?.error?.message || ''
  return reason === 'API_KEY_INVALID' || /api[\s_-]?key/i.test(message)
}

export function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return '无响应'
  const text = parts.map((part) => part?.text || '').join('')
  return text || '无响应'
}

function buildGenerateBody(messages, maxTokens) {
  const contents = []
  const systemTexts = []

  for (const message of messages) {
    if (message.role === 'system') {
      systemTexts.push(message.content)
      continue
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })
  }

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  }
  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: systemTexts.map((text) => ({ text })) }
  }
  return body
}

export async function listGeminiModels(config) {
  const { apiKey, baseUrl } = config
  const base = normalizeGeminiBaseUrl(baseUrl)
  const controller = createController()

  try {
    const response = await http.get(`${base}/models?pageSize=1000`, {
      headers: geminiHeaders(apiKey),
      timeout: TIMEOUT,
      signal: controller.signal,
    })

    const list = Array.isArray(response.data?.models) ? response.data.models : []
    const models = list
      .filter(
        (m) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes('generateContent'),
      )
      .map((m) => ({ id: (m.name || '').replace(/^models\//, ''), name: m.displayName }))
      .filter((m) => m.id)

    if (models.length > 0) {
      return { success: true, models }
    }
    return { success: false, models: [], error: 'Gemini 未返回可用模型，请检查API Key权限' }
  } catch (error) {
    if (error.name === 'CanceledError' || error.name === 'AbortError') {
      return { success: false, models: [], error: '请求已取消' }
    }
    const described = describeListError(error)
    return { success: false, models: [], error: described.message, status: described.status }
  } finally {
    releaseController(controller)
  }
}

export async function testGeminiConnection(config) {
  const { apiKey, baseUrl } = config
  const base = normalizeGeminiBaseUrl(baseUrl)
  const startTime = Date.now()
  const controller = createController()

  try {
    for (const model of DEFAULT_MODELS) {
      try {
        await http.post(
          `${base}/models/${model}:generateContent`,
          buildGenerateBody([{ role: 'user', content: TEST_PROMPT }], 16),
          {
            headers: geminiHeaders(apiKey),
            timeout: TIMEOUT,
            signal: controller.signal,
          },
        )

        return {
          connected: true,
          connectTime: Date.now() - startTime,
          usedEndpoint: `/models/${model}:generateContent`,
        }
      } catch (error) {
        if (error.name === 'CanceledError' || error.name === 'AbortError') {
          return { connected: false, error: '请求已取消' }
        }
        if (isGeminiKeyError(error)) {
          return {
            connected: false,
            connectTime: Date.now() - startTime,
            error: 'API Key无效或已过期',
            status: error.response?.status || 401,
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
        if (error.response?.status === 404) {
          continue
        }
        if (error.response?.status === 400) {
          return {
            connected: true,
            connectTime: Date.now() - startTime,
            usedEndpoint: `/models/${model}:generateContent`,
            warning: extractProviderError(error) || 'API可访问，但请求参数不受支持',
          }
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
      error: '未找到可用的 Gemini 测试模型 (404)，请手动输入模型名称测试',
      status: 404,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testGeminiModelLatency(config, model) {
  const { apiKey, baseUrl } = config
  const modelId = (typeof model === 'string' ? model : model.id || model.name || '').replace(
    /^models\//,
    '',
  )
  const base = normalizeGeminiBaseUrl(baseUrl)
  const startTime = Date.now()
  const controller = createController()

  try {
    await http.post(
      `${base}/models/${modelId}:generateContent`,
      buildGenerateBody([{ role: 'user', content: TEST_PROMPT }], 16),
      {
        headers: geminiHeaders(apiKey),
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
    if (isGeminiKeyError(error)) {
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: 'API Key无效',
      }
    }
    if (error.response?.status === 404) {
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: `模型 ${modelId} 不存在`,
      }
    }

    return {
      model: modelId,
      latency: -1,
      status: 'failed',
      error: extractProviderError(error) || getErrorMessage(error, baseUrl),
    }
  } finally {
    releaseController(controller)
  }
}

export async function testGeminiModels(config, models, concurrency = 5) {
  return runConcurrentBatch(models, (model) => testGeminiModelLatency(config, model), concurrency)
}

// 聊天补全（返回助手回复文本），供聊天面板通过统一适配器调用
export async function sendGeminiChat(
  config,
  { model, messages, maxTokens = 500, timeout = 60000 },
) {
  const { apiKey, baseUrl } = config
  const modelId = (typeof model === 'string' ? model : model?.id || '').replace(/^models\//, '')
  const base = normalizeGeminiBaseUrl(baseUrl)
  const controller = createController()

  try {
    const response = await http.post(
      `${base}/models/${modelId}:generateContent`,
      buildGenerateBody(messages, maxTokens),
      {
        headers: geminiHeaders(apiKey),
        timeout,
        signal: controller.signal,
      },
    )
    return extractGeminiText(response.data)
  } finally {
    releaseController(controller)
  }
}

// ---------- 流式聊天 ----------
export async function streamGeminiChat(
  config,
  { model, messages, maxTokens = 500, timeout = 120000, signal },
  onDelta,
) {
  const { apiKey, baseUrl } = config
  const modelId = (typeof model === 'string' ? model : model?.id || '').replace(/^models\//, '')
  const base = normalizeGeminiBaseUrl(baseUrl)
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
      const parts = json?.candidates?.[0]?.content?.parts
      if (!Array.isArray(parts)) return
      const text = parts.map((part) => part?.text || '').join('')
      if (text) {
        full += text
        onDelta?.(text)
      }
    })

    await http.stream(
      `${base}/models/${modelId}:streamGenerateContent?alt=sse`,
      buildGenerateBody(messages, maxTokens),
      {
        headers: { ...geminiHeaders(apiKey), Accept: 'text/event-stream' },
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
