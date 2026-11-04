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
    // enc: 开头是加密存储的镜像值，不是可调用的 Key；混进候选只会白白 401 一次
    .filter((key) => Boolean(key) && !/^enc:/i.test(key))
  return [...new Set(keys)]
}

// 每个请求从下一个 Key 开始，多个 Key 自然分担；一个 Key 失败再切同上游的其它 Key
const keyCursor = new Map()

function rotateKeys(provider, keys) {
  const cursorKey = provider.id || provider.baseUrl
  const start = keyCursor.get(cursorKey) || 0
  keyCursor.set(cursorKey, (start + 1) % keys.length)
  return [...keys.slice(start), ...keys.slice(0, start)]
}

// 平滑加权轮询状态：按「提供商 + 模型」维护每个 Key 的累计权重
const quotaSwrr = new Map()

// 开启额度窗口后按剩余额度水位分配流量；等权或未开启额度时退化为普通轮询。
// SWRR（Nginx 同款）能保证长期比例精确，又不会连续把请求压在同一把 Key 上。
function weightedKeysOf(provider, model, keys) {
  const weights = keys.map((key) => ({
    key,
    weight: quotaWeightOf({ ...provider, apiKey: key }, model),
  }))
  const total = weights.reduce((sum, item) => sum + item.weight, 0)
  // 全部 Key 都耗尽 / 锁定：交给上层返回 429，不再按权重挑选
  if (total <= 0) return rotateKeys(provider, keys)

  const stateKey = `${providerKeyOf(provider)}::${model || ''}`
  const current = quotaSwrr.get(stateKey) || new Map()
  for (const item of weights) item.current = (current.get(item.key) || 0) + item.weight
  weights.sort((a, b) => b.current - a.current || keys.indexOf(a.key) - keys.indexOf(b.key))
  const picked = weights[0]
  current.set(picked.key, picked.current - total)
  quotaSwrr.set(stateKey, current)
  return weights.map((item) => item.key)
}

