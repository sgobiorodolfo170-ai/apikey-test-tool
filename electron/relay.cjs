// 本地中转站：把多个上游（OpenAI 兼容）聚合成一个本地 OpenAI 兼容端点。
// 只监听 127.0.0.1，不对外暴露；转发时透传上游的响应体（含 SSE 流）。
const http = require('http')
const https = require('https')
const fs = require('fs')
const crypto = require('crypto')

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const MAX_BODY_BYTES = 20 * 1024 * 1024
// 响应体捕获上限：超过后不再计入缓存 / usage 解析，避免把残缺响应写进缓存
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024

let server = null
let stopPromise = null
// 进行中的上游请求：停止服务时统一销毁，避免残留连接占用并发槽位
const activeUpstreams = new Set()
let config = {
  port: DEFAULT_PORT,
  providers: [],
  apiKey: '',
  clientKeys: [],
  sticky: false,
}

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

// 一个上游可以配多个 Key：apiKeys 为主，apiKey 兼容旧数据（存的是第一个 Key）
function apiKeysOf(source) {
  const list = Array.isArray(source?.apiKeys) ? source.apiKeys : []
  const keys = [...list, source?.apiKey]
    .map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter(Boolean)
  return [...new Set(keys)]
}

// 每个请求从下一个 Key 开始，多个 Key 自然分担；一个 Key 失败再切同上游的其它 Key
const keyCursor = new Map()

function orderedKeysOf(provider) {
  const keys = apiKeysOf(provider)
  if (keys.length <= 1) return keys
  const cursorKey = provider.id || provider.baseUrl
  const start = keyCursor.get(cursorKey) || 0
  keyCursor.set(cursorKey, (start + 1) % keys.length)
  return [...keys.slice(start), ...keys.slice(0, start)]
}

function sameProvider(a, b) {
  return Boolean(a && b) && (a.id || a.baseUrl) === (b.id || b.baseUrl)
}

// ---------- 本地访问 Key：默认 Key + 可选的多客户端 Key（区分工具 / 便于归因） ----------
// 与 src/utils/relayConfig.js 的 normalizeClientKeys 保持同口径
function normalizeClientKeys(input) {
  const list = Array.isArray(input) ? input : []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const key = typeof item?.key === 'string' ? item.key.trim() : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    const label = typeof item?.label === 'string' ? item.label.trim() : ''
    result.push({ key, label: label || `客户端${result.length + 1}` })
  }
  return result
}

// 返回 { ok, label }：默认 Key 记为「默认」，多客户端 Key 用其名称，免鉴权记为「本机」
function identifyClient(req) {
  const auth = String(req.headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const hasAnyKey = Boolean(config.apiKey) || config.clientKeys.length > 0
  if (!hasAnyKey) return { ok: true, label: '本机' }
  if (config.apiKey && token === config.apiKey) return { ok: true, label: '默认' }
  const match = config.clientKeys.find((item) => item.key === token)
  if (match) return { ok: true, label: match.label }
  return { ok: false, label: '' }
}

// ---------- 会话粘性 ----------
// 优先用显式会话标识；没有时退化为「前两条消息」的哈希，保证同一会话的前缀稳定
function stickyKeyOf(req, payload) {
  const header = String(
    req.headers['x-session-id'] || req.headers['x-conversation-id'] || '',
  ).trim()
  if (header) return header
  if (typeof payload?.user === 'string' && payload.user.trim()) return payload.user.trim()
  const conversation = payload?.conversation_id || payload?.conversation
  if (typeof conversation === 'string' && conversation.trim()) return conversation.trim()
  if (conversation && typeof conversation === 'object' && typeof conversation.id === 'string') {
    return conversation.id.trim()
  }
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  if (messages.length === 0) return ''
  const head = messages
    .slice(0, 2)
    .map((message) => {
      const content =
        typeof message?.content === 'string'
          ? message.content
          : JSON.stringify(message?.content ?? '')
      return `${message?.role || ''}:${content}`
    })
    .join('\n')
  return head.slice(0, 4096)
}

function stickyHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest().readUInt32BE(0)
}

// 粘性只决定「首选候选」，故障转移链保持完整：命中的候选挪到队首，其余顺序不变。
// 用「提供商 + Key」的稳定标识做哈希，避免 Key 轮询改变首选结果
function candidateIdOf(item) {
  return `${item?.id || item?.baseUrl || ''}::${item?.apiKey || ''}`
}

function applySticky(candidates, stickyKey, pool = candidates) {
  if (!config.sticky || !stickyKey || candidates.length <= 1) return candidates
  const source = pool.length > 0 ? pool : candidates
  const ids = source.map(candidateIdOf).sort()
  const target = ids[stickyHash(stickyKey) % ids.length]
  const index = candidates.findIndex((item) => candidateIdOf(item) === target)
  if (index <= 0) return candidates
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)]
}

// 把「提供商 × 它的每个 Key」展开成候选链，交给故障转移逐个尝试
function expandKeyCandidates(providers = []) {
  const candidates = []
  for (const provider of providers) {
    const keys = orderedKeysOf(provider)
    if (keys.length === 0) {
      candidates.push({ ...provider, apiKey: '' })
      continue
    }
    for (const key of keys) candidates.push({ ...provider, apiKey: key })
  }
  return candidates
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
    // 模型别名也对外暴露，客户端可以直接请求别名
    for (const alias of Object.keys(provider.modelAliases || {})) {
      if (!alias || seen.has(alias)) continue
      seen.add(alias)
      data.push({ id: alias, object: 'model', created: 0, owned_by: provider.name || provider.id })
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
  const matched = usable.filter(
    (item) =>
      (item.models || []).includes(model) ||
      Object.prototype.hasOwnProperty.call(item.modelAliases || {}, model),
  )
  if (matched.length > 0) return matched
  // 没有任何模型列表的上游视为“通配”：用户刚添加、还没拉取模型时也能直接路由，
  // 避免多上游场景下全部 404。明确列了模型但不匹配的上游仍不会被选中。
  const unlisted = usable.filter((item) => !Array.isArray(item.models) || item.models.length === 0)
  if (unlisted.length > 0) return unlisted
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
    runtimeByProvider.set(key, { inflight: 0, streaming: 0, hits: [], waiters: [] })
  }
  return runtimeByProvider.get(key)
}

