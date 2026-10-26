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
const DEFAULT_API_VERSION = '2024-06-01'

export { cancelAllRequests } from './utils.js'

// Azure OpenAI 的 Base URL 形如 https://{resource}.openai.azure.com，
// 请求路径固定为 /openai/...，且必须携带 api-version 查询参数
export function normalizeAzureBaseUrl(baseUrl) {
  let raw = (baseUrl || '').trim()
  let apiVersion = DEFAULT_API_VERSION

  const queryIndex = raw.indexOf('?')
  if (queryIndex >= 0) {
    const params = new URLSearchParams(raw.slice(queryIndex + 1))
    apiVersion = params.get('api-version') || apiVersion
    raw = raw.slice(0, queryIndex)
  }

  let base = raw.replace(/\/+$/, '')
  if (!/\/openai$/i.test(base)) {
    base += '/openai'
  }

  return { base, apiVersion }
}

function azureHeaders(apiKey) {
  return {
    'api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

function parseAzureModels(payload) {
  let list = null
  if (Array.isArray(payload)) {
    list = payload
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) list = payload.data
    else if (Array.isArray(payload.value)) list = payload.value
    else if (Array.isArray(payload.models)) list = payload.models
  }
  if (!list) return []

  const ids = list
    .map((m) => (typeof m === 'string' ? m : m.id || m.name || m.deployment))
    .filter(Boolean)
  return [...new Set(ids)].map((id) => ({ id }))
}

export async function listAzureModels(config) {
  const { apiKey, baseUrl } = config
  const { base, apiVersion } = normalizeAzureBaseUrl(baseUrl)
  const controller = createController()
  const endpoints = ['/deployments', '/models']

  try {
    let lastError = null

    for (const endpoint of endpoints) {
      const url = `${base}${endpoint}?api-version=${encodeURIComponent(apiVersion)}`
      try {
        const response = await http.get(url, {
          headers: azureHeaders(apiKey),
          timeout: TIMEOUT,
          signal: controller.signal,
        })

        const models = parseAzureModels(response.data)
        if (models.length > 0) {
          return { success: true, models }
        }
        lastError = { message: 'Azure 未返回可用的部署/模型，请先在 Azure 门户创建部署' }
      } catch (error) {
        if (error.name === 'CanceledError' || error.name === 'AbortError') {
          return { success: false, models: [], error: '请求已取消' }
        }
        lastError = describeListError(error)
        console.log('获取 Azure 模型列表失败:', endpoint, error.response?.status)
      }
    }

    return {
      success: false,
      models: [],
      error: lastError?.message || '无法获取 Azure 部署列表，请手动输入部署名称测试',
      status: lastError?.status,
    }
  } finally {
    releaseController(controller)
  }
}

export async function testAzureConnection(config) {
  const startTime = Date.now()
  const result = await listAzureModels(config)

  if (result.success) {
    return {
      connected: true,
      connectTime: Date.now() - startTime,
      warning: 'API可访问(通过Azure部署/模型列表确认)',
    }
  }

  return {
    connected: false,
    connectTime: Date.now() - startTime,
    error: result.error || '连接失败，请检查Base URL和API Key',
    status: result.status,
  }
}

export async function testAzureModelLatency(config, model) {
  const { apiKey, baseUrl } = config
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const { base, apiVersion } = normalizeAzureBaseUrl(baseUrl)
  const url = `${base}/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
  const startTime = Date.now()
  const controller = createController()

  try {
    await http.post(
      url,
      {
        messages: [{ role: 'user', content: TEST_PROMPT }],
        max_tokens: 5,
      },
      {
        headers: azureHeaders(apiKey),
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
    if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: 'API Key无效或无权访问该部署',
      }
    }
    if (error.response?.status === 404) {
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: `部署 ${modelId} 不存在，请检查部署名称`,
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

export async function testAzureModels(config, models, concurrency = 5) {
  return runConcurrentBatch(models, (model) => testAzureModelLatency(config, model), concurrency)
}

// 聊天补全（返回助手回复文本），供聊天面板通过统一适配器调用
export async function sendAzureChat(config, { model, messages, maxTokens = 500, timeout = 60000 }) {
  const { apiKey, baseUrl } = config
  const { base, apiVersion } = normalizeAzureBaseUrl(baseUrl)
  const url = `${base}/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
  const controller = createController()

  try {
    const response = await http.post(
      url,
      {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
      },
      {
        headers: azureHeaders(apiKey),
        timeout,
        signal: controller.signal,
      },
    )
    return response.data?.choices?.[0]?.message?.content || '无响应'
  } finally {
    releaseController(controller)
  }
}

// ---------- 流式聊天 ----------
export async function streamAzureChat(
  config,
  { model, messages, maxTokens = 500, timeout = 120000, signal },
  onDelta,
) {
  const { apiKey, baseUrl } = config
  const { base, apiVersion } = normalizeAzureBaseUrl(baseUrl)
  const url = `${base}/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
  const { signal: abortSignal, release } = acquireSignal(signal)

  try {
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

    await http.stream(
      url,
      {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
        stream: true,
      },
      {
        headers: { ...azureHeaders(apiKey), Accept: 'text/event-stream' },
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