function orderedKeysOf(provider, model) {
  const keys = apiKeysOf(provider)
  if (keys.length <= 1) return keys
  if (provider?.quota?.enabled !== true) return rotateKeys(provider, keys)
  return weightedKeysOf(provider, model, keys)
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

// 把「提供商 × 它的每个 Key」展开成候选链，交给故障转移逐个尝试。
// 开启额度窗口时按剩余水位排序，否则保持普通轮询。
function expandKeyCandidates(providers = [], model) {
  const candidates = []
  for (const provider of providers) {
    const keys = orderedKeysOf(provider, model)
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

// ---------- 端砚专项策略（仅对 presetId / strategy = duanyan 生效） ----------
// 实测结论：限频是「每 Key × 每模型 50 RPM」的 60 秒滚动窗口，429 不带 Retry-After；
// 网关约 8 秒攒批一次；余额不足返回 429 quota_exceeded，与分钟限流是两回事。
// 其它提供商不命中该策略，仍走「提供商级并发 + RPM」，行为保持不变。
const DUANYAN_STRATEGY = 'duanyan'
const DUANYAN_RATE_RETRY_MS = 60000
const DUANYAN_COOLDOWN_BASE_MS = 8000

function strategyOf(provider) {
  const raw = provider?.strategy || provider?.presetId || ''
  return String(raw).toLowerCase() === DUANYAN_STRATEGY ? DUANYAN_STRATEGY : ''
}

function isDuanyan(provider) {
  return strategyOf(provider) === DUANYAN_STRATEGY
}

const runtimeByProvider = new Map()

// 端砚按「提供商 + Key」隔离并发（RPM 再按模型分桶），与上游实测一致：
// 多 Key 各自 50 RPM，互不挤占；默认策略仍以提供商为键。
function runtimeKeyOf(provider) {
  const base = provider.id || provider.name || provider.baseUrl
  if (!isDuanyan(provider)) return base
  return `${base}::${provider.apiKey || ''}`
}

function getRuntime(provider) {
  const key = runtimeKeyOf(provider)
  if (!runtimeByProvider.has(key)) {
    runtimeByProvider.set(key, {
      inflight: 0,
      streaming: 0,
      hits: [],
      hitsByModel: new Map(),
      waiters: [],
    })
  }
  return runtimeByProvider.get(key)
}

// 端砚的 RPM 计数按模型分桶；默认策略沿用单一窗口
function hitsOf(runtime, provider, model) {
  if (!isDuanyan(provider)) return runtime.hits
  const name = model || ''
  if (!runtime.hitsByModel.has(name)) runtime.hitsByModel.set(name, [])
  return runtime.hitsByModel.get(name)
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

function acquireSlot(provider, streaming = false, model = '') {
  const runtime = getRuntime(provider)
  const { maxConcurrency, rpmLimit, queueTimeoutMs, maxStreams } = limitsOf(provider)
  const now = Date.now()

  // 滑动窗口：只保留最近 60 秒。端砚按「模型」分桶，其它提供商仍按提供商汇总
  if (isDuanyan(provider)) {
    const list = hitsOf(runtime, provider, model)
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (now - list[index] >= RPM_WINDOW_MS) list.splice(index, 1)
    }
  } else {
    runtime.hits = runtime.hits.filter((at) => now - at < RPM_WINDOW_MS)
  }
  const windowHits = hitsOf(runtime, provider, model)

  if (rpmLimit > 0 && windowHits.length >= rpmLimit) {
    const oldest = windowHits[0] || now
    const retryAfter = Math.max(1, Math.ceil((RPM_WINDOW_MS - (now - oldest)) / 1000))
    return Promise.reject(rateLimitError(`每分钟请求数已达上限（${rpmLimit}）`, retryAfter))
  }

  const canStart =
    runtime.inflight < maxConcurrency && (!streaming || runtime.streaming < maxStreams)
  if (canStart) {
    runtime.inflight += 1
    if (streaming) runtime.streaming += 1
    windowHits.push(now)
    return Promise.resolve(makeRelease(runtime, streaming))
  }

  // 并发已满（或流式槽位已满）→ 排队等槽位
  return new Promise((resolve, reject) => {
    const waiter = {
      streaming,
      maxConcurrency,
      maxStreams,
      // 与发出请求时相同的计数桶：端砚按模型分桶，避免排队放行时记错模型
      hits: hitsOf(runtime, provider, model),
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
      waiter.hits.push(Date.now())
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

// ---------- 请求日志（内存，按时间保留最近 3 天） ----------
const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
// 安全阀：极端高频调用时避免日志无限增长；正常使用 3 天远达不到
const MAX_LOGS = 20000
const logs = []

// logs 按时间从新到旧排列，过期记录集中在尾部，逐条弹出即可
function pruneLogs(now = Date.now()) {
  const cutoff = now - LOG_RETENTION_MS
  while (logs.length > 0) {
    const at = new Date(logs[logs.length - 1]?.at).getTime()
    if (!Number.isNaN(at) && at >= cutoff) break
    logs.pop()
  }
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS
}

function newRequestId() {
  return `req_${crypto.randomUUID()}`
}

function keyTailOf(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey : ''
  return key ? key.slice(-6) : ''
}

function pushLog(entry) {
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...entry }
  logs.unshift(item)
  pruneLogs()
  // 日志是每次上游尝试的唯一入口：按 Key 持久化统计也在这里累计，
  // 这样取消、额度耗尽等异常尝试不会漏记。
  recordKeyUsage(item)
  schedulePersist()
}

function getLogs() {
  // 长时间没有新请求时也要裁掉超过 3 天的记录
  pruneLogs()
  return logs.slice()
}

function clearLogs() {
  logs.length = 0
  return persistNow()
}

// ---------- 调用监控（按 提供商 + 模型 聚合，内存） ----------
const MAX_STATS = 200
const statsByKey = new Map()

// ---------- 按上游 Key 的持久化统计（与提供商 + Key 尾号绑定） ----------
const MAX_KEY_USAGE = 500
// 按小时桶保留最近 32 天，用于时 / 5 小时 / 日 / 7 日 / 月调用细分
const KEY_HOUR_RETENTION_MS = 32 * 24 * 60 * 60 * 1000
const keyUsage = new Map()

function pruneKeyHourly(row, now = Date.now()) {
  const cutoff = localHourKey(new Date(now - KEY_HOUR_RETENTION_MS))
  for (const key of Object.keys(row.hourly || {})) {
    if (key < cutoff) delete row.hourly[key]
  }
}

// 滚动窗口口径：本小时 / 最近 5 小时 / 今日 / 最近 7 天 / 本月
// 持久化时需要保留分时桶，getKeyUsage 对外只返回窗口汇总
function serializeKeyUsage() {
  return [...keyUsage.values()].map((item) => ({
    ...item,
    hourly: { ...(item.hourly || {}) },
  }))
}

function emptyKeyWindowStat() {
  return { calls: 0, success: 0, prompt: 0, completion: 0, total: 0, lastAt: null }
}

function normalizeKeyHourBucket(value) {
  if (typeof value === 'number') {
    return { ...emptyKeyWindowStat(), calls: Number(value) || 0 }
  }
  if (!value || typeof value !== 'object') return emptyKeyWindowStat()
  return {
    calls: Number(value.calls) || 0,
    success: Number(value.success) || 0,
    prompt: Number(value.prompt) || 0,
    completion: Number(value.completion) || 0,
    total: Number(value.total) || 0,
    lastAt: value.lastAt || null,
  }
}

function keyWindowStats(row, now = new Date()) {
  const buckets = row?.hourly || {}
  const aggregateSince = (startKey) => {
    const result = emptyKeyWindowStat()
    for (const [hour, value] of Object.entries(buckets)) {
      if (hour < startKey) continue
      const bucket = normalizeKeyHourBucket(value)
      result.calls += bucket.calls
      result.success += bucket.success
      result.prompt += bucket.prompt
      result.completion += bucket.completion
      result.total += bucket.total
      if (bucket.lastAt && (!result.lastAt || bucket.lastAt > result.lastAt)) {
        result.lastAt = bucket.lastAt
      }
    }
    return result
  }

  const today = localDateKey(now)
  const fiveHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000)
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

  return {
    hour: aggregateSince(localHourKey(now)),
    hours5: aggregateSince(localHourKey(fiveHoursAgo)),
    day: aggregateSince(`${today}T00`),
    days7: aggregateSince(`${localDateKey(weekAgo)}T00`),
    month: aggregateSince(`${monthStart}T00`),
  }
}

function recordKeyUsage(entry) {
  const tail = typeof entry?.keyTail === 'string' ? entry.keyTail : ''
  // 缓存命中 / 额度汇总等没有归属 Key 的日志不计入；quota 附加日志避免与尝试日志双计
  if (!tail || entry?.quota) return
  const provider = entry.provider || '未知'
  const id = `${provider}::${tail}`
  const at = entry.at || new Date().toISOString()
  let row = keyUsage.get(id)
  if (!row) {
    row = {
      id,
      provider,
      keyTail: tail,
      calls: 0,
      success: 0,
      prompt: 0,
      completion: 0,
      total: 0,
      lastAt: at,
      hourly: {},
    }
    keyUsage.set(id, row)
  }
  row.calls += 1
  if (!entry.error && entry.status >= 200 && entry.status < 400) row.success += 1
  if (entry.usage) {
    const prompt = Number(entry.usage.prompt) || 0
    const completion = Number(entry.usage.completion) || 0
    const total = Number(entry.usage.total) || prompt + completion
    row.prompt += prompt
    row.completion += completion
    row.total += total
  }
  row.lastAt = at

  const parsedAt = new Date(at)
  const hour = localHourKey(Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt)
  row.hourly ||= {}
  const hourBucket = normalizeKeyHourBucket(row.hourly[hour])
  hourBucket.calls += 1
  if (!entry.error && entry.status >= 200 && entry.status < 400) hourBucket.success += 1
  if (entry.usage) {
    const prompt = Number(entry.usage.prompt) || 0
    const completion = Number(entry.usage.completion) || 0
    const total = Number(entry.usage.total) || prompt + completion
    hourBucket.prompt += prompt
    hourBucket.completion += completion
    hourBucket.total += total
  }
  hourBucket.lastAt = at
  row.hourly[hour] = hourBucket
  pruneKeyHourly(row)

  if (keyUsage.size > MAX_KEY_USAGE) {
    const oldest = [...keyUsage.entries()].sort((a, b) =>
      String(a[1].lastAt || '').localeCompare(String(b[1].lastAt || '')),
    )[0]
    if (oldest) keyUsage.delete(oldest[0])
  }
}

function getKeyUsage() {
  const now = new Date()
  return [...keyUsage.values()]
    .map((item) => {
      const rest = { ...item }
      delete rest.hourly
      return { ...rest, windows: keyWindowStats(item, now) }
    })
    .sort((a, b) => b.total - a.total || b.calls - a.calls)
}

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

function recordStat({ provider, model, status, ms, error, usage, cached = false }) {
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
  if (usage) {
    if (cached) {
      // 命中的是缓存：没有真实 token 消耗，只累计「缓存节省」
      const prompt = (entry.cachedUsage?.prompt || 0) + (Number(usage.prompt) || 0)
      const completion = (entry.cachedUsage?.completion || 0) + (Number(usage.completion) || 0)
      entry.cachedUsage = { prompt, completion, total: prompt + completion }
      recordDailyUsage(model || entry.model, usage, { cached: true })
    } else {
      entry.usage = usage
      recordDailyUsage(model || entry.model, usage)
    }
  }

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
  dailyTokens.clear()
  hourlyTokens.clear()
  keyUsage.clear()
  return persistNow()
}

// ---------- 按小时 token 统计（持久化，供时统计图表使用） ----------
const MAX_HOURLY_HOURS = 24 * 7
const hourlyTokens = new Map()

// ---------- 按日 token 统计（持久化，供日 / 周 / 月图表使用） ----------
const MAX_DAILY_DAYS = 400
const dailyTokens = new Map()

// 每日用量桶：真实消耗与「缓存节省」共用同一结构，便于图表/统计复用
function createUsageBucket() {
  return { prompt: 0, completion: 0, total: 0, calls: 0, models: new Map() }
}

// 从持久化结构恢复用量桶（旧文件没有 cached 字段时得到空桶）
function restoreUsageBucket(value) {
  const models = new Map()
  if (Array.isArray(value?.models)) {
    for (const modelEntry of value.models) {
      if (!Array.isArray(modelEntry) || typeof modelEntry[0] !== 'string') continue
      const item = modelEntry[1] || {}
      models.set(modelEntry[0], {
        prompt: Number(item.prompt) || 0,
        completion: Number(item.completion) || 0,
        total: Number(item.total) || 0,
        calls: Number(item.calls) || 0,
      })
    }
  }
  return {
    prompt: Number(value?.prompt) || 0,
    completion: Number(value?.completion) || 0,
    total: Number(value?.total) || 0,
    calls: Number(value?.calls) || 0,
    models,
  }
}

// 用本地时间切日：用户看到的“今天”与系统日期一致
function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 用本地时间切小时：YYYY-MM-DDTHH
function localHourKey(date = new Date()) {
  return `${localDateKey(date)}T${String(date.getHours()).padStart(2, '0')}`
}

function pruneHourlyTokens(now = new Date()) {
  if (hourlyTokens.size <= MAX_HOURLY_HOURS) return
  const cutoff = new Date(now.getTime() - (MAX_HOURLY_HOURS - 1) * 3600000)
  const cutoffKey = localHourKey(cutoff)
  for (const key of [...hourlyTokens.keys()]) {
    if (key < cutoffKey) hourlyTokens.delete(key)
  }
}

function addHourlyUsage(date, model, usage, { cached = false } = {}) {
  if (!usage) return
  const prompt = Number(usage.prompt) || 0
  const completion = Number(usage.completion) || 0
  const total = Number(usage.total) || prompt + completion
  if (prompt <= 0 && completion <= 0 && total <= 0) return

  const at = date instanceof Date ? date : new Date()
  const hour = localHourKey(at)
  let entry = hourlyTokens.get(hour)
  if (!entry) {
    entry = { ...createUsageBucket(), cached: createUsageBucket() }
    hourlyTokens.set(hour, entry)
  }
  const bucket = cached ? (entry.cached ||= createUsageBucket()) : entry
  bucket.calls += 1
  bucket.prompt += prompt
  bucket.completion += completion
  bucket.total += total

  const name = model || '未知模型'
  let item = bucket.models.get(name)
  if (!item) {
    item = { prompt: 0, completion: 0, total: 0, calls: 0 }
    bucket.models.set(name, item)
  }
  item.calls += 1
  item.prompt += prompt
  item.completion += completion
  item.total += total

  pruneHourlyTokens(at)
}

function pruneDailyTokens(now = new Date()) {
  if (dailyTokens.size <= MAX_DAILY_DAYS) return
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (MAX_DAILY_DAYS - 1))
  const cutoffKey = localDateKey(cutoff)
  for (const key of [...dailyTokens.keys()]) {
    if (key < cutoffKey) dailyTokens.delete(key)
  }
}

function addDailyUsage(date, model, usage, { cached = false } = {}) {
  if (!usage) return
  const prompt = Number(usage.prompt) || 0
  const completion = Number(usage.completion) || 0
  const total = Number(usage.total) || prompt + completion
  if (prompt <= 0 && completion <= 0 && total <= 0) return

  const day = localDateKey(date)
  let entry = dailyTokens.get(day)
  if (!entry) {
    entry = { ...createUsageBucket(), cached: createUsageBucket() }
    dailyTokens.set(day, entry)
  }
  // 缓存命中不产生真实消耗：单独累计到 cached 桶，避免把省下的 token 算进用量
  const bucket = cached ? (entry.cached ||= createUsageBucket()) : entry
  bucket.calls += 1
  bucket.prompt += prompt
  bucket.completion += completion
  bucket.total += total

  const name = model || '未知模型'
  let item = bucket.models.get(name)
  if (!item) {
    item = { prompt: 0, completion: 0, total: 0, calls: 0 }
    bucket.models.set(name, item)
  }
  item.calls += 1
  item.prompt += prompt
  item.completion += completion
  item.total += total

  pruneDailyTokens()
  // 同一笔用量同步写入小时桶，时统计无需再从日志反推
  addHourlyUsage(date instanceof Date ? date : new Date(), model, usage, { cached })
}

function recordDailyUsage(model, usage, options) {
  addDailyUsage(new Date(), model, usage, options)
}

// 升级到按日统计之前的旧数据文件没有 daily 字段：用已持久化的请求日志回填，
// 让图表一升级就能看到最近的用量（日志上限 200 条，仅回填这一窗口）。
function backfillDailyFromLogs() {
  const ordered = [...logs].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  for (const log of ordered) {
    const at = new Date(log.at)
    if (Number.isNaN(at.getTime())) continue
    // 命中缓存的日志只有 cachedUsage，回填时按「缓存节省」记账，不能算成真实消耗
    addDailyUsage(at, log.model, log.cached ? log.cachedUsage : log.usage, {
      cached: Boolean(log.cached),
    })
  }
  // 回填后尽快把 daily 写盘，避免只存在内存里
  if (dailyTokens.size > 0) schedulePersist()
}

// 升级到按小时统计之前的旧数据文件没有 hourly 字段：用已持久化的请求日志回填
// （日志上限 200 条，仅回填这一窗口）。
function backfillHourlyFromLogs() {
  const ordered = [...logs].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  for (const log of ordered) {
    const at = new Date(log.at)
    if (Number.isNaN(at.getTime())) continue
    addHourlyUsage(at, log.model, log.cached ? log.cachedUsage : log.usage, {
      cached: Boolean(log.cached),
    })
  }
  if (hourlyTokens.size > 0) schedulePersist()
}

// 用量桶 -> 可直接 JSON 序列化的结构
function plainUsageBucket(bucket) {
  return {
    prompt: bucket?.prompt || 0,
    completion: bucket?.completion || 0,
    total: bucket?.total || 0,
    calls: bucket?.calls || 0,
    models: [...(bucket?.models || new Map()).entries()],
  }
}

// 图表数据：按时间段升序，models 按 token 用量降序
function summarizeUsageEntries(entries, keyName) {
  return entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, entry]) => ({
      [keyName]: key,
      prompt: entry.prompt,
      completion: entry.completion,
      total: entry.total,
      calls: entry.calls,
      models: [...(entry.models || new Map())]
        .map(([model, item]) => ({ model, ...item }))
        .sort((a, b) => b.total - a.total),
      // 缓存命中省下的 tokens（不参与真实用量，单独展示）
      cached: summarizeBucket(entry.cached),
    }))
}

function summarizeBucket(bucket) {
  return {
    prompt: bucket?.prompt || 0,
    completion: bucket?.completion || 0,
    total: bucket?.total || 0,
    calls: bucket?.calls || 0,
    models: [...(bucket?.models || new Map())]
      .map(([model, item]) => ({ model, ...item }))
      .sort((a, b) => b.total - a.total),
  }
}

// 图表数据：按日期升序，models 按 token 用量降序
function getTokenHistory() {
  return summarizeUsageEntries([...dailyTokens.entries()], 'date')
}

// 时统计图表：最近 7 天按小时升序
function getTokenHourly() {
  return summarizeUsageEntries([...hourlyTokens.entries()], 'hour')
}

// 图表与按 Key 统计一次取回，减少渲染进程的 IPC 往返
function getTokenUsage() {
  return {
    history: getTokenHistory(),
    hourly: getTokenHourly(),
    keys: getKeyUsage(),
  }
}

// ---------- 持久化（日志与统计） ----------
const MAX_PERSIST_LOGS = MAX_LOGS
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
      const cutoff = Date.now() - LOG_RETENTION_MS
      const kept = raw.logs
        .filter((item) => {
          const at = new Date(item?.at).getTime()
          return !Number.isNaN(at) && at >= cutoff
        })
        .slice(0, MAX_PERSIST_LOGS)
      logs.splice(0, logs.length, ...kept)
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
        if (!lock || !Number.isFinite(lock.until)) continue
        // 锁在写盘后可能刚好过期：保留「刚过期」的锁用于半开探测，
        // 过期太久（超过预热窗口）则视为上游窗口已恢复，直接丢弃。
        if (lock.until <= now - DEFAULT_QUOTA_WARMUP_MINUTES * 60 * 1000) continue
        quotaLocks.set(entry[0], {
          until: lock.until,
          level: lock.level === 'week' ? 'week' : '5h',
          at: Number(lock.at) || now,
        })
        // 同时恢复等级记忆：锁过期后再撞墙才能直接升级为周锁
        quotaStrikes.set(entry[0], {
          hits: [],
          burst: [],
          lastAt: 0,
          level: lock.level === 'week' ? 'week' : '5h',
        })
      }
    }
    // 等级记忆单独保存：即使锁已经过期，也记得上次是 5h 还是 week
    if (Array.isArray(raw.levels)) {
      quotaLevels.clear()
      const cutoff = Date.now() - QUOTA_WINDOW_WEEK_MS
      for (const entry of raw.levels) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const item = entry[1]
        if (!item || typeof item.level !== 'string') continue
        const at = Number(item.at) || 0
        if (at && at < cutoff) continue
        quotaLevels.set(entry[0], { level: item.level === 'week' ? 'week' : '5h', at })
      }
    }
    // 按日 token 统计恢复：图表数据跨重启保留
    if (Array.isArray(raw.daily)) {
      dailyTokens.clear()
      for (const entry of raw.daily.slice(-MAX_DAILY_DAYS)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const value = entry[1]
        if (!value || typeof value !== 'object') continue
        dailyTokens.set(entry[0], {
          ...restoreUsageBucket(value),
          cached: restoreUsageBucket(value.cached),
        })
      }
    } else {
      // 旧数据文件（升级前）没有 daily 字段：用日志回填一次，后续写盘会带上 daily
      backfillDailyFromLogs()
    }
    // 按小时 token 统计恢复（时统计图表）
    if (Array.isArray(raw.hourly)) {
      hourlyTokens.clear()
      for (const entry of raw.hourly.slice(-MAX_HOURLY_HOURS)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const value = entry[1]
        if (!value || typeof value !== 'object') continue
        hourlyTokens.set(entry[0], {
          ...restoreUsageBucket(value),
          cached: restoreUsageBucket(value.cached),
        })
      }
    } else if (hourlyTokens.size === 0) {
      // 旧数据文件没有 hourly 字段：用日志回填一次；如果 daily 回填时已同步写过则跳过
      backfillHourlyFromLogs()
    }
    // 按上游 Key 的调用统计恢复
    if (Array.isArray(raw.keys)) {
      keyUsage.clear()
      for (const item of raw.keys.slice(-MAX_KEY_USAGE)) {
        if (!item || typeof item.keyTail !== 'string' || !item.keyTail) continue
        const provider = item.provider || '未知'
        const id = item.id || `${provider}::${item.keyTail}`
        const hourly = {}
        if (item.hourly && typeof item.hourly === 'object') {
          for (const [hour, value] of Object.entries(item.hourly)) {
            if (typeof hour !== 'string') continue
            const bucket = normalizeKeyHourBucket(value)
            if (bucket.calls > 0) hourly[hour] = bucket
          }
        }
        const row = {
          id,
          provider,
          keyTail: item.keyTail,
          calls: Number(item.calls) || 0,
          success: Number(item.success) || 0,
          prompt: Number(item.prompt) || 0,
          completion: Number(item.completion) || 0,
          total: Number(item.total) || 0,
          lastAt: item.lastAt || null,
          hourly,
        }
        pruneKeyHourly(row)
        keyUsage.set(id, row)
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
  const levels = [...quotaLevels.entries()].filter(([, item]) => item && item.level)
  // 落盘前再裁一次，确保文件里不会保存超过 3 天的日志
  pruneLogs()
  let payload
  try {
    payload = JSON.stringify({
      logs: logs.slice(0, MAX_PERSIST_LOGS),
      stats: getStats(),
      daily: [...dailyTokens.entries()].map(([date, entry]) => [
        date,
        {
          ...plainUsageBucket(entry),
          cached: entry.cached ? plainUsageBucket(entry.cached) : undefined,
        },
      ]),
      hourly: [...hourlyTokens.entries()].map(([hour, entry]) => [
        hour,
        {
          ...plainUsageBucket(entry),
          cached: entry.cached ? plainUsageBucket(entry.cached) : undefined,
        },
      ]),
      keys: serializeKeyUsage(),
      quota,
      locks,
      levels,
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

// 端砚墨点是「自然月」额度（每月 10 墨点、月底清零），与滚动 5h/7d 不同。
// 只有 windowMode = calendar-month 且命中端砚策略时才启用，其它提供商不受影响。
function startOfMonth(ts = Date.now()) {
  const date = new Date(ts)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

function nextMonthStart(ts = Date.now()) {
  const date = new Date(ts)
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime()
}

function monthlyQuotaOf(provider) {
  return isDuanyan(provider) && provider?.quota?.windowMode === 'calendar-month'
}
// 429 确认额度耗尽后的最短锁定时长：避免估算恢复时间过短导致反复撞墙
const QUOTA_MIN_LOCK_MS = 5 * 60 * 1000
// 锁定解除后的半开恢复时长：先小流量探测，成功后再逐步放量
const DEFAULT_QUOTA_WARMUP_MINUTES = 5

const quotaByProvider = new Map()
// 429 判定状态：hits 是「有间隔的确认点」，burst 是高频突发时间戳
const quotaStrikes = new Map()
const quotaLocks = new Map()
// 锁定解除后的半开恢复状态
const quotaWarmup = new Map()
// 上一次锁定等级（5h / week）：持久化后重启仍能继续升级，而不是重新从 5h 试错
const quotaLevels = new Map()

// 与 src/utils/relayConfig.js 的 normalizeQuota 保持同口径
function normalizeQuota(input) {
  const metric = input?.metric === 'credit' ? 'credit' : 'request'
  const limit5h = Math.max(0, Number(input?.limit5h) || 0)
  const limitWeek = Math.max(0, Number(input?.limitWeek) || 0)
  // 自然月额度（端砚墨点）：与 5h/7d 互斥，命中时其它窗口不参与判定
  const windowMode = input?.windowMode === 'calendar-month' ? 'calendar-month' : 'rolling'
  const limitMonth =
    windowMode === 'calendar-month' ? Math.max(0, Number(input?.limitMonth) || 0) : 0
  const creditsPerMillionTokens = Math.max(0, Number(input?.creditsPerMillionTokens) || 0)
  const confirmStrikes = Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0)))
  const confirmIntervalMinutes = Math.max(0, Number(input?.confirmIntervalMinutes) || 0)
  const confirmSpanMinutes = Math.max(0, Number(input?.confirmSpanMinutes) || 0)
  const burstWindowMinutes = Math.max(0, Number(input?.burstWindowMinutes) || 0)
  const burstStrikes = Math.min(100, Math.max(0, Math.floor(Number(input?.burstStrikes) || 0)))
  const reserveRatio = Math.min(0.9, Math.max(0, Number(input?.reserveRatio) || 0))
  const warmupMinutes = Math.max(0, Number(input?.warmupMinutes) || 0)

  // 按模型独立额度：商汤按模型每 5 小时限次，单一池会低估低额度模型的上游上限
  const modelLimits = {}
  if (input?.modelLimits && typeof input.modelLimits === 'object') {
    for (const [model, value] of Object.entries(input.modelLimits)) {
      const name = typeof model === 'string' ? model.trim() : ''
      if (!name) continue
      const five = Math.max(0, Number(value?.limit5h) || 0)
      const week = Math.max(0, Number(value?.limitWeek) || 0)
      if (five > 0 || week > 0) modelLimits[name] = { limit5h: five, limitWeek: week }
    }
  }

  // 积分制下不同模型可以有不同的 tokens→积分换算率；未列出的模型用全局值
  const modelRates = {}
  if (input?.modelRates && typeof input.modelRates === 'object') {
    for (const [model, value] of Object.entries(input.modelRates)) {
      const name = typeof model === 'string' ? model.trim() : ''
      const rate = Math.max(0, Number(value) || 0)
      if (name && rate > 0) modelRates[name] = rate
    }
  }

  const perModel = input?.perModel === true

  // 共享组名列表：允许先建组、再往组里添加 Key（空组也要能保存）
  const groups = []
  if (Array.isArray(input?.groups)) {
    for (const item of input.groups) {
      const name = typeof item === 'string' ? item.trim() : ''
      if (name && !groups.includes(name)) groups.push(name)
    }
  }

  // Key 级共享组：明文 Key -> 组名，优先于提供商级默认组。
  // 同一提供商里可能混有不同账号的 Key，按 Key 分组才能准确合并额度池。
  const keyGroups = {}
  if (input?.keyGroups && typeof input.keyGroups === 'object') {
    for (const [key, value] of Object.entries(input.keyGroups)) {
      const name = typeof key === 'string' ? key.trim() : ''
      const group = typeof value === 'string' ? value.trim() : ''
      if (name && group) keyGroups[name] = group
    }
  }
  return {
    enabled:
      input?.enabled === true &&
      (limit5h > 0 || limitWeek > 0 || limitMonth > 0 || Object.keys(modelLimits).length > 0),
    metric,
    windowMode,
    limitMonth,
    limit5h,
    limitWeek,
    creditsPerMillionTokens,
    confirmStrikes,
    confirmIntervalMinutes,
    confirmSpanMinutes,
    burstWindowMinutes,
    burstStrikes,
    reserveRatio,
    warmupMinutes,
    perModel,
    // 共享额度组：同组的多把 Key（通常属于同一商汤账号）共用一个额度池
    group: typeof input?.group === 'string' ? input.group.trim() : '',
    groups,
    keyGroups,
    modelLimits,
    modelRates,
  }
}

// 每把 Key 默认是独立账号：额度按「提供商 + Key」单独记账，互不影响。
// 配置了共享额度组时，同组 Key 共用一个池（通常属于同一个商汤账号，额度实际上共享）。
function providerKeyOf(provider) {
  return provider?.id || provider?.name || provider?.baseUrl || 'unknown'
}

function quotaGroupOf(provider) {
  // 优先使用该把 Key 单独配置的组；否则回落到提供商级默认组
  const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : ''
  const perKey = provider?.quota?.keyGroups
  if (apiKey && perKey && typeof perKey === 'object') {
    const group = perKey[apiKey]
    if (typeof group === 'string' && group.trim()) return group.trim()
  }
  return typeof provider?.quota?.group === 'string' ? provider.quota.group.trim() : ''
}

function quotaPoolKeyOf(provider, model) {
  const group = quotaGroupOf(provider)
  // 共享组绑定当前提供商：不同上游的额度体系不同，同名组不能跨提供商合并
  const base = group
    ? `group:${providerKeyOf(provider)}::${group}`
    : `${providerKeyOf(provider)}::${provider?.apiKey || ''}`
  // 按模型独立额度：同一把 Key 的不同模型各记各的池，避免低额度模型被高额度模型挤占
  return provider?.quota?.perModel ? `${base}::${model || ''}` : base
}

function quotaStateOf(provider, model) {
  const key = quotaPoolKeyOf(provider, model)
  if (!quotaByProvider.has(key)) quotaByProvider.set(key, { events: [] })
  return quotaByProvider.get(key)
}

function pruneQuotaEvents(events, now, provider) {
  // 自然月额度：月初即清零，只保留当月事件；其它提供商仍保留 7 天
  const cutoff = monthlyQuotaOf(provider) ? startOfMonth(now) : now - QUOTA_WINDOW_WEEK_MS
  while (events.length > 0 && events[0].at <= cutoff) events.shift()
  return events
}

function quotaLimitOf(provider, model) {
  const quota = provider?.quota || {}
  // 自然月额度：5h/7d 不参与，避免把月度墨点误当成滚动窗口
  if (monthlyQuotaOf(provider)) {
    return { limit5h: 0, limitWeek: 0, limitMonth: Math.max(0, Number(quota.limitMonth) || 0) }
  }
  // 按模型独立额度：未列出的模型回退到提供商级别的默认上限
  const override = quota.perModel && model ? quota.modelLimits?.[model] : null
  return {
    limit5h: Number(override?.limit5h) > 0 ? Number(override.limit5h) : Number(quota.limit5h) || 0,
    limitWeek:
      Number(override?.limitWeek) > 0 ? Number(override.limitWeek) : Number(quota.limitWeek) || 0,
    limitMonth: 0,
  }
}

function quotaUsageOf(provider, model) {
  const now = Date.now()
  const events = pruneQuotaEvents(quotaStateOf(provider, model).events, now, provider)
  let used5h = 0
  let usedWeek = 0
  let usedMonth = 0
  const monthStart = startOfMonth(now)
  for (const item of events) {
    usedWeek += item.units
    if (item.at > now - QUOTA_WINDOW_5H_MS) used5h += item.units
    if (item.at > monthStart) usedMonth += item.units
  }
  return { used5h, usedWeek, usedMonth, events }
}

// 按本地记账估算「恢复到 80% 可用」还需要多久；本地没记到用量时返回整窗口。
// 用于把 429 锁定时长对齐到滚动窗口，而不是一律锁满 5 小时。
function estimateRecoveryMs(provider, model) {
  const limits = quotaLimitOf(provider, model)
  // 自然月额度只能等到下月 1 日清零，无法靠滚动滑出恢复
  if (monthlyQuotaOf(provider)) return Math.max(0, nextMonthStart() - Date.now())
  if (limits.limit5h <= 0) return QUOTA_WINDOW_5H_MS
  const now = Date.now()
  const events = pruneQuotaEvents(quotaStateOf(provider, model).events, now, provider)
  const target = limits.limit5h * 0.8
  let used = 0
  for (const event of events) {
    if (event.at > now - QUOTA_WINDOW_5H_MS) used += event.units
  }
  if (used <= target) return 0
  for (const event of events) {
    const freeAt = event.at + QUOTA_WINDOW_5H_MS
    if (freeAt <= now) continue
    used -= event.units
    if (used <= target) return Math.max(0, freeAt - now)
  }
  return QUOTA_WINDOW_5H_MS
}

// 锁定解除后的半开恢复：探测阶段只放 20% 流量，探测成功后按时间线性恢复
function quotaWarmupRatioOf(provider, model) {
  const key = quotaPoolKeyOf(provider, model)
  const entry = quotaWarmup.get(key)
  if (!entry) return 1
  const now = Date.now()
  if (entry.until <= now) {
    quotaWarmup.delete(key)
    return 1
  }
  if (entry.probing) return 0.2
  const span = Math.max(1, entry.until - entry.startedAt)
  return 0.2 + 0.8 * Math.min(1, Math.max(0, (now - entry.startedAt) / span))
}

function markQuotaWarmupSuccess(provider, model) {
  const key = quotaPoolKeyOf(provider, model)
  const entry = quotaWarmup.get(key)
  if (!entry || !entry.probing) return
  quotaWarmup.set(key, { ...entry, probing: false })
}

// 调度权重：剩余额度比例（扣掉预留）→ 水位分级 → 乘以预热比例。
// 0 表示该 Key 已锁定或额度耗尽，不应再被选中。
function quotaWeightOf(provider, model) {
  const quota = provider?.quota
  if (!quota?.enabled) return 1
  if (currentQuotaLockOf(provider, model)) return 0

  const limits = quotaLimitOf(provider, model)
  const { used5h, usedWeek, usedMonth } = quotaUsageOf(provider, model)
  const ratio5h = limits.limit5h > 0 ? 1 - used5h / limits.limit5h : 1
  const ratioWeek = limits.limitWeek > 0 ? 1 - usedWeek / limits.limitWeek : 1
  const ratioMonth = limits.limitMonth > 0 ? 1 - usedMonth / limits.limitMonth : 1
  let ratio = Math.max(0, Math.min(ratio5h, ratioWeek, ratioMonth))

  // 预留一部分额度给突发与故障转移重试，避免把 Key 打满后整家不可用
  const reserve = Math.min(0.9, Math.max(0, Number(quota.reserveRatio) || 0))
  if (reserve > 0) ratio = Math.max(0, (ratio - reserve) / (1 - reserve))

  // 水位分级：越接近上限越提前降权，避免「一把 Key 突然耗尽」造成连锁 429
  if (ratio <= 0) ratio = 0
  else if (ratio <= 0.05) ratio = 0.02
  else if (ratio <= 0.2) ratio *= 0.2
  else if (ratio <= 0.4) ratio *= 0.5

  return ratio * quotaWarmupRatioOf(provider, model)
}

// 返回 null 表示还有额度；否则给出窗口与最早恢复时间（滑动窗口，按最早一笔用量滑出计算）
function quotaBlocked(provider, model) {
  const quota = provider?.quota
  if (!quota?.enabled) return null
  // 已被「多次 429」判定为额度耗尽：直接等到窗口重置
  const locked = quotaLocked(provider, model)
  if (locked) {
    return {
      window: locked.level,
      retryAfter: Math.max(1, Math.ceil((locked.until - Date.now()) / 1000)),
      locked: true,
    }
  }
  const now = Date.now()
  // 预扣发现余额不足：短期跳过这把 Key，避免每次请求都重复排队
  const shortageUntil = quotaShortageOf(provider, model)
  if (shortageUntil > 0) {
    return {
      window: 'month',
      retryAfter: Math.max(1, Math.ceil((shortageUntil - now) / 1000)),
      locked: true,
    }
  }
  const limits = quotaLimitOf(provider, model)
  const { used5h, usedWeek, usedMonth, events } = quotaUsageOf(provider, model)
  // 自然月额度（端砚墨点）：用尽后只能等下月 1 日
  if (limits.limitMonth > 0 && usedMonth >= limits.limitMonth) {
    return {
      window: 'month',
      retryAfter: Math.max(1, Math.ceil((nextMonthStart(now) - now) / 1000)),
    }
  }
  if (limits.limit5h > 0 && used5h >= limits.limit5h) {
    const oldest = events.find((item) => item.at > now - QUOTA_WINDOW_5H_MS)
    return {
      window: '5h',
      retryAfter: oldest
        ? Math.max(1, Math.ceil((oldest.at + QUOTA_WINDOW_5H_MS - now) / 1000))
        : 1,
    }
  }
  if (limits.limitWeek > 0 && usedWeek >= limits.limitWeek) {
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

// 只对真正被上游受理 / 计费的调用记账：所有非 2xx 都不占额度。
// 商汤对未知字段返回 400、模型名错误返回 404，这些都不应该消耗「请求次数」。
function recordQuota(provider, { status, usage, model } = {}) {
  const quota = provider?.quota
  if (!quota?.enabled) return
  if (!(status >= 200 && status < 300)) return

  let units
  if (quota.metric === 'credit') {
    const tokens = Number(usage?.total) || 0
    // 端砚墨点按模型单价结算；即使不按模型分池（墨点账号共享），也要用对应模型的单价
    const configuredRate = model ? Number(quota.modelRates?.[model]) || 0 : 0
    const modelRate =
      (quota.perModel === true || monthlyQuotaOf(provider)) && configuredRate > 0
        ? configuredRate
        : 0
    const rate = modelRate > 0 ? modelRate : Number(quota.creditsPerMillionTokens) || 0
    if (tokens <= 0 || rate <= 0) return
    units = (tokens * rate) / 1_000_000
  } else {
    units = 1
  }
  if (units <= 0) return

  quotaStateOf(provider, model).events.push({ at: Date.now(), units })
  markQuotaWarmupSuccess(provider, model)
  schedulePersist()
}

// ---------- 端砚余额预扣（仅自然月额度） ----------
// 上游要排队约 8 秒才返回 quota_exceeded，本地先按「字符数 → tokens → 墨点」估算，
// 余额不够就跳过这把 Key，避免无效等待与批次占用。
const pendingQuota = new Map()

function estimatePromptTokens(rawBody) {
  try {
    const payload = JSON.parse(rawBody)
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    let chars = 0
    for (const message of messages) {
      const content = message?.content
      if (typeof content === 'string') chars += content.length
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string') chars += part.text.length
          else if (part?.image_url) chars += 1000
        }
      }
    }
    // 中文约 1 字符 1 token，英文约 4 字符 1 token；取折中并留 20% 余量
    return Math.ceil((chars / 2) * 1.2)
  } catch {
    return 0
  }
}

function estimateCostOf(provider, model, rawBody) {
  const quota = provider?.quota || {}
  if (!monthlyQuotaOf(provider) || quota.metric !== 'credit') return 0
  const rate = Number(quota.modelRates?.[model]) || Number(quota.creditsPerMillionTokens) || 0
  if (rate <= 0) return 0
  // 客户端没写 max_tokens 时按 256 估，避免把整段上下文都算成输出
  let maxTokens = 256
  try {
    const payload = JSON.parse(rawBody)
    const parsed = Math.max(
      0,
      Number(payload?.max_tokens) || Number(payload?.max_completion_tokens) || 0,
    )
    if (parsed > 0) maxTokens = parsed
  } catch {
    // 请求体不是合法 JSON 时沿用默认上限
  }
  return ((estimatePromptTokens(rawBody) + maxTokens) * rate) / 1_000_000
}

// 返回 false 表示余额不足；返回函数表示预扣成功（请求结束释放）；null 表示不适用
const quotaShortage = new Map()

// 预扣失败只做短期软标记：估算可能有误差，先跳过这把 Key，
// 真正被上游确认 quota_exceeded 后再按月锁定
function markQuotaShortage(provider, model, ms = 10 * 60 * 1000) {
  if (!isDuanyan(provider)) return
  quotaShortage.set(quotaPoolKeyOf(provider, model), Date.now() + ms)
}

function quotaShortageOf(provider, model) {
  const key = quotaPoolKeyOf(provider, model)
  const until = quotaShortage.get(key)
  if (!until) return 0
  if (until <= Date.now()) {
    quotaShortage.delete(key)
    return 0
  }
  return until
}

function reserveQuota(provider, model, units) {
  if (!monthlyQuotaOf(provider) || !provider?.quota?.enabled) return null
  const amount = Number(units)
  if (!(amount > 0)) return null
  const limits = quotaLimitOf(provider, model)
  if (limits.limitMonth <= 0) return null
  const key = quotaPoolKeyOf(provider, model)
  let pending = pendingQuota.get(key)
  if (!pending) {
    pending = new Set()
    pendingQuota.set(key, pending)
  }
  const pendingUnits = [...pending].reduce((sum, item) => sum + item.units, 0)
  const { usedMonth } = quotaUsageOf(provider, model)
  if (usedMonth + pendingUnits + amount > limits.limitMonth) return false
  const ticket = { units: amount }
  pending.add(ticket)
  return () => {
    pending.delete(ticket)
    if (pending.size === 0) pendingQuota.delete(key)
  }
}

function resetQuota(providerKey) {
  const maps = [quotaByProvider, quotaStrikes, quotaLocks, quotaLevels, quotaWarmup, quotaSwrr]
  if (!providerKey) {
    for (const map of maps) map.clear()
    pendingQuota.clear()
    quotaShortage.clear()
    return
  }
  const prefix = `${providerKey}::`
  for (const map of maps) {
    for (const key of [...map.keys()]) {
      if (key === providerKey || String(key).startsWith(prefix)) map.delete(key)
    }
  }
}

// ---------- 429 撞墙判定（防误判） ----------
// 单次 429 可能只是瞬时限流：必须「有间隔的多次 429」才认定该 Key 的额度窗口用尽，
// 认定后该 Key 暂停到窗口重置（先按 5 小时，5 小时后再撞墙则升级为 7 天）。
// 高频持续 429 通过突发计数兜底；跨越多天的孤立 429 会被观察窗口过滤掉，不会误锁。
const DEFAULT_QUOTA_STRIKES = 3
const DEFAULT_QUOTA_INTERVAL_MINUTES = 1
const DEFAULT_QUOTA_BURST_WINDOW_MINUTES = 10

function strikeConfigOf(provider) {
  const quota = provider?.quota || {}
  const strikesRaw = Number(quota.confirmStrikes)
  const intervalRaw = Number(quota.confirmIntervalMinutes)
  const strikes = strikesRaw > 0 ? Math.min(10, Math.floor(strikesRaw)) : DEFAULT_QUOTA_STRIKES
  const intervalMs = (intervalRaw > 0 ? intervalRaw : DEFAULT_QUOTA_INTERVAL_MINUTES) * 60 * 1000
  // 观察窗口：超过这个跨度仍未凑齐的 429 视为不同事件，不再累计
  const spanRaw = Number(quota.confirmSpanMinutes)
  const spanMs =
    spanRaw > 0 ? spanRaw * 60 * 1000 : Math.max(intervalMs * (strikes - 1), 60 * 1000) * 3
  const burstWindowRaw = Number(quota.burstWindowMinutes)
  const burstWindowMs =
    (burstWindowRaw > 0 ? burstWindowRaw : DEFAULT_QUOTA_BURST_WINDOW_MINUTES) * 60 * 1000
  const burstStrikesRaw = Number(quota.burstStrikes)
  return {
    strikes,
    intervalMs,
    spanMs,
    burstWindowMs,
    burstStrikes: burstStrikesRaw > 0 ? Math.min(100, Math.floor(burstStrikesRaw)) : 0,
  }
}

// 只读检查：用于调度权重，不触发半开恢复状态
function currentQuotaLockOf(provider, model) {
  const entry = quotaLocks.get(quotaPoolKeyOf(provider, model))
  if (!entry || entry.until <= Date.now()) return null
  return entry
}

function quotaLocked(provider, model) {
  const key = quotaPoolKeyOf(provider, model)
  const entry = quotaLocks.get(key)
  if (!entry) return null
  if (entry.until > Date.now()) return entry

  // 锁定到期：清掉锁并进入半开恢复。探测阶段只放 20% 流量，
  // 成功一次后逐步恢复；若探测就再次 429，noteQuotaHit 会直接升级等级。
  quotaLocks.delete(key)
  if (!quotaWarmup.has(key)) {
    const quota = provider?.quota || {}
    const minutes =
      Number(quota.warmupMinutes) > 0 ? Number(quota.warmupMinutes) : DEFAULT_QUOTA_WARMUP_MINUTES
    const now = Date.now()
    quotaWarmup.set(key, {
      startedAt: now,
      until: now + minutes * 60 * 1000,
      probing: true,
    })
  }
  return null
}

// 记录一次 429；返回新产生的锁定（或 null）。
// 间隔不足的 429 不推进 lastAt（否则持续高频撞墙时永远累计不到 strikes）。
function noteQuotaHit(provider, model, options = {}) {
  if (!provider?.quota?.enabled) return null
  // 端砚的分钟限流由冷却处理（实测 60 秒恢复），不进入「额度撞墙」判定，避免误锁 5h/月
  if (isDuanyan(provider) && options.signal === 'rate') return null
  const key = quotaPoolKeyOf(provider, model)
  const { strikes, intervalMs, spanMs, burstWindowMs, burstStrikes } = strikeConfigOf(provider)
  const now = Date.now()
  const state = quotaStrikes.get(key) || { hits: [], burst: [], lastAt: 0, level: '' }
  state.burst = Array.isArray(state.burst) ? state.burst : []

  // 半开探测失败，或上游明确返回额度耗尽：不再等 3 次，直接锁定
  const probing = Boolean(quotaWarmup.get(key)?.probing)
  if (probing || options.signal === 'quota') {
    return commitQuotaLock(provider, model, state, now, { ...options, probeFailed: probing })
  }

  // 只保留观察窗口内的确认点与突发点
  state.hits = state.hits.filter((at) => now - at <= spanMs)
  state.burst = state.burst.filter((at) => now - at <= burstWindowMs)

  // 高频持续 429：同一波内的瞬时限流通常远达不到这个密度
  if (burstStrikes > 0) {
    state.burst.push(now)
    if (state.burst.length >= burstStrikes) {
      return commitQuotaLock(provider, model, state, now, options)
    }
  }

  if (state.lastAt && now - state.lastAt < intervalMs) {
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
  return commitQuotaLock(provider, model, state, now, options)
}

function commitQuotaLock(provider, model, state, now, options = {}) {
  const key = quotaPoolKeyOf(provider, model)
  // 自然月额度（端砚墨点）：余额不足直接锁到月初，不做 5h → week 的升级
  if (monthlyQuotaOf(provider)) {
    const lock = { until: nextMonthStart(now), level: 'month', at: now }
    quotaLocks.set(key, lock)
    quotaLevels.set(key, { level: 'month', at: now })
    quotaStrikes.set(key, { hits: [], burst: [], lastAt: 0, level: 'month' })
    quotaWarmup.delete(key)
    schedulePersist()
    return lock
  }
  const remembered = quotaLevels.get(key)?.level || ''
  const previous = state.level || remembered
  // 半开探测仍失败说明窗口没有真正恢复；已经锁过一次（5h 或 week）后再确认也升级为周锁。
  const level = options.probeFailed === true || previous ? 'week' : '5h'

  const windowMs = level === 'week' ? QUOTA_WINDOW_WEEK_MS : QUOTA_WINDOW_5H_MS
  let duration = windowMs
  if (level === '5h') {
    // 对齐滚动窗口：按本地记账估算多久恢复到 80% 可用，至少锁 5 分钟
    duration = Math.min(windowMs, Math.max(QUOTA_MIN_LOCK_MS, estimateRecoveryMs(provider, model)))
  }
  const retryAfterMs = Math.max(0, Number(options.retryAfterMs) || 0)
  if (retryAfterMs > 0) duration = Math.max(duration, Math.min(windowMs, retryAfterMs))

  const lock = { until: now + duration, level, at: now }
  quotaLocks.set(key, lock)
  quotaLevels.set(key, { level, at: now })
  quotaStrikes.set(key, { hits: [], burst: [], lastAt: 0, level })
  quotaWarmup.delete(key)
  schedulePersist()
  return lock
}

function snapshotQuota() {
  const list = []
  const round = (value) => Math.round(value * 100) / 100
  // 墨点额度通常是 10 级别，两位小数会把小额消耗直接抹成 0，这里保留 4 位
  const roundFine = (value) => Math.round(value * 10000) / 10000
  for (const provider of config.providers || []) {
    if (!provider.quota?.enabled) continue
    const keys = apiKeysOf(provider)
    const entries = keys.length > 0 ? keys : ['']
    // 按模型独立额度时，逐个模型展示水位；否则保持一条 Key 级别的汇总
    const models = provider.quota.perModel
      ? [
          ...new Set([
            ...(provider.models || []),
            ...Object.values(provider.modelAliases || {}),
            ...Object.keys(provider.quota.modelLimits || {}),
          ]),
        ]
      : ['']
    const modelEntries = models.length > 0 ? models : ['']
    for (const key of entries) {
      for (const model of modelEntries) {
        const candidate = { ...provider, apiKey: key }
        const scope = model || undefined
        const limits = quotaLimitOf(candidate, scope)
        const usage = quotaUsageOf(candidate, scope)
        const blocked = quotaBlocked(candidate, scope)
        const warmup = quotaWarmup.get(quotaPoolKeyOf(candidate, scope))
        list.push({
          // 只暴露 Key 尾号，避免把完整 Key 传到渲染进程
          id: `${providerKeyOf(provider)}#${keyTailOf(key)}${model ? `#${model}` : ''}`,
          providerId: providerKeyOf(provider),
          name: provider.name || provider.id,
          keyTail: keyTailOf(key),
          model: model || '',
          metric: provider.quota.metric,
          group: quotaGroupOf(candidate),
          keyGroup: quotaGroupOf(candidate),
          used5h: round(usage.used5h),
          limit5h: limits.limit5h,
          usedWeek: round(usage.usedWeek),
          limitWeek: limits.limitWeek,
          usedMonth: roundFine(usage.usedMonth),
          limitMonth: limits.limitMonth,
          exhausted: Boolean(blocked),
          locked: Boolean(blocked?.locked),
          window: blocked?.window || '',
          retryAfter: blocked?.retryAfter || 0,
          weight: Math.round(quotaWeightOf(candidate, scope) * 100) / 100,
          warmup: warmup ? (warmup.probing ? 'probing' : 'ramping') : '',
        })
      }
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
  // 端砚网关约 8 秒攒批一次：5 秒冷却会正好撞进同一批，改为 8 秒起步
  const base = isDuanyan(provider) ? DUANYAN_COOLDOWN_BASE_MS : COOLDOWN_BASE_MS
  const backoff = Math.min(COOLDOWN_MAX_MS, base * 2 ** (entry.failCount - 1))
  entry.until = Date.now() + Math.max(backoff, retryAfterMs)
  cooldownByKey.set(key, entry)
}

function markSuccess(provider, model) {
  cooldownByKey.delete(cooldownKeyOf(provider))
  if (model !== undefined) markQuotaWarmupSuccess(provider, model)
}

// Retry-After 支持秒数与 HTTP-date；解析失败返回 0（回退到本地指数退避）
function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(String(value))
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now())
}

// 从 429 响应体里区分「额度耗尽」与「瞬时限流」：
// 额度耗尽可以直接锁定，不必等多次确认；瞬时限流只做短冷却。
function parse429Signal(text) {
  if (!text) return ''
  const raw = Buffer.isBuffer(text) ? text.toString('utf8') : String(text)
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return ''
  }
  const code = String(
    payload?.error?.code ||
      payload?.error?.type ||
      payload?.code ||
      payload?.type ||
      payload?.error?.message ||
      '',
  ).toLowerCase()
  if (/insufficient|quota|exhaust|balance|billing|credit/.test(code)) return 'quota'
  if (/rate.?limit|too.?many|throttl|request.?limit/.test(code)) return 'rate'
  return ''
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
  const blocked = quotaBlocked(provider, context.model)
  if (blocked) {
    const label =
      blocked.window === 'month' ? '本月（自然月）' : blocked.window === '5h' ? '5 小时' : '7 天'
    throw Object.assign(new Error(`额度已用尽（${label}窗口）`), {
      code: 'quota_exceeded',
      status: 429,
      retryAfter: blocked.retryAfter,
      providerName: provider.name || provider.id,
    })
  }

  // 端砚余额预扣：先按本地单价估算本次成本，余额不足直接换 Key，
  // 不再排队 8 秒后才拿到 quota_exceeded
  const quotaCost = estimateCostOf(provider, context.model, body)
  const releaseQuota = reserveQuota(provider, context.model, quotaCost)
  if (releaseQuota === false) {
    markQuotaShortage(provider, context.model)
    throw Object.assign(new Error('本月墨点余额不足（预估）'), {
      code: 'quota_exceeded',
      status: 429,
      retryAfter: Math.max(1, Math.ceil((nextMonthStart() - Date.now()) / 1000)),
      providerName: provider.name || provider.id,
    })
  }

  // 限流/并发检查：超限直接抛 rate_limited，由上层决定是否换上游。
  // 端砚的 RPM 按「Key × 模型」计数，因此必须把模型传进去
  let release
  try {
    release = await acquireSlot(provider, context.streaming === true, context.model)
  } catch (error) {
    if (typeof releaseQuota === 'function') releaseQuota()
    throw error
  }

  const result = new Promise((resolve, reject) => {
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
        const upstreamRetryAfterMs = parseRetryAfterMs(upstreamRes.headers['retry-after'])

        // 可重试且还没向客户端写过任何东西 → 丢弃这个响应，换下一个上游
        if ((retryable || keyRetryable) && !res.headersSent && context.canRetry) {
          // 429 / 5xx 的响应体很小：读完（最多 8KB）解析错误码，区分瞬时限流与额度耗尽
          const signalChunks = []
          let signalBytes = 0
          const settleReject = () => {
            if (settled) return
            settled = true
            res.off('close', abortByClient)
            release()
            reject(
              Object.assign(new Error(`HTTP ${status}`), {
                status,
                retryable: true,
                retryAfterMs: upstreamRetryAfterMs,
                signal: status === 429 ? parse429Signal(Buffer.concat(signalChunks)) : '',
              }),
            )
          }
          upstreamRes.on('data', (chunk) => {
            if (signalBytes >= 8192) return
            signalChunks.push(chunk)
            signalBytes += chunk.length
          })
          upstreamRes.on('end', settleReject)
          upstreamRes.on('error', settleReject)
          upstreamRes.on('aborted', settleReject)
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
            path: context.path,
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
          recordQuota(provider, { status, usage, model: context.model })
          // 鉴权失败 / 限流 / 5xx 也进入冷却（单上游时是透传，不会走 catch）
          const shouldCool = status === 401 || status === 403 || status === 429 || status >= 500
          if (shouldCool) {
            // 429 优先尊重上游 Retry-After；端砚没有该头，按实测 60 秒窗口冷却，
            // 避免 8 秒批次内反复撞同一把 Key
            const rateWaitMs =
              status === 429
                ? Math.max(isDuanyan(provider) ? DUANYAN_RATE_RETRY_MS : 5000, upstreamRetryAfterMs)
                : 0
            markFailure(provider, rateWaitMs)
          } else if (status < 400) markSuccess(provider, context.model)
          // 429 累积判定：多次、有间隔的 429 才认定额度窗口用尽，避免把瞬时限流误判成额度耗尽
          if (status === 429) {
            const lock = noteQuotaHit(provider, context.model, {
              retryAfterMs: upstreamRetryAfterMs,
              signal: parse429Signal(Buffer.concat(chunks)),
            })
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
                path: context.path,
                error: `429 确认额度耗尽，该 Key 暂停至${lock.level === 'month' ? '下月 1 日' : lock.level === 'week' ? '周' : '5 小时'}窗口重置`,
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

  // 预扣无论成功、失败、断开都要释放；成功时 recordQuota 已按真实 usage 结算
  return typeof releaseQuota === 'function' ? result.finally(releaseQuota) : result
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
          path: context.path,
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
      const quotaLock =
        error.status === 429
          ? noteQuotaHit(provider, context.model, {
              retryAfterMs: error.retryAfterMs,
              signal: error.signal,
            })
          : null
      pushLog({
        at: new Date().toISOString(),
        model: context.model,
        provider: provider.name || provider.id,
        client: context.client || '',
        status: error.status || 0,
        ms: Date.now() - attemptStarted,
        stream: false,
        attempt: index + 1,
        path: context.path,
        error: quotaLock
          ? `429 确认额度耗尽，该 Key 暂停至${quotaLock.level === 'month' ? '下月 1 日' : quotaLock.level === 'week' ? '周' : '5 小时'}窗口重置`
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
        // 429 优先尊重上游 Retry-After；端砚不带该头，按实测的 60 秒滚动窗口冷却
        const upstreamWaitMs =
          isDuanyan(provider) && error.status === 429 && error.signal === 'rate'
            ? DUANYAN_RATE_RETRY_MS
            : error.retryAfterMs || 0
        markFailure(
          provider,
          error.code === 'rate_limited' ? (error.retryAfter || 1) * 1000 : upstreamWaitMs,
        )
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
      path: context.path,
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
  const providers = expandKeyCandidates(resolveProvidersFrom(config.providers, model), model).map(
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
        path: upstreamPath,
        error: null,
        requestId,
        keyTail: '',
        failover: false,
        // 命中缓存没有真实消耗：usage 留空，节省量单独记录，避免统计虚高
        usage: null,
        cachedUsage: hit.usage,
        cached: true,
      })
      recordStat({
        provider: { id: 'cache', name: '缓存' },
        model,
        status: hit.status,
        ms: 0,
        usage: hit.usage,
        cached: true,
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
    // 日志里记录请求路径，统计页据此区分 chat / embeddings 的缓存命中率
    path: upstreamPath,
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
    // embeddings 是确定性接口（同样的输入必然得到同样的向量），重复调用比例高，
    // 精确缓存对它的收益最大
    await handleJsonProxy(req, res, '/embeddings', true, client.label)
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
  // 重新启动时配置可能变了：重置调度累计权重，避免旧权重影响新 Key 组合
  quotaSwrr.clear()

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
    // Key 组合可能变化：清空调度累计权重，避免旧 Key 的权重残留
    quotaSwrr.clear()
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

// 单把 Key 测通：请求一次 /models，能拿到正常响应即视为该 Key 可用
async function testKey({ baseUrl, apiKey } = {}, timeout = 10000) {
  const startedAt = Date.now()
  try {
    const models = await fetchModelsWithKey({ baseUrl, apiKey }, timeout)
    return { ok: true, models: models.length, ms: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, error: error.message, ms: Date.now() - startedAt }
  }
}

module.exports = {
  start,
  stop,
  update,
  getStatus,
  fetchModels,
  testKey,
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
  getTokenHistory,
  getTokenHourly,
  getTokenUsage,
  getKeyUsage,
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
  quotaLimitOf,
  quotaUsageOf,
  quotaWeightOf,
  orderedKeysOf,
  estimateRecoveryMs,
  parseRetryAfterMs,
  parse429Signal,
  quotaPoolKeyOf,
  estimateCostOf,
  reserveQuota,
  markQuotaShortage,
  quotaShortageOf,
}
