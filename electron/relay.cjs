// 本地中转站：把多个上游（OpenAI 兼容）聚合成一个本地 OpenAI 兼容端点。
// 只监听 127.0.0.1，不对外暴露；转发时透传上游的响应体（含 SSE 流）。
const http = require('http')
const https = require('https')

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const MAX_BODY_BYTES = 20 * 1024 * 1024

let server = null
let config = { port: DEFAULT_PORT, providers: [] }

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

function openaiError(res, status, message, type = 'invalid_request_error') {
  json(res, status, { error: { message, type, code: status } })
}

function enabledProviders() {
  return (config.providers || []).filter((item) => item.enabled !== false && item.baseUrl)
}

// 聚合模型列表，同名模型只保留第一次出现的（按提供商顺序）
function listModelsFrom(providers = []) {
  const seen = new Set()
  const data = []
  for (const provider of providers.filter((item) => item.enabled !== false && item.baseUrl)) {
    for (const model of provider.models || []) {
      if (!model || seen.has(model)) continue
      seen.add(model)
      data.push({ id: model, object: 'model', created: 0, owned_by: provider.name || provider.id })
    }
  }
  return data
}

function listModels() {
  return listModelsFrom(config.providers)
}

// 路由：按配置顺序返回所有能提供该模型的上游，前面的优先（用于故障转移）
function resolveProvidersFrom(providers = [], model) {
  const usable = providers.filter((item) => item.enabled !== false && item.baseUrl)
  const matched = usable.filter((item) => (item.models || []).includes(model))
  if (matched.length > 0) return matched
  if (usable.length === 1) return usable
  return []
}

function resolveProviderFrom(providers = [], model) {
  return resolveProvidersFrom(providers, model)[0] || null
}

function resolveProvider(model) {
  return resolveProviderFrom(config.providers, model)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------- 并发与限流 ----------
// 每个上游独立计数：并发上限 + 每分钟请求数。超限时排队，排队超时或 RPM 用尽
// 视为「可重试」错误，交给故障转移换下一个上游。
const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_QUEUE_TIMEOUT_MS = 10000
const RPM_WINDOW_MS = 60000

const runtimeByProvider = new Map()

function getRuntime(provider) {
  const key = provider.id || provider.name || provider.baseUrl
  if (!runtimeByProvider.has(key)) {
    runtimeByProvider.set(key, { inflight: 0, hits: [], waiters: [] })
  }
  return runtimeByProvider.get(key)
}

function limitsOf(provider) {
  const maxConcurrency = Number(provider.maxConcurrency)
  const rpmLimit = Number(provider.rpmLimit)
  const queueTimeoutMs = Number(provider.queueTimeoutMs)
  return {
    maxConcurrency: maxConcurrency > 0 ? maxConcurrency : DEFAULT_MAX_CONCURRENCY,
    rpmLimit: rpmLimit > 0 ? rpmLimit : 0,
    queueTimeoutMs: queueTimeoutMs > 0 ? queueTimeoutMs : DEFAULT_QUEUE_TIMEOUT_MS,
  }
}

function rateLimitError(message, retryAfter = 1) {
  return Object.assign(new Error(message), {
    code: 'rate_limited',
    retryAfter,
    retryable: true,
  })
}

// 释放时把槽位直接转交给排队者，避免「先减后加」被别的请求抢走
function makeRelease(runtime) {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = runtime.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve()
    } else {
      runtime.inflight = Math.max(0, runtime.inflight - 1)
    }
  }
}

function acquireSlot(provider) {
  const runtime = getRuntime(provider)
  const { maxConcurrency, rpmLimit, queueTimeoutMs } = limitsOf(provider)
  const now = Date.now()

  // 滑动窗口：只保留最近 60 秒
  runtime.hits = runtime.hits.filter((at) => now - at < RPM_WINDOW_MS)

  if (rpmLimit > 0 && runtime.hits.length >= rpmLimit) {
    const oldest = runtime.hits[0] || now
    const retryAfter = Math.max(1, Math.ceil((RPM_WINDOW_MS - (now - oldest)) / 1000))
    return Promise.reject(rateLimitError(`每分钟请求数已达上限（${rpmLimit}）`, retryAfter))
  }

  if (runtime.inflight < maxConcurrency) {
    runtime.inflight += 1
    runtime.hits.push(now)
    return Promise.resolve(makeRelease(runtime))
  }

  // 并发已满 → 排队等槽位
  return new Promise((resolve, reject) => {
    const waiter = { resolve: null, reject: null, timer: null }

    waiter.timer = setTimeout(() => {
      runtime.waiters = runtime.waiters.filter((item) => item !== waiter)
      reject(rateLimitError(`并发已满（${maxConcurrency}），排队超时`, 1))
    }, queueTimeoutMs)

    waiter.resolve = () => {
      runtime.hits.push(Date.now())
      resolve(makeRelease(runtime))
    }
    waiter.reject = reject

    runtime.waiters.push(waiter)
  })
}