function limitsOf(provider) {
  const maxConcurrency = Number(provider.maxConcurrency)
  const rpmLimit = Number(provider.rpmLimit)
  const queueTimeoutMs = Number(provider.queueTimeoutMs)
  const limit = maxConcurrency > 0 ? maxConcurrency : DEFAULT_MAX_CONCURRENCY
  return {
    maxConcurrency: limit,
    rpmLimit: rpmLimit > 0 ? rpmLimit : 0,
    queueTimeoutMs: queueTimeoutMs > 0 ? queueTimeoutMs : DEFAULT_QUEUE_TIMEOUT_MS,
    // 流式请求最多占用 maxConcurrency - 1 个槽位，始终给普通请求留一个，避免长流饿死短请求
    maxStreams: Math.max(1, limit - 1),
  }
}

function rateLimitError(message, retryAfter = 1) {
  return Object.assign(new Error(message), {
    code: 'rate_limited',
    retryAfter,
    retryable: true,
  })
}

// 释放时把槽位直接转交给排队者，避免「先减后加」被别的请求抢走；
// 流式与普通请求分开记账，转交时按接手者的类型调整流式计数
function drainWaiter(runtime) {
  for (let index = 0; index < runtime.waiters.length; index += 1) {
    const waiter = runtime.waiters[index]
    if (runtime.inflight >= waiter.maxConcurrency) continue
    if (waiter.streaming && runtime.streaming >= waiter.maxStreams) continue
    runtime.waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    runtime.inflight += 1
    if (waiter.streaming) runtime.streaming += 1
    waiter.resolve(makeRelease(runtime, waiter.streaming))
    return true
  }
  return false
}

function makeRelease(runtime, streaming = false) {
  let released = false
  return () => {
    if (released) return
    released = true
    runtime.inflight = Math.max(0, runtime.inflight - 1)
    if (streaming) runtime.streaming = Math.max(0, runtime.streaming - 1)
    drainWaiter(runtime)
  }
}

function acquireSlot(provider, streaming = false) {
  const runtime = getRuntime(provider)
  const { maxConcurrency, rpmLimit, queueTimeoutMs, maxStreams } = limitsOf(provider)
  const now = Date.now()

  // 滑动窗口：只保留最近 60 秒
  runtime.hits = runtime.hits.filter((at) => now - at < RPM_WINDOW_MS)

  if (rpmLimit > 0 && runtime.hits.length >= rpmLimit) {
    const oldest = runtime.hits[0] || now
    const retryAfter = Math.max(1, Math.ceil((RPM_WINDOW_MS - (now - oldest)) / 1000))
    return Promise.reject(rateLimitError(`每分钟请求数已达上限（${rpmLimit}）`, retryAfter))
  }

  const canStart =
    runtime.inflight < maxConcurrency && (!streaming || runtime.streaming < maxStreams)
  if (canStart) {
    runtime.inflight += 1
    if (streaming) runtime.streaming += 1
    runtime.hits.push(now)
    return Promise.resolve(makeRelease(runtime, streaming))
  }

  // 并发已满（或流式槽位已满）→ 排队等槽位
  return new Promise((resolve, reject) => {
    const waiter = {
      streaming,
      maxConcurrency,
      maxStreams,
      resolve: null,
      reject: null,
      timer: null,
    }

    waiter.timer = setTimeout(() => {
      runtime.waiters = runtime.waiters.filter((item) => item !== waiter)
      const message = streaming
        ? `流式并发已满（上限 ${maxStreams}），排队超时`
        : `并发已满（${maxConcurrency}），排队超时`
      reject(rateLimitError(message, 1))
    }, queueTimeoutMs)

    waiter.resolve = (release) => {
      runtime.hits.push(Date.now())
      resolve(release)
    }
    waiter.reject = reject

    runtime.waiters.push(waiter)
    drainWaiter(runtime)
  })
}

// 测试与重启用：清空所有上游的并发计数
function clearRuntime() {
  runtimeByProvider.clear()
  keyCursor.clear()
  resetQuota()
}

function snapshotLoad() {
  const result = {}
  for (const provider of config.providers || []) {
    const key = provider.id || provider.name || provider.baseUrl
    const runtime = runtimeByProvider.get(key)
    const { maxConcurrency, maxStreams, rpmLimit } = limitsOf(provider)
    result[key] = {
      name: provider.name || key,
      inflight: runtime?.inflight || 0,
      streaming: runtime?.streaming || 0,
      maxConcurrency,
      maxStreams,
      rpmLimit,
      queued: runtime?.waiters.length || 0,
    }
  }
  return result
}

// ---------- 请求日志（内存环形缓冲，最多 200 条） ----------
const MAX_LOGS = 200
const logs = []

function newRequestId() {
  return `req_${crypto.randomUUID()}`
}

function keyTailOf(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey : ''
  return key ? key.slice(-6) : ''
}

function pushLog(entry) {
  logs.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...entry })
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS
  schedulePersist()
}

function getLogs() {
  return logs.slice()
}

function clearLogs() {
  logs.length = 0
  return persistNow()
}

// ---------- 调用监控（按 提供商 + 模型 聚合，内存） ----------
const MAX_STATS = 200
const statsByKey = new Map()

function statsKeyOf(provider, model) {
  return `${provider?.id || provider?.name || provider?.baseUrl || 'unknown'}::${model || 'unknown'}`
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0
  const total = Number(usage.total_tokens) || prompt + completion
  if (prompt <= 0 && completion <= 0 && total <= 0) return null
  return { prompt, completion, total }
}

