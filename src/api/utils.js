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
