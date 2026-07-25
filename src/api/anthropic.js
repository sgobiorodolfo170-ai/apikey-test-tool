import axios from 'axios'
import {
  buildUrl,
  getErrorMessage,
  createController,
  releaseController,
  runConcurrentBatch,
} from './utils.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000

export { cancelAllRequests } from './utils.js'

export async function testAnthropicConnection(config) {
  const { apiKey, baseUrl } = config
  const startTime = Date.now()
  const controller = createController()

  try {
    await axios.post(
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
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
      { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
      { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
      { id: 'claude-2.1', name: 'Claude 2.1' },
      { id: 'claude-2.0', name: 'Claude 2.0' },
      { id: 'claude-instant-1.2', name: 'Claude Instant' },
    ],
  }
}

export async function testAnthropicModelLatency(config, model) {
  const { apiKey, baseUrl } = config
  const modelId = typeof model === 'string' ? model : model.id || model.name
  const startTime = Date.now()
  const controller = createController()

  try {
    await axios.post(
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