// 普通 JSON 取 usage 字段；SSE 取最后一条带 usage 的事件
function extractUsage(chunks, contentType = '') {
  if (!chunks || chunks.length === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  if (contentType.includes('event-stream')) {
    let usage = null
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload)
        if (parsed?.usage) usage = parsed.usage
      } catch {
        // 忽略非 JSON 行
      }
    }
    return normalizeUsage(usage)
  }
  try {
    return normalizeUsage(JSON.parse(text)?.usage)
  } catch {
    return null
  }
}

function recordStat({ provider, model, status, ms, error, usage }) {
  const key = statsKeyOf(provider, model)
  const at = new Date().toISOString()
  const ok = !error && status >= 200 && status < 400
  let entry = statsByKey.get(key)
  if (!entry) {
    entry = {
      id: key,
      provider: provider?.name || provider?.id || '未知提供商',
      model: model || '未知模型',
      total: 0,
      success: 0,
      totalMs: 0,
      avgMs: 0,
      lastStatus: 'success',
      lastHttpStatus: 0,
      lastMs: 0,
      lastAt: at,
      usage: null,
    }
    statsByKey.set(key, entry)
  }
  entry.total += 1
  if (ok) entry.success += 1
  entry.totalMs += Math.max(0, ms || 0)
  entry.avgMs = Math.round(entry.totalMs / entry.total)
  entry.lastMs = Math.max(0, ms || 0)
  entry.lastAt = at
  entry.lastHttpStatus = status || 0
  entry.lastStatus = ok
    ? 'success'
    : status === 429 || error?.code === 'rate_limited'
      ? 'rate_limited'
      : 'failed'
  if (usage) entry.usage = usage

  if (statsByKey.size > MAX_STATS) {
    const oldest = [...statsByKey.entries()].sort((a, b) =>
      String(a[1].lastAt).localeCompare(String(b[1].lastAt)),
    )[0]
    if (oldest) statsByKey.delete(oldest[0])
  }
  schedulePersist()
}

function getStats() {
  return [...statsByKey.values()]
    .map((item) => ({ ...item }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
}

function clearStats() {
  statsByKey.clear()
  return persistNow()
}

// ---------- 持久化（日志与统计） ----------
const MAX_PERSIST_LOGS = 200
// 每个提供商最多保存多少条额度事件（一周内调用量上限，超出放弃最早的记录）
const MAX_PERSIST_QUOTA_EVENTS = 30000
let dataFile = null
let persistTimer = null
// 串行化异步写盘：避免多次 persist 互相覆盖临时文件
let persistChain = Promise.resolve()
let persistSeq = 0

// 由主进程在 app ready 后挂载文件，启动时恢复上次的日志与统计
function attachStorage(file) {
  dataFile = file
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    if (Array.isArray(raw.logs)) {
      logs.splice(0, logs.length, ...raw.logs.slice(0, MAX_PERSIST_LOGS))
    }
    if (Array.isArray(raw.stats)) {
      statsByKey.clear()
      for (const item of raw.stats.slice(0, MAX_STATS)) {
        if (item && item.id) statsByKey.set(item.id, item)
      }
    }
    // 额度用量按提供商恢复（重启后不会因为清零而超额多打上游）
    if (Array.isArray(raw.quota)) {
      quotaByProvider.clear()
      const now = Date.now()
      for (const entry of raw.quota) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const events = Array.isArray(entry[1])
          ? entry[1].filter(
              (item) => item && Number.isFinite(item.at) && Number.isFinite(item.units),
            )
          : []
        if (events.length === 0) continue
        quotaByProvider.set(entry[0], { events: pruneQuotaEvents(events, now) })
      }
    }
    // 额度锁同样要恢复：否则重启后被判定耗尽 5h/7d 的 Key 会继续打上游
    if (Array.isArray(raw.locks)) {
      quotaLocks.clear()
      const now = Date.now()
      for (const entry of raw.locks) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const lock = entry[1]
        if (!lock || !Number.isFinite(lock.until) || lock.until <= now) continue
        quotaLocks.set(entry[0], {
          until: lock.until,
          level: lock.level === 'week' ? 'week' : '5h',
          at: Number(lock.at) || now,
        })
      }
    }
  } catch {
    // 首次运行或文件损坏：忽略
  }
}

function persistNow({ sync = false } = {}) {
  if (!dataFile) return Promise.resolve()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const quota = [...quotaByProvider.entries()]
    .filter(([, state]) => state.events.length > 0)
    .map(([key, state]) => [key, state.events.slice(-MAX_PERSIST_QUOTA_EVENTS)])
  const locks = [...quotaLocks.entries()].filter(([, lock]) => lock.until > Date.now())
  let payload
  try {
    payload = JSON.stringify({
      logs: logs.slice(0, MAX_PERSIST_LOGS),
      stats: getStats(),
      quota,
      locks,
    })
  } catch {
    return Promise.resolve()
  }

  const tmp = `${dataFile}.tmp-${process.pid}-${++persistSeq}`
  // 退出时用同步写，避免异步链还没跑完进程就结束
  if (sync) {
    try {
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, dataFile)
    } catch {
      // 退出阶段写盘失败不再处理
    }
    return Promise.resolve()
  }

  persistChain = persistChain.then(async () => {
    try {
      await fs.promises.writeFile(tmp, payload, 'utf8')
      await fs.promises.rename(tmp, dataFile)
    } catch {
      // 写盘失败不影响转发
      try {
        await fs.promises.unlink(tmp)
      } catch {
        // 临时文件可能未创建
      }
    }
  })
  return persistChain
}

function schedulePersist() {
  if (!dataFile || persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, 800)
}

// ---------- 额度窗口（5 小时 / 7 天） ----------
// 商汤 Token Plan：按模型每 5 小时限次（如 6.8 Flash Lite 1500 次、DeepSeek V4 Flash 150 次），周额度为 5 小时额度的 10 倍；
// 端砚墨点计划：5 小时最多 10 墨点、7 天最多 50 墨点，墨点按模型单价扣，这里用 tokens × 单价估算。
const QUOTA_WINDOW_5H_MS = 5 * 60 * 60 * 1000
const QUOTA_WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000