// 测试与重启用：清空所有上游的并发计数
function clearRuntime() {
  runtimeByProvider.clear()
}

function snapshotLoad() {
  const result = {}
  for (const provider of config.providers || []) {
    const key = provider.id || provider.name || provider.baseUrl
    const runtime = runtimeByProvider.get(key)
    const { maxConcurrency, rpmLimit } = limitsOf(provider)
    result[key] = {
      name: provider.name || key,
      inflight: runtime?.inflight || 0,
      maxConcurrency,
      rpmLimit,
      queued: runtime?.waiters.length || 0,
    }
  }
  return result
}

// ---------- 请求日志（内存环形缓冲，最多 200 条） ----------
const MAX_LOGS = 200
const logs = []

function pushLog(entry) {
  logs.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...entry })
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS
}

function getLogs() {
  return logs.slice()
}

function clearLogs() {
  logs.length = 0
}

// 单次尝试：成功则把上游响应透传给客户端并 resolve；
// 可重试的错误（429 / 5xx / 网络错误）reject，交给下一个上游。
async function attempt(provider, path, body, res, context) {
  // 限流/并发检查：超限直接抛 rate_limited，由上层决定是否换上游
  const release = await acquireSlot(provider)

  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(String(provider.baseUrl).replace(/\/+$/, '') + path)
    } catch {
      release()
      reject(new Error(`Base URL 无效：${provider.baseUrl}`))
      return
    }

    const transport = target.protocol === 'https:' ? https : http
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    }
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

    const startedAt = Date.now()
    let settled = false

    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers,
        timeout: 300000,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502
        const retryable = status === 429 || status >= 500

        // 可重试且还没向客户端写过任何东西 → 丢弃这个响应，换下一个上游
        if (retryable && !res.headersSent && context.canRetry) {
          upstreamRes.resume()
          settled = true
          release()
          reject(Object.assign(new Error(`HTTP ${status}`), { status, retryable: true }))
          return
        }

        res.writeHead(status, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
          'x-relay-provider': encodeURIComponent(provider.name || provider.id || ''),
        })

        upstreamRes.pipe(res)
        upstreamRes.on('end', () => {
          if (settled) return
          settled = true
          release()
          pushLog({
            at: new Date().toISOString(),
            model: context.model,
            provider: provider.name || provider.id,
            status,
            ms: Date.now() - startedAt,
            stream: String(upstreamRes.headers['content-type'] || '').includes('event-stream'),
            attempt: context.attempt,
            error: status >= 400 ? `HTTP ${status}` : null,
          })
          resolve({ status, provider })
        })
      },
    )

    upstream.on('timeout', () => {
      upstream.destroy(new Error('上游超时'))
    })

    upstream.on('error', (error) => {
      if (settled) return
      settled = true
      release()
      if (res.headersSent) {
        res.end()
        return
      }
      reject(error)
    })

    upstream.write(body)
    upstream.end()
  })
}

