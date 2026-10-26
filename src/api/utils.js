const activeControllers = new Set()

export function cancelAllRequests() {
  activeControllers.forEach((controller) => {
    if (controller && !controller.signal.aborted) {
      controller.abort()
    }
  })
  activeControllers.clear()
}

export function createController() {
  const controller = new AbortController()
  activeControllers.add(controller)
  return controller
}

export function releaseController(controller) {
  activeControllers.delete(controller)
}

export function buildUrl(baseUrl, path) {
  baseUrl = baseUrl.replace(/\/$/, '')
  path = path.startsWith('/') ? path : '/' + path
  return baseUrl + path
}

export function isAbortError(error) {
  return (
    error?.name === 'CanceledError' ||
    error?.name === 'AbortError' ||
    error?.code === 'ERR_CANCELED'
  )
}

// 流式调用用：外部传入 signal 时只借用不接管，否则自建并注册到全局取消表
export function acquireSignal(externalSignal) {
  if (externalSignal) return { signal: externalSignal, release: () => {} }
  const controller = createController()
  return { signal: controller.signal, release: () => releaseController(controller) }
}

// OpenAI 兼容协议的标准错误体: {"error": {"message": "...", "type": "...", "code": "..."}}
export function extractProviderError(error) {
  let data = error?.response?.data
  if (!data) return null
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return data || null
    }
  }
  if (typeof data !== 'object' || data === null) return null
  const err = data.error
  if (typeof err === 'string') return err
  if (err?.message) return err.message
  if (data.message) return data.message
  return null
}

export function describeListError(error) {
  const status = error.response?.status
  if (status === 401) return { status, message: 'API Key无效或未授权 (HTTP 401)' }
  if (status === 403) return { status, message: '无权访问模型列表 (HTTP 403)，请检查API Key权限' }
  if (status === 404)
    return { status, message: '未找到模型列表端点 (HTTP 404)，请检查Base URL路径' }
  if (status) return { status, message: `请求失败 (HTTP ${status})` }

  const code = error.code || ''
  if (code === 'ERR_NETWORK')
    return { message: '网络请求被拦截(CORS)或网络不可达，可尝试在桌面应用中测试' }
  if (code === 'ENOTFOUND') return { message: '无法解析域名，请检查Base URL' }
  if (code === 'ECONNREFUSED') return { message: '连接被拒绝，请检查Base URL' }
  if (code === 'ECONNABORTED') return { message: '请求超时，请稍后重试' }
  return { message: error.message || '未知网络错误' }
}

export function getErrorMessage(error, baseUrl) {
  if (error.code === 'ECONNREFUSED') {
    return `连接被拒绝，请检查Base URL是否正确: ${baseUrl}`
  }
  if (error.code === 'ENOTFOUND') {
    return `无法解析域名，请检查Base URL: ${baseUrl}`
  }
  if (error.response?.status === 404) {
    return `404错误，请检查Base URL路径是否正确: ${baseUrl}`
  }
  if (error.response?.status === 401) {
    return `401未授权，API Key无效`
  }
  if (error.response?.status === 403) {
    return `403禁止访问，请检查API Key权限`
  }
  if (error.response?.status === 429) {
    return `429请求过多，请稍后再试`
  }
  return error.message || '未知错误'
}

export async function runConcurrentBatch(items, fn, concurrency = 5) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

export async function fireAll(count, fn, signal) {
  const promises = []
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break
    promises.push(fn(i))
  }
  return Promise.all(promises)
}