const quotaByProvider = new Map()

// 与 src/utils/relayConfig.js 的 normalizeQuota 保持同口径
function normalizeQuota(input) {
  const metric = input?.metric === 'credit' ? 'credit' : 'request'
  const limit5h = Math.max(0, Number(input?.limit5h) || 0)
  const limitWeek = Math.max(0, Number(input?.limitWeek) || 0)
  const creditsPerMillionTokens = Math.max(0, Number(input?.creditsPerMillionTokens) || 0)
  const confirmStrikes = Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0)))
  const confirmIntervalMinutes = Math.max(0, Number(input?.confirmIntervalMinutes) || 0)
  return {
    enabled: input?.enabled === true && (limit5h > 0 || limitWeek > 0),
    metric,
    limit5h,
    limitWeek,
    creditsPerMillionTokens,
    confirmStrikes,
    confirmIntervalMinutes,
  }
}

// 每把 Key 是一个独立账号：额度按「提供商 + Key」单独记账，互不影响
function providerKeyOf(provider) {
  return provider?.id || provider?.name || provider?.baseUrl || 'unknown'
}

function quotaKeyOf(provider) {
  return `${providerKeyOf(provider)}::${provider?.apiKey || ''}`
}

function quotaStateOf(provider) {
  const key = quotaKeyOf(provider)
  if (!quotaByProvider.has(key)) quotaByProvider.set(key, { events: [] })
  return quotaByProvider.get(key)
}

function pruneQuotaEvents(events, now) {
  const cutoff = now - QUOTA_WINDOW_WEEK_MS
  while (events.length > 0 && events[0].at <= cutoff) events.shift()
  return events
}

function quotaUsageOf(provider) {
  const now = Date.now()
  const events = pruneQuotaEvents(quotaStateOf(provider).events, now)
  let used5h = 0
  let usedWeek = 0
  for (const item of events) {
    usedWeek += item.units
    if (item.at > now - QUOTA_WINDOW_5H_MS) used5h += item.units
  }
  return { used5h, usedWeek, events }
}

// 返回 null 表示还有额度；否则给出窗口与最早恢复时间（滑动窗口，按最早一笔用量滑出计算）
function quotaBlocked(provider) {
  const quota = provider?.quota
  if (!quota?.enabled) return null
  // 已被「多次 429」判定为额度耗尽：直接等到窗口重置
  const locked = quotaLocked(provider)
  if (locked) {
    return {
      window: locked.level,
      retryAfter: Math.max(1, Math.ceil((locked.until - Date.now()) / 1000)),
      locked: true,
    }
  }
  const now = Date.now()
  const { used5h, usedWeek, events } = quotaUsageOf(provider)
  if (quota.limit5h > 0 && used5h >= quota.limit5h) {
    const oldest = events.find((item) => item.at > now - QUOTA_WINDOW_5H_MS)
    return {
      window: '5h',
      retryAfter: oldest
        ? Math.max(1, Math.ceil((oldest.at + QUOTA_WINDOW_5H_MS - now) / 1000))
        : 1,
    }
  }
  if (quota.limitWeek > 0 && usedWeek >= quota.limitWeek) {
    const oldest = events[0]
    return {
      window: 'week',
      retryAfter: oldest
        ? Math.max(1, Math.ceil((oldest.at + QUOTA_WINDOW_WEEK_MS - now) / 1000))
        : 1,
    }
  }
  return null
}

// 只对真正被上游受理 / 计费的调用记账：参数与鉴权错误不占额度
function recordQuota(provider, { status, usage }) {
  const quota = provider?.quota
  if (!quota?.enabled) return
  let units
  if (quota.metric === 'credit') {
    if (status >= 400) return
    const tokens = Number(usage?.total) || 0
    if (tokens <= 0 || quota.creditsPerMillionTokens <= 0) return
    units = (tokens * quota.creditsPerMillionTokens) / 1_000_000
  } else {
    // 400/401/403 是请求本身或鉴权问题，429/5xx 也未被上游正常受理；
    // 这些都不占“请求次数”额度，避免被限流后额度反而被提前耗尽
    if (status === 400 || status === 401 || status === 403) return
    if (status === 429 || status >= 500) return
    units = 1
  }
  if (units <= 0) return
  quotaStateOf(provider).events.push({ at: Date.now(), units })
  schedulePersist()
}

function resetQuota(providerKey) {
  if (providerKey) {
    quotaByProvider.delete(providerKey)
    quotaStrikes.delete(providerKey)
    quotaLocks.delete(providerKey)
  } else {
    quotaByProvider.clear()
    quotaStrikes.clear()
    quotaLocks.clear()
  }
}

// ---------- 429 撞墙判定（防误判） ----------
// 单次 429 可能只是瞬时限流：必须「有间隔的多次 429」才认定该 Key 的额度窗口用尽，
// 认定后该 Key 暂停到窗口重置（先按 5 小时，5 小时后再撞墙则升级为 7 天）
const DEFAULT_QUOTA_STRIKES = 3
const DEFAULT_QUOTA_INTERVAL_MINUTES = 1

const quotaStrikes = new Map()
const quotaLocks = new Map()

function strikeConfigOf(provider) {
  const strikes = Number(provider?.quota?.confirmStrikes)
  const interval = Number(provider?.quota?.confirmIntervalMinutes)
  return {
    strikes: strikes > 0 ? Math.min(10, Math.floor(strikes)) : DEFAULT_QUOTA_STRIKES,
    intervalMs: (interval > 0 ? interval : DEFAULT_QUOTA_INTERVAL_MINUTES) * 60 * 1000,
  }
}

function quotaLocked(provider) {
  const key = quotaKeyOf(provider)
  const entry = quotaLocks.get(key)
  if (!entry) return null
  if (entry.until <= Date.now()) return null
  return entry
}

