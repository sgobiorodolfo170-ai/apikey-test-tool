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

export async function testOpenAIConnection(config) {
  const { apiKey, baseUrl } = config
  const startTime = Date.now()
  const controller = createController()

  try {
    const testEndpoints = ['/chat/completions', '/v1/chat/completions']

    for (const endpoint of testEndpoints) {
      try {
        const url = buildUrl(baseUrl, endpoint)

        await axios.post(
          url,
          {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: TEST_PROMPT }],
            max_tokens: 5,
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
            warning: 'API可访问，但测试模型可能不存在',
          }
        }

        if (error.response?.status === 404) {
          continue
        }
      }
    }

    try {
      await axios.get(buildUrl(baseUrl, '/models'), {
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
        error: getErrorMessage(error, baseUrl),
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
    const listEndpoints = [
      {
        path: '/models',
        parser: (data) =>
          data.data?.map((m) => ({
            id: m.id,
            object: m.object,
            created: m.created,
            owned_by: m.owned_by,
          })),
      },
      {
        path: '/v1/models',
        parser: (data) =>
          data.data?.map((m) => ({
            id: m.id,
            object: m.object,
            created: m.created,
            owned_by: m.owned_by,
          })),
      },
      { path: '/v1/models/list', parser: (data) => data.data?.map((m) => ({ id: m.id })) },
    ]

    for (const endpoint of listEndpoints) {
      try {
        const url = buildUrl(baseUrl, endpoint.path)
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: TIMEOUT,
          signal: controller.signal,
        })

        const models = endpoint.parser(response.data)

        if (models && models.length > 0) {
          return { success: true, models }
        }
      } catch (error) {
        if (error.name === 'CanceledError' || error.name === 'AbortError') {
          return { success: false, models: [], error: '请求已取消' }
        }
        console.log('获取模型列表失败:', endpoint.path, error.response?.status)
      }
    }

    return { success: false, models: [], error: '无法获取模型列表，请手动输入模型名称测试' }
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

        await axios.post(
          url,
          {
            model: modelId,
            messages: [{ role: 'user', content: TEST_PROMPT }],
            max_tokens: 5,
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
          error: getErrorMessage(error, baseUrl),
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

export async function testAllModelsConcurrently(config, models, concurrency = 5) {
  return runConcurrentBatch(models, (model) => testModelLatency(config, model), concurrency)
}