// 按顺序尝试多个上游；全部失败才向客户端报错
async function forwardWithFailover(providers, path, body, res, context) {
  let lastError = null
  let allRateLimited = true

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index]
    const attemptContext = {
      ...context,
      attempt: index + 1,
      canRetry: index < providers.length - 1,
    }

    const attemptStarted = Date.now()
    try {
      await attempt(provider, path, body, res, attemptContext)
      return
    } catch (error) {
      lastError = error
      if (error.code !== 'rate_limited') allRateLimited = false
      pushLog({
        at: new Date().toISOString(),
        model: context.model,
        provider: provider.name || provider.id,
        status: error.status || 0,
        ms: Date.now() - attemptStarted,
        stream: false,
        attempt: index + 1,
        error: error.message,
      })
      // 已经向客户端写过响应头就无法回退
      if (res.headersSent) return
    }
  }

  // 全部都是被本地限流挡下的：明确告诉客户端是 429 并给出重试间隔
  if (allRateLimited && lastError?.code === 'rate_limited') {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(lastError.retryAfter || 1),
      'Access-Control-Allow-Origin': '*',
    })
    res.end(
      JSON.stringify({
        error: {
          message: `所有上游都已被限流：${lastError.message}`,
          type: 'rate_limit_exceeded',
          code: 429,
        },
      }),
    )
    return
  }

  openaiError(res, 502, `所有上游均失败：${lastError?.message || '未知错误'}`, 'upstream_error')
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`)
  const path = url.pathname

  // 本地工具调用需要跨域（如浏览器里的 SDK 页面）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    })
    res.end()
    return
  }

  if (req.method === 'GET' && path === '/health') {
    json(res, 200, {
      status: 'ok',
      providers: enabledProviders().length,
      models: listModels().length,
    })
    return
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    json(res, 200, { object: 'list', data: listModels() })
    return
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch (error) {
      openaiError(res, 400, `请求体解析失败：${error.message}`)
      return
    }

    const model = payload?.model
    if (!model) {
      openaiError(res, 400, '缺少 model 字段')
      return
    }

    const providers = resolveProvidersFrom(config.providers, model)
    if (providers.length === 0) {
      openaiError(
        res,
        404,
        `没有提供商提供模型「${model}」。请在中转站里为该模型配置提供商，或只启用一个上游。`,
        'model_not_found',
      )
      return
    }

    forwardWithFailover(providers, '/chat/completions', JSON.stringify(payload), res, {
      model,
    })
    return
  }

  openaiError(res, 404, `未知路径：${path}`)
}

function start(nextConfig = {}) {
  // 允许显式传 0：让系统分配端口（冒烟/端口冲突时用）
  const requestedPort = nextConfig.port === 0 ? 0 : Number(nextConfig.port) || DEFAULT_PORT
  config = {
    port: requestedPort,
    providers: Array.isArray(nextConfig.providers) ? nextConfig.providers : [],
  }

  if (server) stop()

  return new Promise((resolve, reject) => {
    const instance = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        if (!res.headersSent) openaiError(res, 500, error.message)
        else res.end()
      })
    })

    instance.on('error', (error) => {
      server = null
      reject(error)
    })

    instance.listen(config.port, HOST, () => {
      server = instance
      // 允许传 0 让系统分配端口（测试与端口冲突时有用）
      const actualPort = instance.address()?.port ?? config.port
      config.port = actualPort
      resolve({ port: actualPort, baseUrl: `http://${HOST}:${actualPort}/v1` })
    })
  })
}

function stop() {
  if (!server) return
  try {
    server.close()
  } catch {
    // 已关闭
  }
  server = null
}

function update(nextConfig = {}) {
  if (Array.isArray(nextConfig.providers)) config.providers = nextConfig.providers
  return getStatus()
}

function getStatus() {
  return {
    running: Boolean(server),
    load: snapshotLoad(),
    port: config.port,
    baseUrl: `http://${HOST}:${config.port}/v1`,
    providers: enabledProviders().length,
    models: listModels().length,
  }
}

// 拉取某个上游的模型列表（用于「拉取模型」按钮）
function fetchModels({ baseUrl, apiKey }, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(String(baseUrl).replace(/\/+$/, '') + '/models')
    } catch {
      reject(new Error('Base URL 无效'))
      return
    }

    const transport = target.protocol === 'https:' ? https : http
    const headers = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers,
        timeout,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}：${text.slice(0, 200)}`))
            return
          }
          try {
            const parsed = JSON.parse(text)
            const list = Array.isArray(parsed?.data)
              ? parsed.data
              : Array.isArray(parsed?.models)
                ? parsed.models
                : []
            const models = list
              .map((item) => (typeof item === 'string' ? item : item?.id || item?.name))
              .filter(Boolean)
            resolve(models)
          } catch {
            reject(new Error('上游返回的不是合法 JSON'))
          }
        })
      },
    )

    request.on('timeout', () => request.destroy(new Error('请求超时')))
    request.on('error', reject)
    request.end()
  })
}

module.exports = {
  start,
  stop,
  update,
  getStatus,
  fetchModels,
  listModels,
  resolveProvider,
  listModelsFrom,
  resolveProviderFrom,
  resolveProvidersFrom,
  getLogs,
  clearLogs,
  snapshotLoad,
  limitsOf,
  clearRuntime,
}