// 记录一次 429；返回新产生的锁定（或 null）。间隔不足的 429 只刷新计时，不重复计数
function noteQuotaHit(provider) {
  if (!provider?.quota?.enabled) return null
  const key = quotaKeyOf(provider)
  const { strikes, intervalMs } = strikeConfigOf(provider)
  const now = Date.now()
  const state = quotaStrikes.get(key) || { hits: [], lastAt: 0, level: '' }

  if (state.lastAt && now - state.lastAt < intervalMs) {
    state.lastAt = now
    quotaStrikes.set(key, state)
    return null
  }

  state.hits.push(now)
  state.lastAt = now
  if (state.hits.length > strikes) state.hits.shift()

  const confirmed =
    state.hits.length >= strikes &&
    state.hits[state.hits.length - 1] - state.hits[0] >= intervalMs * (strikes - 1)
  if (!confirmed) {
    quotaStrikes.set(key, state)
    return null
  }

  // 已按 5 小时锁过一次、解锁后仍撞墙 → 判定为周额度
  const level = state.level === '5h' ? 'week' : state.level || '5h'
  const until = now + (level === 'week' ? QUOTA_WINDOW_WEEK_MS : QUOTA_WINDOW_5H_MS)
  const lock = { until, level, at: now }
  quotaLocks.set(key, lock)
  quotaStrikes.set(key, { hits: [], lastAt: 0, level })
  return lock
}

function snapshotQuota() {
  const list = []
  const round = (value) => Math.round(value * 100) / 100
  for (const provider of config.providers || []) {
    if (!provider.quota?.enabled) continue
    const keys = apiKeysOf(provider)
    const entries = keys.length > 0 ? keys : ['']
    for (const key of entries) {
      const candidate = { ...provider, apiKey: key }
      const usage = quotaUsageOf(candidate)
      const blocked = quotaBlocked(candidate)
      list.push({
        // 只暴露 Key 尾号，避免把完整 Key 传到渲染进程
        id: `${providerKeyOf(provider)}#${keyTailOf(key)}`,
        providerId: providerKeyOf(provider),
        name: provider.name || provider.id,
        keyTail: keyTailOf(key),
        metric: provider.quota.metric,
        used5h: round(usage.used5h),
        limit5h: provider.quota.limit5h,
        usedWeek: round(usage.usedWeek),
        limitWeek: provider.quota.limitWeek,
        exhausted: Boolean(blocked),
        locked: Boolean(blocked?.locked),
        window: blocked?.window || '',
        retryAfter: blocked?.retryAfter || 0,
      })
    }
  }
  return list
}

// ---------- 冷却 / 熔断 ----------
const cooldownByKey = new Map()
const COOLDOWN_BASE_MS = 5000
const COOLDOWN_MAX_MS = 60000

function cooldownKeyOf(provider) {
  return `${provider?.id || provider?.name || provider?.baseUrl || 'unknown'}::${provider?.apiKey || ''}`
}

function coolingUntil(provider) {
  const key = cooldownKeyOf(provider)
  const entry = cooldownByKey.get(key)
  if (!entry) return 0
  if (entry.until <= Date.now()) {
    cooldownByKey.delete(key)
    return 0
  }
  return entry.until
}

function markFailure(provider, retryAfterMs = 0) {
  const key = cooldownKeyOf(provider)
  const entry = cooldownByKey.get(key) || { failCount: 0, until: 0 }
  entry.failCount += 1
  const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (entry.failCount - 1))
  entry.until = Date.now() + Math.max(backoff, retryAfterMs)
  cooldownByKey.set(key, entry)
}

function markSuccess(provider) {
  cooldownByKey.delete(cooldownKeyOf(provider))
}

function clearCooldowns() {
  cooldownByKey.clear()
}

function snapshotCooling() {
  const now = Date.now()
  const list = []
  for (const [key, entry] of cooldownByKey) {
    if (entry.until <= now) continue
    list.push({
      key,
      failCount: entry.failCount,
      until: entry.until,
      retryAfter: Math.ceil((entry.until - now) / 1000),
    })
  }
  return list
}

// ---------- 精确缓存（仅非流式响应） ----------
const cacheEntries = new Map()
let cacheSeq = 0

function cacheKeyOf(model, body) {
  return crypto.createHash('sha256').update(`${model}\n${body}`).digest('hex')
}

function cacheGet(key) {
  const entry = cacheEntries.get(key)
  if (!entry) return null
  if (entry.at + entry.ttlMs <= Date.now()) {
    cacheEntries.delete(key)
    return null
  }
  return entry
}

function cacheSet(key, value, maxEntries = 200) {
  cacheSeq += 1
  cacheEntries.set(key, { ...value, seq: cacheSeq })
  if (cacheEntries.size > maxEntries) {
    const oldest = [...cacheEntries.entries()].sort((a, b) => a[1].seq - b[1].seq)[0]
    if (oldest) cacheEntries.delete(oldest[0])
  }
}

function clearCache() {
  cacheEntries.clear()
}

