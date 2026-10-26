import http from './http.js'
import {
  buildUrl,
  getErrorMessage,
  extractProviderError,
  describeListError,
  createController,
  releaseController,
  runConcurrentBatch,
} from './utils.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000
const DEFAULT_MODEL = 'jev-latest'

export { cancelAllRequests } from './utils.js'

// Jev (TypeSafe) 的 Base URL 形如 https://api.typesafe.ai，请求路径固定为 /v1/...
export function normalizeJevBaseUrl(baseUrl) {
  let base = (baseUrl || 'https://api.typesafe.ai').trim().replace(/\/+$/, '')
  if (!/\/v\d+$/i.test(base)) {
    base += '/v1'
  }
  return base
}

function jevHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

function extractJevError(error, baseUrl) {
  const provider = extractProviderError(error)
  if (provider) return provider

  const detail = error?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0 && detail[0]?.msg) return detail[0].msg

  return getErrorMessage(error, baseUrl)
}

// Jev 是结构化决策模型（System One），非文本生成模型。
// 连通性与测速都通过 POST /v1/systemone 发起一次 Noul 判定完成。
async function postJevSystemOne(config, body) {
  const { apiKey, baseUrl } = config
  const base = normalizeJevBaseUrl(baseUrl)
  const controller = createController()

  try {
    const response = await http.post(buildUrl(base, '/systemone'), body, {
      headers: jevHeaders(apiKey),
      timeout: TIMEOUT,
      signal: controller.signal,
    })
    return { ok: true, data: response.data }
  } catch (error) {
    return { ok: false, error }
  } finally {
    releaseController(controller)
  }
}

export async function listJevModels(config) {
  const { apiKey, baseUrl } = config
  const base = normalizeJevBaseUrl(baseUrl)
  const controller = createController()

  try {
    const response = await http.get(buildUrl(base, '/models'), {
      headers: jevHeaders(apiKey),
      timeout: TIMEOUT,
      signal: controller.signal,
    })

    const list = Array.isArray(response.data?.models) ? response.data.models : []
    const models = list.map((m) => ({ id: m.name, name: m.description })).filter((m) => m.id)

    if (models.length > 0) {
      return { success: true, models }
    }
    return { success: false, models: [], error: 'Jev 未返回可用模型，请检查API Key权限' }
  } catch (error) {
    if (error.name === 'CanceledError' || error.name === 'AbortError') {
      return { success: false, models: [], error: '请求已取消' }
    }
    if (error.response?.status === 401) {
      return { success: false, models: [], error: 'API Key无效或未授权 (HTTP 401)', status: 401 }
    }
    const described = describeListError(error)
    return { success: false, models: [], error: described.message, status: described.status }
  } finally {
    releaseController(controller)
  }
}

export async function testJevConnection(config) {
  const startTime = Date.now()
  const result = await postJevSystemOne(config, {
    state: TEST_PROMPT,
    model: DEFAULT_MODEL,
    questions: {
      _connectivity: { type: 'noul', instructions: 'Is this message coherent?' },
    },
  })

  if (result.ok) {
    return {
      connected: true,
      connectTime: Date.now() - startTime,
      usedEndpoint: '/v1/systemone',
    }
  }

  const { error } = result
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
  if (error.response?.status === 529) {
    return {
      connected: false,
      connectTime: Date.now() - startTime,
      error: '服务暂时过载，请稍后重试 (529)',
      status: 529,
    }
  }
  if (error.response?.status === 422) {
    return {
      connected: true,
      connectTime: Date.now() - startTime,
      warning: 'API可访问，但请求校验未通过，测试模型可能不可用',
    }
  }

  return {
    connected: false,
    connectTime: Date.now() - startTime,
    error: extractJevError(error, config.baseUrl),
    status: error.response?.status,
  }
}

export async function testJevModelLatency(config, model) {
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const startTime = Date.now()
  const result = await postJevSystemOne(config, {
    state: TEST_PROMPT,
    model: modelId,
    questions: {
      _connectivity: { type: 'noul', instructions: 'Is this message coherent?' },
    },
  })

  if (result.ok) {
    return {
      model: modelId,
      latency: Date.now() - startTime,
      status: 'success',
    }
  }

  const { error } = result
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
  if (error.response?.status === 404 || error.response?.status === 422) {
    return {
      model: modelId,
      latency: -1,
      status: 'failed',
      error: `模型 ${modelId} 不存在或不可用`,
    }
  }

  return {
    model: modelId,
    latency: -1,
    status: 'failed',
    error: extractJevError(error, config.baseUrl),
  }
}

export async function testJevModels(config, models, concurrency = 5) {
  return runConcurrentBatch(models, (model) => testJevModelLatency(config, model), concurrency)
}

// Jev 是结构化决策模型（System One），聊天调用把最后一条用户消息作为 state，
// 通过一组 Noul/Choice 判定并返回结构化结果文本
export async function sendJevChat(config, { model = DEFAULT_MODEL, messages = [] }) {
  const state = lastUserMessage(messages)
  const modelName = (typeof model === 'string' ? model : model?.id || DEFAULT_MODEL).replace(
    /^models\//,
    '',
  )
  const result = await postJevSystemOne(config, {
    state,
    model: modelName,
    questions: {
      _coherent: { type: 'noul', instructions: 'Is the message clear and coherent?' },
      _sentiment: {
        type: 'choice',
        instructions: 'What is the overall sentiment of the message?',
        criteria: {
          positive: 'Positive, appreciative, or satisfied',
          neutral: 'Neutral or factual',
          negative: 'Negative, frustrated, or complaining',
        },
      },
    },
  })

  if (!result.ok) {
    throw result.error
  }

  const answers = result.data?.answers || {}
  const coherent = answers._coherent?.noul
  const sentiment = answers._sentiment?.choice

  return [
    `Jev 判定结果（模型 ${result.data?.model || modelName}）：`,
    `- 消息清晰度 (noul): ${coherent === undefined ? '-' : coherent.toFixed(3)}`,
    `- 情感倾向 (choice): ${sentiment || '-'}`,
    `- 置信度: ${answers._sentiment?.confidence !== undefined ? answers._sentiment.confidence.toFixed(3) : '-'}`,
  ].join('\n')
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return TEST_PROMPT
  const last = [...messages].reverse().find((m) => m.role === 'user')
  return last?.content || TEST_PROMPT
}