// 命中缓存时换一个新的响应 id / 时间戳：缓存是跨会话共享的，直接回放旧 id
// 会让不同会话看到同一条消息，客户端若按 id 去重就会误判
function rewriteCachedBody(hit) {
  let parsed
  try {
    parsed = JSON.parse(hit.body.toString('utf8'))
  } catch {
    return hit.body
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return hit.body
  if (typeof parsed.id !== 'string' || !parsed.id) return hit.body
  const prefix = parsed.id.split('-')[0] || 'chatcmpl'
  parsed.id = `${prefix}-${crypto.randomUUID()}`
  parsed.created = Math.floor(Date.now() / 1000)
  return JSON.stringify(parsed)
}

function sendCachedResponse(res, hit) {
  res.writeHead(hit.status, {
    'Content-Type': hit.contentType || 'application/json',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'x-relay-provider': 'cache',
    'x-relay-cache': 'hit',
  })
  res.end(rewriteCachedBody(hit))
}

// 单次尝试：成功则把上游响应透传给客户端并 resolve；
// 可重试的错误（429 / 5xx / 网络错误）reject，交给下一个上游。
async function attempt(provider, path, body, res, context) {
  // 额度窗口（5 小时 / 7 天）已用尽：不再打上游，交给上层换下一个提供商
  const blocked = quotaBlocked(provider)
  if (blocked) {
    const label = blocked.window === '5h' ? '5 小时' : '7 天'
    throw Object.assign(new Error(`额度已用尽（${label}窗口）`), {
      code: 'quota_exceeded',
      status: 429,
      retryAfter: blocked.retryAfter,
      providerName: provider.name || provider.id,
    })
  }

  // 限流/并发检查：超限直接抛 rate_limited，由上层决定是否换上游
  const release = await acquireSlot(provider, context.streaming === true)

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
    let upstream = null

    // 客户端断开（取消 / 关闭窗口）时立即释放槽位并中断上游，避免幽灵请求占用并发
    const abortByClient = () => {
      if (settled || res.writableEnded) return
      settled = true
      release()
      if (upstream) upstream.destroy()
      reject(Object.assign(new Error('客户端已断开'), { code: 'client_aborted', status: 499 }))
    }
    res.on('close', abortByClient)

    upstream = transport.request(
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
        // Key 失效（401/403）只在同一个上游还有别的 Key 时才值得重试
        const keyRetryable = (status === 401 || status === 403) && context.sameKeyGroupNext

        // 可重试且还没向客户端写过任何东西 → 丢弃这个响应，换下一个上游
        if ((retryable || keyRetryable) && !res.headersSent && context.canRetry) {
          upstreamRes.resume()
          settled = true
          res.off('close', abortByClient)
          release()
          reject(Object.assign(new Error(`HTTP ${status}`), { status, retryable: true }))
          return
        }

        const responseHeadersForClient = {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
          'x-relay-provider': encodeURIComponent(provider.name || provider.id || ''),
        }
        if (upstreamRes.headers['retry-after']) {
          responseHeadersForClient['Retry-After'] = upstreamRes.headers['retry-after']
        }
        res.writeHead(status, responseHeadersForClient)

        // 透传的同时留一份响应体，用来解析 usage 与写缓存（最多 2MB；超出则不缓存，避免缓存残缺响应）
        const contentType = String(upstreamRes.headers['content-type'] || '')
        const chunks = []
        let captured = 0
        let truncated = false
        upstreamRes.on('data', (chunk) => {
          if (truncated) return
          if (captured + chunk.length > MAX_CAPTURE_BYTES) {
            truncated = true
            return
          }
          captured += chunk.length
          chunks.push(chunk)
        })

        upstreamRes.pipe(res)
        upstreamRes.on('end', () => {
          if (settled) return
          settled = true
          res.off('close', abortByClient)
          release()
          const elapsed = Date.now() - startedAt
          const usage = extractUsage(chunks, contentType)
          pushLog({
            at: new Date().toISOString(),
            model: context.model,
            provider: provider.name || provider.id,
            client: context.client || '',
            status,
            ms: elapsed,
            stream: contentType.includes('event-stream'),
            attempt: context.attempt,
            error: status >= 400 ? `HTTP ${status}` : null,
            requestId: context.requestId,
            keyTail: keyTailOf(provider.apiKey),
            failover: context.attempt > 1,
            usage,
          })
          recordStat({
            provider,
            model: context.model,
            status,
            ms: elapsed,
            usage,
          })
          recordQuota(provider, { status, usage })
          // 鉴权失败 / 限流 / 5xx 也进入冷却（单上游时是透传，不会走 catch）
          const shouldCool = status === 401 || status === 403 || status === 429 || status >= 500
          if (shouldCool) markFailure(provider, status === 429 ? 5000 : 0)
          else if (status < 400) markSuccess(provider)
          // 429 累积判定：多次、有间隔的 429 才认定额度窗口用尽，避免把瞬时限流误判成额度耗尽
          if (status === 429) {
            const lock = noteQuotaHit(provider)
            if (lock) {
              pushLog({
                at: new Date().toISOString(),
                model: context.model,
                provider: provider.name || provider.id,
                client: context.client || '',
                status: 429,
                ms: elapsed,
                stream: contentType.includes('event-stream'),
                attempt: context.attempt,
                error: `429 确认额度耗尽，该 Key 暂停至${lock.level === 'week' ? '周' : '5 小时'}窗口重置`,
                requestId: context.requestId,
                keyTail: keyTailOf(provider.apiKey),
                failover: context.attempt > 1,
                usage: null,
                quota: true,
              })
            }
          }
          // 非流式成功响应按完整请求体缓存，后续相同请求直接命中；超过捕获上限（截断）时不缓存
          if (
            context.cacheKey &&
            status < 400 &&
            !truncated &&
            !contentType.includes('event-stream')
          ) {
            cacheSet(
              context.cacheKey,
              {
                at: Date.now(),
                ttlMs: context.cacheTtlMs,
                status,
                contentType,
                body: Buffer.concat(chunks),
                usage,
              },
              context.cacheMaxEntries,
            )
          }
          resolve({ status, provider })
        })
      },
    )

    upstream.on('timeout', () => {
      upstream.destroy(new Error('上游超时'))
    })

    activeUpstreams.add(upstream)
    upstream.on('close', () => activeUpstreams.delete(upstream))

    upstream.on('error', (error) => {
      if (settled) return
      settled = true
      res.off('close', abortByClient)
      release()
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      reject(error)
    })

    upstream.write(provider.forwardBody || body)
    upstream.end()
  })
}

// 按顺序尝试多个上游；全部失败才向客户端报错
async function forwardWithFailover(providers, path, body, res, context) {
  let lastError = null
  let allRateLimited = true
  // 因额度耗尽被跳过的 Key（每把 Key 是独立账号，只跳过它自己）
  const quotaSkipped = []

  // 跳过冷却中的上游 / Key；全部冷却时直接告知稍后再试
  const now = Date.now()
  const candidates = applySticky(
    providers.filter((provider) => coolingUntil(provider) <= now),
    context.stickyKey,
    providers,
  )
  if (candidates.length === 0) {
    const waits = providers
      .map((provider) => Math.ceil((coolingUntil(provider) - now) / 1000))
      .filter((seconds) => seconds > 0)
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(waits.length > 0 ? Math.min(...waits) : 1),
      'Access-Control-Allow-Origin': '*',
    })
    res.end(
      JSON.stringify({
        error: {
          message: '所有上游都在冷却中，请稍后重试',
          type: 'upstream_cooling',
          code: 503,
        },
      }),
    )
    return
  }

  for (let index = 0; index < candidates.length; index++) {
    const provider = candidates[index]
    const nextProvider = candidates[index + 1]
    const attemptContext = {
      ...context,
      attempt: index + 1,
      canRetry: index < candidates.length - 1,
      sameKeyGroupNext: sameProvider(provider, nextProvider),
    }

    const attemptStarted = Date.now()
    try {
      await attempt(provider, path, body, res, attemptContext)
      return
    } catch (error) {
      lastError = error
      if (error.code !== 'rate_limited') allRateLimited = false
      // 客户端主动断开：只记日志，不记失败统计、不冷却上游，也不再尝试其它上游
      if (error.code === 'client_aborted') {
        pushLog({
          at: new Date().toISOString(),
          model: context.model,
          provider: provider.name || provider.id,
          client: context.client || '',
          status: 499,
          ms: Date.now() - attemptStarted,
          stream: false,
          attempt: index + 1,
          error: '客户端已断开',
          requestId: context.requestId,
          keyTail: keyTailOf(provider.apiKey),
          failover: index > 0,
          usage: null,
          aborted: true,
        })
        return
      }
      // 额度用尽：只跳过这一把 Key，继续尝试同提供商的其它 Key 和下一个提供商
      if (error.code === 'quota_exceeded') {
        quotaSkipped.push(keyTailOf(provider.apiKey))
        if (res.headersSent) return
        continue
      }
      // 429 累积判定：多次、有间隔的 429 才认定额度窗口用尽
      const quotaLock = error.status === 429 ? noteQuotaHit(provider) : null
      pushLog({
        at: new Date().toISOString(),
        model: context.model,
        provider: provider.name || provider.id,
        client: context.client || '',
        status: error.status || 0,
        ms: Date.now() - attemptStarted,
        stream: false,
        attempt: index + 1,
        error: quotaLock
          ? `429 确认额度耗尽，该 Key 暂停至${quotaLock.level === 'week' ? '周' : '5 小时'}窗口重置`
          : error.message,
        requestId: context.requestId,
        keyTail: keyTailOf(provider.apiKey),
        failover: index > 0,
        usage: null,
        quota: Boolean(quotaLock),
      })
      recordStat({
        provider,
        model: context.model,
        status: error.status || 0,
        ms: Date.now() - attemptStarted,
        error,
      })
      // 网络错误 / 鉴权失败 / 限流 / 5xx 进入冷却，避免持续打坏上游
      if (
        !error.status ||
        error.status === 401 ||
        error.status === 403 ||
        error.status === 429 ||
        error.status >= 500
      ) {
        markFailure(provider, error.code === 'rate_limited' ? (error.retryAfter || 1) * 1000 : 0)
      }
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

  // 所有 Key 的额度窗口都用尽：写一条汇总日志并返回 429（带被跳过的 Key 尾号）
  if (lastError?.code === 'quota_exceeded') {
    const skipped = quotaSkipped.length
    pushLog({
      at: new Date().toISOString(),
      model: context.model,
      provider: lastError.providerName || '额度',
      client: context.client || '',
      status: 429,
      ms: 0,
      stream: false,
      attempt: skipped,
      error: `额度用尽：${skipped} 个 Key${skipped ? `（…${quotaSkipped.join('、…')}）` : ''}`,
      requestId: context.requestId,
      keyTail: '',
      failover: skipped > 1,
      usage: null,
      quota: true,
    })
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(lastError.retryAfter || 60),
      'Access-Control-Allow-Origin': '*',
    })
    res.end(
      JSON.stringify({
        error: {
          message: `所有上游额度已用尽：${lastError.message}`,
          type: 'quota_exhausted',
          code: 429,
          skippedKeys: quotaSkipped,
        },
      }),
    )
    return
  }

  openaiError(res, 502, `所有上游均失败：${lastError?.message || '未知错误'}`, 'upstream_error')
}

// 聊天 / embeddings 共用：解析请求、路由（含模型别名）、精确缓存、故障转移
async function handleJsonProxy(req, res, upstreamPath, cacheable, client = '') {
  const requestId = newRequestId()
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    openaiError(res, 400, `请求体读取失败：${error.message}`)
    return
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    openaiError(res, 400, `请求体解析失败：${error.message}`)
    return
  }

  const model = payload?.model
  if (!model) {
    openaiError(res, 400, '缺少 model 字段')
    return
  }

  // 开启粘性后，同一会话优先落在同一个上游 Key；没有显式会话标识时用消息前缀兜底
  const stickyKey = stickyKeyOf(req, payload)
  const streaming = payload?.stream === true

  // 命中模型别名时，转发体里的 model 换成上游真实模型名
  const providers = expandKeyCandidates(resolveProvidersFrom(config.providers, model)).map(
    (item) => {
      const mapped = item.modelAliases?.[model]
      if (!mapped || mapped === model) return item
      return {
        ...item,
        forwardModel: mapped,
        forwardBody: JSON.stringify({ ...payload, model: mapped }),
      }
    },
  )
  if (providers.length === 0) {
    openaiError(
      res,
      404,
      `没有提供商提供模型「${model}」。请在中转站里为该模型配置提供商，或只启用一个上游。`,
      'model_not_found',
    )
    return
  }

  // 精确缓存：只缓存非流式，键为 model + 原始请求体
  const useCache = cacheable && config.cache?.enabled === true && payload.stream !== true
  const cacheKey = useCache ? cacheKeyOf(model, raw) : ''
  if (cacheKey) {
    const hit = cacheGet(cacheKey)
    if (hit) {
      pushLog({
        at: new Date().toISOString(),
        model,
        provider: '缓存',
        client,
        status: hit.status,
        ms: 0,
        stream: false,
        attempt: 0,
        error: null,
        requestId,
        keyTail: '',
        failover: false,
        usage: hit.usage,
        cached: true,
      })
      recordStat({
        provider: { id: 'cache', name: '缓存' },
        model,
        status: hit.status,
        ms: 0,
        usage: hit.usage,
      })
      sendCachedResponse(res, hit)
      return
    }
  }

  await forwardWithFailover(providers, upstreamPath, raw, res, {
    model,
    requestId,
    client,
    stickyKey,
    streaming,
    cacheKey,
    cacheTtlMs: config.cache?.ttlMs || 300000,
    cacheMaxEntries: config.cache?.maxEntries || 200,
  })
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

  // 设置了访问 Key（默认 Key 或多客户端 Key）后，客户端必须带 Authorization: Bearer <key>
  // /health 与 OPTIONS 除外；识别结果用于日志与会话归因
  const client = identifyClient(req)
  if (!client.ok) {
    openaiError(res, 401, '本地中转站需要正确的 API Key', 'invalid_api_key')
    return
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    json(res, 200, { object: 'list', data: listModels() })
    return
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    await handleJsonProxy(req, res, '/chat/completions', true, client.label)
    return
  }

  if (req.method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings')) {
    await handleJsonProxy(req, res, '/embeddings', false, client.label)
    return
  }

  openaiError(res, 404, `未知路径：${path}`)
}

function normalizeCache(input) {
  return {
    enabled: input?.enabled === true,
    ttlMs: Math.max(1000, Number(input?.ttlMs) || 300000),
    maxEntries: Math.max(10, Number(input?.maxEntries) || 200),
  }
}

function start(nextConfig = {}) {
  // 允许显式传 0：让系统分配端口（冒烟/端口冲突时用）
  const requestedPort = nextConfig.port === 0 ? 0 : Number(nextConfig.port) || DEFAULT_PORT
  config = {
    port: requestedPort,
    providers: (Array.isArray(nextConfig.providers) ? nextConfig.providers : []).map(
      (provider) => ({
        ...provider,
        quota: normalizeQuota(provider?.quota),
      }),
    ),
    apiKey: typeof nextConfig.apiKey === 'string' ? nextConfig.apiKey.trim() : '',
    clientKeys: normalizeClientKeys(nextConfig.clientKeys),
    sticky: nextConfig.sticky === true,
    cache: normalizeCache(nextConfig.cache),
  }
  keyCursor.clear()
  clearCooldowns()

  const boot = (async () => {
    if (server || stopPromise) await stop()
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
  })()
  return boot
}

function stop() {
  if (stopPromise) return stopPromise
  if (!server) return Promise.resolve()

  const instance = server
  server = null
  for (const upstream of activeUpstreams) {
    try {
      upstream.destroy()
    } catch {
      // 已关闭
    }
  }
  activeUpstreams.clear()

  stopPromise = new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      stopPromise = null
      resolve()
    }
    try {
      instance.close(done)
    } catch {
      done()
    }
    try {
      // Node 18+：立即断开 keep-alive / 在途连接
      instance.closeAllConnections?.()
    } catch {
      // 旧版本没有该 API
    }
    const timer = setTimeout(done, 1000)
    if (timer.unref) timer.unref()
  })

  return stopPromise
}

function update(nextConfig = {}) {
  if (Array.isArray(nextConfig.providers)) {
    config.providers = nextConfig.providers.map((provider) => ({
      ...provider,
      quota: normalizeQuota(provider?.quota),
    }))
  }
  if (typeof nextConfig.apiKey === 'string') config.apiKey = nextConfig.apiKey.trim()
  if (Array.isArray(nextConfig.clientKeys)) {
    config.clientKeys = normalizeClientKeys(nextConfig.clientKeys)
  }
  if (typeof nextConfig.sticky === 'boolean') config.sticky = nextConfig.sticky
  if (nextConfig.cache && typeof nextConfig.cache === 'object') {
    config.cache = normalizeCache(nextConfig.cache)
    if (!config.cache.enabled) cacheEntries.clear()
  }
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
    hasApiKey: Boolean(config.apiKey),
    clientKeys: config.clientKeys.length,
    sticky: config.sticky,
    cache: { enabled: config.cache?.enabled === true, entries: cacheEntries.size },
    cooling: snapshotCooling(),
    quota: snapshotQuota(),
  }
}

// 拉取某个上游的模型列表（用于「拉取模型」按钮）
function fetchModelsWithKey({ baseUrl, apiKey }, timeout = 10000) {
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

// 多 Key 时依次尝试，任意一个成功就返回（也兼容只传 apiKey）
async function fetchModels(params = {}, timeout = 10000) {
  const keys = apiKeysOf(params)
  const attempts = keys.length > 0 ? keys : ['']
  let lastError = null
  for (const key of attempts) {
    try {
      return await fetchModelsWithKey({ baseUrl: params.baseUrl, apiKey: key }, timeout)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('拉取模型失败')
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
  apiKeysOf,
  expandKeyCandidates,
  getLogs,
  clearLogs,
  getStats,
  clearStats,
  extractUsage,
  attachStorage,
  persistNow,
  clearCooldowns,
  clearCache,
  snapshotCooling,
  cacheKeyOf,
  snapshotLoad,
  limitsOf,
  clearRuntime,
  normalizeClientKeys,
  stickyKeyOf,
  applySticky,
  acquireSlot,
  normalizeQuota,
  quotaBlocked,
  recordQuota,
  snapshotQuota,
  resetQuota,
  noteQuotaHit,
  quotaLocked,
  strikeConfigOf,
}
