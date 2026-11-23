// 本地中转站：把多个上游（OpenAI 兼容）聚合成一个本地 OpenAI 兼容端点。
// 只监听 127.0.0.1，不对外暴露；转发时透传上游的响应体（含 SSE 流）。
const http = require('http')
const https = require('https')
const fs = require('fs')
const crypto = require('crypto')
const { StringDecoder } = require('node:string_decoder')
const { computeUsageMetrics } = require('./lib/metrics.cjs')
const { classifyFailure, FAILURE_CLASSES } = require('./lib/failures.cjs')
const { classifyListenError, listLanAddresses } = require('./lib/net.cjs')
const {
  anthropicToOpenAI,
  openAIToAnthropic,
  createAnthropicSseTransform,
  aggregateOpenAIStream,
} = require('./gateway/adapters/anthropic.cjs')

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
  defaultProviderId: '',
  lan: { enabled: false },
  listenHost: HOST,
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

// 回环来源判定：仅本机访问可在未设 Key 时免鉴权；非回环（局域网）一律要求 Key
function isLoopbackRequest(req) {
  const addr = String(req.socket?.remoteAddress || '')
  if (!addr) return false
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

// 返回 { ok, label }：默认 Key 记为「默认」，多客户端 Key 用其名称，免鉴权记为「本机」
function identifyClient(req) {
  const auth = String(req.headers.authorization || '')
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  // Anthropic SDK / Claude Code 默认发 x-api-key，两种写法都认
  const token = bearer || String(req.headers['x-api-key'] || '').trim()
  const hasAnyKey = Boolean(config.apiKey) || config.clientKeys.length > 0
  // 非回环来源即使未设 Key 也拒绝：避免开启局域网后被任意访问
  if (!hasAnyKey) {
    return isLoopbackRequest(req) ? { ok: true, label: '本机' } : { ok: false, label: '' }
  }
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

// 命中模型别名时，把转发体里的 model 换成上游真实模型名
function mapModelAliases(candidates, model, payload) {
  return candidates.map((item) => {
    const mapped = item.modelAliases?.[model]
    if (!mapped || mapped === model) return item
    return {
      ...item,
      forwardModel: mapped,
      forwardBody: JSON.stringify({ ...payload, model: mapped }),
    }
  })
}

// 公钥 / 免鉴权上游（如本地推理服务）没有 Key 也能正常转发。
// 注册表快照里标注 auth.type = none 的预置项按免 Key 处理；快照缺失时保守要求 Key。
let keylessPresetIds = null
function keylessPresetIdsOf() {
  if (keylessPresetIds) return keylessPresetIds
  keylessPresetIds = new Set()
  try {
    const registry = require('./generated/providers.cjs')
    for (const item of registry.providers || []) {
      if (item?.auth?.type === 'none') keylessPresetIds.add(item.id)
    }
  } catch {
    // 未生成 providers 快照（直接 electron . 启动）：按「需要 Key」处理
  }
  return keylessPresetIds
}

function isKeylessProvider(provider) {
  if (provider?.auth?.type === 'none') return true
  const presetId = typeof provider?.presetId === 'string' ? provider.presetId : ''
  return Boolean(presetId) && keylessPresetIdsOf().has(presetId)
}

// 默认路由：模型未命中时回退到 defaultProviderId 指定的上游。
// 默认上游被禁用 / 无 Base URL / 无可用 Key → 返回明确错误（上层转 503），
// 绝不静默切到其它未授权上游。
function resolveDefaultCandidates(model, payload) {
  const id = config.defaultProviderId
  const target = (config.providers || []).find((item) => (item.id || item.baseUrl) === id)
  if (!target || target.enabled === false || !target.baseUrl) {
    return { error: `默认上游「${id}」不可用（已禁用或未配置 Base URL）。` }
  }
  if (apiKeysOf(target).length === 0 && !isKeylessProvider(target)) {
    return { error: `默认上游「${target.name || id}」没有可用的 API Key。` }
  }
  return { candidates: mapModelAliases(expandKeyCandidates([target], model), model, payload) }
}

// 统一路由：常规模型解析（精确 → 通配 → 单上游）+ 默认路由兜底。
// 返回 { candidates, routedBy } 或 { error, status, type }，供 chat / messages 共用。
function resolveRoute(model, payload) {
  const candidates = mapModelAliases(
    expandKeyCandidates(resolveProvidersFrom(config.providers, model), model),
    model,
    payload,
  )
  if (candidates.length > 0) return { candidates, routedBy: '' }
  if (config.defaultProviderId) {
    const fallback = resolveDefaultCandidates(model, payload)
    if (fallback.error) {
      return { error: fallback.error, status: 503, type: 'default_provider_unavailable' }
    }
    return { candidates: fallback.candidates, routedBy: 'default' }
  }
  return {
    error: `没有提供商提供模型「${model}」。请在中转站里为该模型配置提供商，或只启用一个上游。`,
    status: 404,
    type: 'model_not_found',
  }
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
// 官方口径（2026-11 文档）：生成模型 RPM 默认每用户 50，全部 API Key 合并计算，
// Chat Completions / Responses / Messages 共用；429 分两码——rate_limit_exceeded
// 可退避重试，quota_exceeded 是墨点不足、不应重试。网关约 8 秒攒批一次。
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

// ---------- 商汤网关特性（presetId = sensenova 或 token.sensenova.cn） ----------
// 官方 429 只有一个错误码 quota_exceeded_error，同时表示「速率/额度超限」（2026-11 文档），
// 与端砚不同：无法从响应体区分瞬时限流与真实额度耗尽。
const SENSENOVA_PRESET_ID = 'sensenova'

function isSensenova(provider) {
  const base = String(provider?.baseUrl || '').toLowerCase()
  return provider?.presetId === SENSENOVA_PRESET_ID || base.includes('sensenova.cn')
}

const runtimeByProvider = new Map()

// 端砚的并发按「提供商 + Key」隔离，避免一把 Key 的长流占满全部槽位；
// RPM 是官方的用户级限额（全部 Key 合并计算），单独按提供商共享，见 rpmHitsByProvider。
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
      waiters: [],
    })
  }
  return runtimeByProvider.get(key)
}

// 端砚 RPM 官方按「每用户」计：全部 Key 与生成接口合并计算，因此窗口按提供商共享；
// 其它提供商的 runtime 本就按提供商为键，直接用 runtime.hits。
const rpmHitsByProvider = new Map()

function hitsOf(runtime, provider) {
  if (!isDuanyan(provider)) return runtime.hits
  const key = provider.id || provider.name || provider.baseUrl
  if (!rpmHitsByProvider.has(key)) rpmHitsByProvider.set(key, [])
  return rpmHitsByProvider.get(key)
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

// model 参数保留以兼容调用方与测试（原按模型分桶，现 RPM 统一为提供商级窗口）
function acquireSlot(provider, streaming = false, _model = '') {
  const runtime = getRuntime(provider)
  const { maxConcurrency, rpmLimit, queueTimeoutMs, maxStreams } = limitsOf(provider)
  const now = Date.now()

  // 滑动窗口：只保留最近 60 秒（端砚为提供商级共享窗口，其它提供商按提供商汇总）
  const windowHits = hitsOf(runtime, provider)
  for (let index = windowHits.length - 1; index >= 0; index -= 1) {
    if (now - windowHits[index] >= RPM_WINDOW_MS) windowHits.splice(index, 1)
  }

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
      // 与发出请求时相同的计数窗口（端砚为提供商级共享窗口），避免排队放行时记错桶
      hits: hitsOf(runtime, provider),
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
  rpmHitsByProvider.clear()
  keyCursor.clear()
  resetQuota()
}

function snapshotLoad() {
  const providers = config.providers || []
  const result = {}
  for (const provider of providers) {
    const key = provider.id || provider.name || provider.baseUrl
    const { maxConcurrency, maxStreams, rpmLimit } = limitsOf(provider)
    result[key] = {
      name: provider.name || key,
      inflight: 0,
      streaming: 0,
      maxConcurrency,
      maxStreams,
      rpmLimit,
      queued: 0,
    }
  }
  // 端砚的运行时按「提供商 + Key」隔离（见 runtimeKeyOf），负载快照必须
  // 把各 Key 的并发/排队合并回提供商维度，否则面板永远显示 0
  const ids = new Set(providers.map((p) => p.id || p.name || p.baseUrl))
  for (const [runtimeKey, runtime] of runtimeByProvider) {
    let providerKey = runtimeKey
    if (!ids.has(providerKey)) {
      const idx = runtimeKey.indexOf('::')
      if (idx !== -1 && ids.has(runtimeKey.slice(0, idx))) providerKey = runtimeKey.slice(0, idx)
    }
    const entry = result[providerKey]
    if (!entry) continue
    entry.inflight += runtime.inflight || 0
    entry.streaming += runtime.streaming || 0
    entry.queued += runtime.waiters?.length || 0
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

// 持久化 / 回传渲染层的标识用短哈希代替明文 Key：
// 额度锁、等级记忆会写进 relay-usage.json，冷却快照会随状态回传渲染进程。
function keyIdOf(apiKey) {
  return crypto
    .createHash('sha256')
    .update(typeof apiKey === 'string' ? apiKey : '')
    .digest('hex')
    .slice(0, 16)
}

function pushLog(entry) {
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...entry }
  logs.unshift(item)
  pruneLogs()
  // 日志是每次上游尝试的唯一入口：按 Key 持久化统计、长期提供商观察都在这里累计，
  // 这样取消、额度耗尽等异常尝试不会漏记。
  recordKeyUsage(item)
  recordProviderObservation(item)
  schedulePersist()
  return item
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

// ---------- 运行诊断日志（只记生命周期与异常事件，与逐请求日志分开） ----------
// 逐请求日志是「调用监控」的数据源；诊断日志聚焦启动/停止、配置变更、
// 配额锁定、上游失败等运行状态，排查问题时不会被高频成功请求淹没。
// 诊断事件保留 30 天，供长期排查；更长期的调用“脾气”看 providerDaily（180 天）
const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_DIAGNOSTICS = 10000
const AUTH_DENIED_DIAG_INTERVAL_MS = 60 * 1000
let lastAuthDeniedDiagAt = 0
const diagnostics = []

// 与 logs 相同：按时间从新到旧排列，过期记录集中在尾部
function pruneDiagnostics(now = Date.now()) {
  const cutoff = now - DIAGNOSTIC_RETENTION_MS
  while (diagnostics.length > 0) {
    const at = new Date(diagnostics[diagnostics.length - 1]?.at).getTime()
    if (!Number.isNaN(at) && at >= cutoff) break
    diagnostics.pop()
  }
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS
}

// level：info / warn / error；category 用于前端筛选，message 是给用户看的结论，
// detail 放定位问题所需的上下文（提供商、模型、Key 尾号、锁定时间等）。
function pushDiagnostic(level, category, message, detail = '') {
  diagnostics.unshift({
    id: `diag_${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    category: String(category || '运行'),
    message: String(message || ''),
    detail: String(detail || ''),
  })
  pruneDiagnostics()
  schedulePersist()
}

function getDiagnostics() {
  pruneDiagnostics()
  return diagnostics.slice()
}

function clearDiagnostics() {
  diagnostics.length = 0
  return persistNow()
}

function isDiagnostic(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.message === 'string'
}

// ---------- 长期提供商观察（按 提供商 + 模型 + 自然日 聚合） ----------
// 诊断事件只保留短期细节；这里把真实调用结果按天累计，保留 180 天。
// 目的：观察商汤 / 端砚等上游的 429 分布、限流与额度锁定、延迟和错误“脾气”，
// 后续迭代时直接基于这些留存数据判断，而不是靠临时推测。
const PROVIDER_OBSERVATION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000
const MAX_PROVIDER_OBSERVATIONS = 8000
const providerDaily = new Map()

function emptyProviderObservation(providerId, provider, model, date) {
  return {
    id: `${providerId}::${model || ''}::${date}`,
    providerId: String(providerId || provider || '未知'),
    provider: String(provider || providerId || '未知'),
    model: String(model || ''),
    date,
    calls: 0,
    success: 0,
    rateLimited: 0,
    quotaLimited: 0,
    authFailed: 0,
    clientErrors: 0,
    serverErrors: 0,
    networkErrors: 0,
    aborted: 0,
    latency: { sum: 0, max: 0, buckets: [0, 0, 0, 0, 0, 0] },
    tokens: { prompt: 0, completion: 0, total: 0 },
    // 0-23 点：调用 / 429 限流 / 额度锁定分别累计，便于识别高峰时段
    hourCalls: Array(24).fill(0),
    hourRateLimited: Array(24).fill(0),
    hourQuotaLimited: Array(24).fill(0),
    locks: { probe: 0, '5h': 0, week: 0 },
    recoveries: 0,
    recoveryMsSum: 0,
    lastRecoveryLevel: '',
    firstAt: '',
    lastAt: '',
  }
}

function ensureProviderObservation(providerId, provider, model, date) {
  const id = `${providerId || provider || '未知'}::${model || ''}::${date}`
  let row = providerDaily.get(id)
  if (!row) {
    row = emptyProviderObservation(providerId, provider, model, date)
    providerDaily.set(id, row)
  }
  return row
}

function observationBucketOf(ms) {
  if (ms < 100) return 0
  if (ms < 500) return 1
  if (ms < 2000) return 2
  if (ms < 8000) return 3
  if (ms < 30000) return 4
  return 5
}

function recordProviderObservation(entry) {
  const providerName = String(entry?.provider || '').trim()
  // 缓存命中不是上游调用；额度汇总日志也不是一次真实上游尝试
  if (!providerName || providerName === '缓存') return
  if (entry.summary) return
  const at = new Date(entry.at || Date.now())
  if (Number.isNaN(at.getTime())) return

  const providerId = String(entry.providerId || providerName)
  const model = String(entry.model || '')
  const row = ensureProviderObservation(providerId, providerName, model, localDateKey(at))
  const status = Number(entry.status) || 0
  const ok = !entry.error && status >= 200 && status < 400
  const ms = Math.max(0, Number(entry.ms) || 0)
  const hour = at.getHours()

  row.calls += 1
  if (ok) row.success += 1
  if (status === 499) row.aborted += 1
  else if (status === 429) row.rateLimited += 1
  else if (status === 401 || status === 403) row.authFailed += 1
  else if (status >= 500) row.serverErrors += 1
  else if (status >= 400) row.clientErrors += 1
  else if (!status) row.networkErrors += 1

  row.latency.sum += ms
  row.latency.max = Math.max(row.latency.max, ms)
  row.latency.buckets[observationBucketOf(ms)] += 1

  if (entry.usage) {
    const prompt = Number(entry.usage.prompt) || 0
    const completion = Number(entry.usage.completion) || 0
    const total = Number(entry.usage.total) || prompt + completion
    row.tokens.prompt += prompt
    row.tokens.completion += completion
    row.tokens.total += total
  }

  row.hourCalls[hour] += 1
  if (status === 429) row.hourRateLimited[hour] += 1
  if (!row.firstAt) row.firstAt = entry.at || at.toISOString()
  row.lastAt = entry.at || at.toISOString()
}

// 真实 429 锁定事件：记录等级，观察一段时间内 5 分钟 / 5 小时 / 7 天各发生多少次
function recordProviderLock(provider, model, lock, now = Date.now()) {
  const providerId = String(provider?.id || provider?.name || provider?.baseUrl || '未知')
  const providerName = String(provider?.name || providerId)
  const row = ensureProviderObservation(
    providerId,
    providerName,
    String(model || ''),
    localDateKey(new Date(now)),
  )
  const level = normalizeQuotaLevel(lock?.level)
  row.locks[level] = (row.locks[level] || 0) + 1
  // 每次锁定都来自一次真实额度耗尽，单独累计额度类 429 与发生小时
  row.quotaLimited += 1
  row.hourQuotaLimited[new Date(now).getHours()] += 1
  row.lastAt = new Date(now).toISOString()
}

// 真实成功解除锁定：记录恢复次数与从锁定到恢复的时长
function recordProviderRecovery(provider, model, level, startedAt, now = Date.now()) {
  const providerId = String(provider?.id || provider?.name || provider?.baseUrl || '未知')
  const providerName = String(provider?.name || providerId)
  const row = ensureProviderObservation(
    providerId,
    providerName,
    String(model || ''),
    localDateKey(new Date(now)),
  )
  row.recoveries += 1
  const from = Number(startedAt) || 0
  if (from > 0) row.recoveryMsSum += Math.max(0, now - from)
  if (level) row.lastRecoveryLevel = normalizeQuotaLevel(level)
  schedulePersist()
}

function normalizeHourSeries(value) {
  const base = Array(24).fill(0)
  if (!Array.isArray(value)) return base
  for (let index = 0; index < Math.min(24, value.length); index += 1) {
    base[index] = Math.max(0, Number(value[index]) || 0)
  }
  return base
}

function normalizeProviderObservation(item) {
  if (!item || typeof item.provider !== 'string' || typeof item.date !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return null
  const providerId = item.providerId || item.provider
  const row = emptyProviderObservation(providerId, item.provider, item.model, item.date)
  for (const key of [
    'calls',
    'success',
    'rateLimited',
    'quotaLimited',
    'authFailed',
    'clientErrors',
    'serverErrors',
    'networkErrors',
    'aborted',
    'recoveries',
    'recoveryMsSum',
  ]) {
    row[key] = Math.max(0, Number(item[key]) || 0)
  }
  row.latency = {
    sum: Math.max(0, Number(item.latency?.sum) || 0),
    max: Math.max(0, Number(item.latency?.max) || 0),
    buckets: normalizeHourSeries(item.latency?.buckets).slice(0, 6),
  }
  row.tokens = {
    prompt: Math.max(0, Number(item.tokens?.prompt) || 0),
    completion: Math.max(0, Number(item.tokens?.completion) || 0),
    total: Math.max(0, Number(item.tokens?.total) || 0),
  }
  row.hourCalls = normalizeHourSeries(item.hourCalls)
  row.hourRateLimited = normalizeHourSeries(item.hourRateLimited)
  row.hourQuotaLimited = normalizeHourSeries(item.hourQuotaLimited)
  row.locks = {
    probe: Math.max(0, Number(item.locks?.probe) || 0),
    '5h': Math.max(0, Number(item.locks?.['5h']) || 0),
    week: Math.max(0, Number(item.locks?.week) || 0),
  }
  row.lastRecoveryLevel =
    typeof item.lastRecoveryLevel === 'string' && item.lastRecoveryLevel
      ? normalizeQuotaLevel(item.lastRecoveryLevel)
      : ''
  row.firstAt = typeof item.firstAt === 'string' ? item.firstAt : ''
  row.lastAt = typeof item.lastAt === 'string' ? item.lastAt : ''
  if (row.calls === 0 && row.recoveries === 0 && !Object.values(row.locks).some(Boolean)) {
    return null
  }
  return row
}

function pruneProviderObservations(now = Date.now()) {
  const cutoff = localDateKey(new Date(now - PROVIDER_OBSERVATION_RETENTION_MS))
  for (const [key, row] of providerDaily) {
    if (row.date < cutoff) providerDaily.delete(key)
  }
  if (providerDaily.size <= MAX_PROVIDER_OBSERVATIONS) return
  const oldest = [...providerDaily.entries()].sort(
    (a, b) => a[1].date.localeCompare(b[1].date) || a[0].localeCompare(b[0]),
  )
  const remove = providerDaily.size - MAX_PROVIDER_OBSERVATIONS
  for (let index = 0; index < remove; index += 1) providerDaily.delete(oldest[index][0])
}

function cloneProviderObservation(row) {
  return {
    ...row,
    latency: { ...row.latency, buckets: [...(row.latency?.buckets || [])] },
    tokens: { ...row.tokens },
    hourCalls: [...row.hourCalls],
    hourRateLimited: [...row.hourRateLimited],
    hourQuotaLimited: [...row.hourQuotaLimited],
    locks: { ...row.locks },
  }
}

// 清空长期观察数据（维护 / 测试使用）
function clearProviderObservations() {
  providerDaily.clear()
  return persistNow()
}

// 长期观察数据：按日期倒序返回，前端自行按提供商 / 模型 / 范围筛选
function getProviderObservations() {
  pruneProviderObservations()
  return [...providerDaily.values()]
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    )
    .map(cloneProviderObservation)
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
  return {
    calls: 0,
    success: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    lastAt: null,
    ttftSamples: 0,
    ttftTotalMs: 0,
    avgTtftMs: 0,
    lastTtftMs: null,
    lastTps: null,
  }
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
    ttftSamples: Number(value.ttftSamples) || 0,
    ttftTotalMs: Number(value.ttftTotalMs) || 0,
    avgTtftMs: Number(value.avgTtftMs) || 0,
    lastTtftMs: value.lastTtftMs ?? null,
    lastTps: value.lastTps ?? null,
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
      if (bucket.ttftSamples > 0) {
        result.ttftSamples += bucket.ttftSamples
        result.ttftTotalMs += bucket.ttftTotalMs
        result.avgTtftMs = Math.round(result.ttftTotalMs / result.ttftSamples)
        if (bucket.lastTtftMs != null) result.lastTtftMs = bucket.lastTtftMs
        if (bucket.lastTps != null) result.lastTps = bucket.lastTps
      }
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
  // 缓存命中 / 额度汇总等没有归属 Key 的日志不计入；每次尝试只产生一条日志，
  // 额度锁定信息合并在这条日志里，因此 quota 标记不能作为跳过依据，否则会漏记 429
  if (!tail) return
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
      ttftSamples: 0,
      ttftTotalMs: 0,
      avgTtftMs: 0,
      lastTtftMs: null,
      lastTps: null,
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
  // TTFT / TPS：日志里带首 token 时间戳时累计，供按 Key 的速度对比
  if (Number(entry.ttftMs) >= 0 && entry.ttftMs != null) {
    row.ttftSamples = (row.ttftSamples || 0) + 1
    row.ttftTotalMs = (row.ttftTotalMs || 0) + Number(entry.ttftMs)
    row.avgTtftMs = Math.round(row.ttftTotalMs / row.ttftSamples)
    row.lastTtftMs = Number(entry.ttftMs)
    if (entry.tps != null) row.lastTps = Number(entry.tps)
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
  if (Number(entry.ttftMs) >= 0 && entry.ttftMs != null) {
    hourBucket.ttftSamples += 1
    hourBucket.ttftTotalMs += Number(entry.ttftMs)
    hourBucket.avgTtftMs = Math.round(hourBucket.ttftTotalMs / hourBucket.ttftSamples)
    hourBucket.lastTtftMs = Number(entry.ttftMs)
    if (entry.tps != null) hourBucket.lastTps = Number(entry.tps)
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
  // reasoning token 单独记录：TPS 口径要把它从可见输出里剔除
  const reasoningTokens =
    Number(
      usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens ??
        usage.reasoning_tokens,
    ) || 0
  return { prompt, completion, total, reasoningTokens }
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

function recordStat({ provider, model, status, ms, error, usage, cached = false, metrics = null }) {
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
      ttftSamples: 0,
      ttftTotalMs: 0,
      avgTtftMs: 0,
      lastTtftMs: null,
      lastTps: null,
      lastReasoningTokens: 0,
      lastUsageMissing: false,
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
  // TTFT / TPS：只统计真实上游响应（缓存命中没有首 token 概念，不参与）
  if (metrics?.ttftMs != null) {
    entry.ttftSamples = (entry.ttftSamples || 0) + 1
    entry.ttftTotalMs = (entry.ttftTotalMs || 0) + metrics.ttftMs
    entry.avgTtftMs = Math.round(entry.ttftTotalMs / entry.ttftSamples)
    entry.lastTtftMs = metrics.ttftMs
  }
  if (metrics?.tps != null) entry.lastTps = metrics.tps
  entry.lastReasoningTokens = Number(metrics?.reasoningTokens) || 0
  entry.lastUsageMissing = Boolean(metrics?.usageMissing)
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
    // 长期提供商观察：优先恢复 180 天聚合；升级前没有该字段时用仍保留的日志回填一次
    providerDaily.clear()
    if (Array.isArray(raw.providerDaily)) {
      for (const item of raw.providerDaily.slice(-MAX_PROVIDER_OBSERVATIONS)) {
        const row = normalizeProviderObservation(item)
        if (row) providerDaily.set(row.id, row)
      }
    } else if (logs.length > 0) {
      for (const item of [...logs].reverse()) recordProviderObservation(item)
    }
    pruneProviderObservations()
    if (Array.isArray(raw.diagnostics)) {
      const cutoff = Date.now() - DIAGNOSTIC_RETENTION_MS
      const kept = raw.diagnostics.filter(isDiagnostic).filter((item) => {
        const at = new Date(item.at).getTime()
        return !Number.isNaN(at) && at >= cutoff
      })
      diagnostics.splice(0, diagnostics.length, ...kept.slice(0, MAX_DIAGNOSTICS))
    }
    if (Array.isArray(raw.stats)) {
      statsByKey.clear()
      for (const item of raw.stats.slice(0, MAX_STATS)) {
        if (item && item.id) statsByKey.set(item.id, item)
      }
    }
    // 真实 429 锁定恢复：否则重启后被判定耗尽的 Key 会继续打上游
    let migratedKeys = false
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
        const level = normalizeQuotaLevel(lock.level)
        // 旧版本的「自然月」锁迁移为 7 天锁定，避免升级后继续锁到月底
        const until =
          lock.level === 'month'
            ? Math.min(lock.until, (Number(lock.at) || now) + QUOTA_WINDOW_WEEK_MS)
            : lock.until
        const poolKey = migrateQuotaPoolKey(entry[0])
        if (poolKey !== entry[0]) migratedKeys = true
        quotaLocks.set(poolKey, {
          until,
          level,
          at: Number(lock.at) || now,
        })
        quotaStrikes.set(poolKey, { hits: [], burst: [], lastAt: 0, level })
      }
    }
    // 等级记忆单独保存：即使锁已经过期，也记得上次是 probe / 5h / week
    if (Array.isArray(raw.levels)) {
      quotaLevels.clear()
      const cutoff = Date.now() - QUOTA_WINDOW_WEEK_MS
      for (const entry of raw.levels) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const item = entry[1]
        if (!item || typeof item.level !== 'string') continue
        const at = Number(item.at) || 0
        if (at && at < cutoff) continue
        const poolKey = migrateQuotaPoolKey(entry[0])
        if (poolKey !== entry[0]) migratedKeys = true
        quotaLevels.set(poolKey, { level: normalizeQuotaLevel(item.level), at })
      }
    }
    // 迁移了旧格式锁键：尽快重写一次文件，把明文 Key 从落盘数据中清掉
    if (migratedKeys) schedulePersist()
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
          ttftSamples: Number(item.ttftSamples) || 0,
          ttftTotalMs: Number(item.ttftTotalMs) || 0,
          avgTtftMs: Number(item.avgTtftMs) || 0,
          lastTtftMs: item.lastTtftMs ?? null,
          lastTps: item.lastTps ?? null,
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
  const locks = [...quotaLocks.entries()].filter(([, lock]) => lock.until > Date.now())
  const levels = [...quotaLevels.entries()].filter(([, item]) => item && item.level)
  // 落盘前再裁一次，确保文件里不会保存过期日志与长期观察数据
  pruneLogs()
  pruneDiagnostics()
  pruneProviderObservations()
  let payload
  try {
    payload = JSON.stringify({
      version: 2,
      logs: logs.slice(0, MAX_PERSIST_LOGS),
      diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
      providerDaily: [...providerDaily.values()],
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

// ---------- 自动额度保护（完全按真实调用结果判断） ----------
// 不再按积分 / 请求次数 / 墨点估算额度。每个 Key × 模型只观察真实请求结果：
// - 真实成功：立即恢复；
// - 确认的连续真实 429：先锁 5 分钟做探测，探测仍 429 升级 5 小时，再失败升级 7 天；
// - 商汤 / 端砚以及其它提供商统一使用这套 5 小时 / 7 天窗口，不再有自然月分支。
const QUOTA_WINDOW_5H_MS = 5 * 60 * 60 * 1000
const QUOTA_WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000
// 首次确认额度耗尽后的短探测锁：用真实请求验证是否真的不可用，避免直接锁 5 小时
const QUOTA_PROBE_MS = 5 * 60 * 1000
// 锁定解除后的半开恢复时长：先小流量探测，成功后再逐步放量
const DEFAULT_QUOTA_WARMUP_MINUTES = 5

// 429 判定状态：hits 是「有间隔的确认点」，burst 是高频突发时间戳
const quotaStrikes = new Map()
const quotaLocks = new Map()
// 锁定解除后的半开恢复状态
const quotaWarmup = new Map()
// 上一次锁定等级（probe / 5h / week）：持久化后重启仍能继续升级，而不是重新从探测开始
const quotaLevels = new Map()

// 旧版本的 month 等级迁移为 week；未知值回退到首次探测
function normalizeQuotaLevel(level) {
  if (level === 'week') return 'week'
  if (level === '5h') return '5h'
  if (level === 'probe') return 'probe'
  if (level === 'month') return 'week'
  return 'probe'
}

function quotaLockLabel(level) {
  if (level === 'week') return '7 天'
  if (level === '5h') return '5 小时'
  return '5 分钟探测'
}

// 与 src/utils/relayConfig.js 的 normalizeQuota 保持同口径
function normalizeQuota(input) {
  const confirmStrikes = Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0)))
  const confirmIntervalMinutes = Math.max(0, Number(input?.confirmIntervalMinutes) || 0)
  const confirmSpanMinutes = Math.max(0, Number(input?.confirmSpanMinutes) || 0)
  const burstWindowMinutes = Math.max(0, Number(input?.burstWindowMinutes) || 0)
  const burstStrikes = Math.min(100, Math.max(0, Math.floor(Number(input?.burstStrikes) || 0)))
  const warmupMinutes = Math.max(0, Number(input?.warmupMinutes) || 0)

  // 共享组名列表：允许先建组、再往组里添加 Key（空组也要能保存）
  const groups = []
  if (Array.isArray(input?.groups)) {
    for (const item of input.groups) {
      const name = typeof item === 'string' ? item.trim() : ''
      if (name && !groups.includes(name)) groups.push(name)
    }
  }

  // Key 级共享组：明文 Key -> 组名，优先于提供商级默认组。
  // 同一账号的多把 Key 共享真实 429 锁定状态，但仍各用自己的真实响应对待。
  const keyGroups = {}
  if (input?.keyGroups && typeof input.keyGroups === 'object') {
    for (const [key, value] of Object.entries(input.keyGroups)) {
      const name = typeof key === 'string' ? key.trim() : ''
      const group = typeof value === 'string' ? value.trim() : ''
      if (name && group) keyGroups[name] = group
    }
  }
  return {
    enabled: input?.enabled === true,
    confirmStrikes,
    confirmIntervalMinutes,
    confirmSpanMinutes,
    burstWindowMinutes,
    burstStrikes,
    warmupMinutes,
    // 共享账号组：同组 Key 共享真实 429 锁定，避免同一账号被逐个撞墙
    group: typeof input?.group === 'string' ? input.group.trim() : '',
    groups,
    keyGroups,
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
    : `${providerKeyOf(provider)}::${keyIdOf(provider?.apiKey)}`
  // 额度锁定按真实 429 所属的 Key + 模型隔离，避免一个模型被限流时误伤同 Key 的其它模型
  return `${base}::${model || ''}`
}

// 旧版落盘的锁键是 provider::apiKey::model / group 键；升级时换成哈希键，
// 避免把明文 Key 继续留在 relay-usage.json 里。
function migrateQuotaPoolKey(key) {
  const value = String(key || '')
  if (!value || value.startsWith('group:')) return value
  const first = value.indexOf('::')
  if (first <= 0) return value
  const providerKey = value.slice(0, first)
  const rest = value.slice(first + 2)
  const second = rest.indexOf('::')
  const secret = second === -1 ? rest : rest.slice(0, second)
  // 空 Key / 合法哈希键保持不变，重复加载幂等
  if (!secret || /^[0-9a-f]{16}$/.test(secret)) return value
  return `${providerKey}::${keyIdOf(secret)}${second === -1 ? '' : rest.slice(second)}`
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

// 调度权重只反映真实状态：已锁定为 0；刚解锁的探测期降权；其余等权轮询。
function quotaWeightOf(provider, model) {
  if (!provider?.quota?.enabled) return 1
  if (currentQuotaLockOf(provider, model)) return 0
  return quotaWarmupRatioOf(provider, model)
}

// 返回 null 表示没有锁定；否则给出真实 429 锁定的等级与剩余时间。
// 额度是否存在不再由本地计数推断，只由真实上游 429 决定。
function quotaBlocked(provider, model) {
  if (!provider?.quota?.enabled) return null
  const locked = quotaLocked(provider, model)
  if (!locked) return null
  return {
    window: locked.level,
    retryAfter: Math.max(1, Math.ceil((locked.until - Date.now()) / 1000)),
    locked: true,
  }
}

function resetQuota(providerKey) {
  const maps = [quotaStrikes, quotaLocks, quotaLevels, quotaWarmup, quotaSwrr]
  if (!providerKey) {
    for (const map of maps) map.clear()
    return
  }
  for (const map of maps) {
    for (const key of [...map.keys()]) {
      if (quotaKeyBelongsTo(key, providerKey)) map.delete(key)
    }
  }
}

// 共享组池的键是 group:<providerId>::<组名>，普通 Key 池是 <providerId>::<key>
function quotaKeyBelongsTo(key, providerKey) {
  const value = String(key)
  return (
    value === providerKey ||
    value.startsWith(`${providerKey}::`) ||
    value.startsWith(`group:${providerKey}::`)
  )
}

// 手动解除真实 429 锁定：清掉锁定 / 等级记忆 / 半开探测状态，
// 让被锁的 Key 立即用真实请求重新探测上游。
function unlockQuota(providerKey) {
  let cleared = 0
  for (const map of [quotaStrikes, quotaLocks, quotaLevels, quotaWarmup]) {
    for (const key of [...map.keys()]) {
      if (!providerKey || quotaKeyBelongsTo(key, providerKey)) {
        map.delete(key)
        cleared += 1
      }
    }
  }
  if (cleared > 0) schedulePersist()
  return cleared
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

// 记录一次真实 429；返回新产生的锁定（或 null）。
// 间隔不足的 429 不推进 lastAt（否则持续高频撞墙时永远累计不到 strikes）。
function noteQuotaHit(provider, model, options = {}) {
  if (!provider?.quota?.enabled) return null
  // 商汤的 429 速率/额度同码，quota 信号降级为未区分：仍走连续确认 + 分级探测，
  // 避免把单次瞬时限流当成「明确额度耗尽」直接锁 5 小时
  if (options.signal === 'quota' && isSensenova(provider)) {
    options = { ...options, signal: '' }
  }
  // 上游明确说是分钟级/瞬时限流：只走冷却，不进入额度锁定，避免把限流误判成额度耗尽
  if (options.signal === 'rate') return null
  const key = quotaPoolKeyOf(provider, model)
  const { strikes, intervalMs, spanMs, burstWindowMs, burstStrikes } = strikeConfigOf(provider)
  const now = Date.now()
  const state = quotaStrikes.get(key) || { hits: [], burst: [], lastAt: 0, level: '' }
  state.burst = Array.isArray(state.burst) ? state.burst : []

  // 半开探测失败，或上游明确返回额度耗尽：不再等 3 次，直接锁定
  const probing = Boolean(quotaWarmup.get(key)?.probing)
  if (probing || options.signal === 'quota') {
    return commitQuotaLock(provider, model, state, now, options)
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

// 真实 429 分级锁定写一条诊断事件：排查「为什么某个 Key 突然不可用」时不用翻逐请求日志
function logQuotaLock(provider, model, lock) {
  const name = provider?.name || provider?.id || provider?.baseUrl || '未知上游'
  const tail = keyTailOf(provider?.apiKey)
  const levelText = quotaLockLabel(lock.level)
  const message =
    lock.level === 'probe'
      ? 'Key 出现真实额度耗尽，进入 5 分钟探测'
      : lock.level === 'week'
        ? 'Key 仍返回真实额度耗尽，已锁定 7 天窗口'
        : `Key 确认真实额度耗尽，已锁定 ${levelText}窗口`
  pushDiagnostic(
    'warn',
    '额度',
    message,
    `上游 ${name} · 模型 ${model || '默认'}${tail ? ` · Key …${tail}` : ''} · 解锁时间 ${new Date(
      lock.until,
    ).toLocaleString('zh-CN', { hour12: false })}`,
  )
}

// 按真实 429 的连续确认结果分级：首次只探测 5 分钟；探测仍失败 → 5 小时；
// 5 小时窗口结束后仍失败 → 7 天。任何真实成功都会 clearQuotaState 立即恢复。
function commitQuotaLock(provider, model, state, now, options = {}) {
  const key = quotaPoolKeyOf(provider, model)
  const activeLock = quotaLocks.get(key)
  if (activeLock?.until > now) return null

  // 等级记忆随时间衰减：超过记忆窗口 2 倍时长仍无任何真实成功/429 时，
  // 下一次确认 429 重新从 5 分钟探测开始，避免陈旧的「周锁」记忆一次就判 7 天。
  // （quotaLevels.at 与 state.level 在上次提交时同时写入，用前者判断新鲜度即可）
  const memory = quotaLevels.get(key)
  const memoryLevel = state.level || memory?.level || ''
  const memoryWindowMs =
    memoryLevel === 'week'
      ? QUOTA_WINDOW_WEEK_MS
      : memoryLevel === '5h'
        ? QUOTA_WINDOW_5H_MS
        : QUOTA_PROBE_MS
  const memoryFresh = Boolean(memory) && now - (memory.at || 0) <= memoryWindowMs * 2
  const previous = memoryFresh ? memoryLevel : ''
  let level = 'probe'
  if (previous === 'week') level = 'week'
  else if (previous === '5h') level = 'week'
  else if (previous === 'probe') level = '5h'
  // 上游明确返回 quota_exceeded：这是真实额度耗尽的强信号，直接锁 5 小时，
  // 不必再用 5 分钟探测去猜测；5 小时到期后的真实探测仍失败再升级 7 天。
  // （商汤 429 速率/额度同码，已在 noteQuotaHit 降级为未区分，不会走到这里）
  else if (options.signal === 'quota') level = '5h'

  const windowMs =
    level === 'week' ? QUOTA_WINDOW_WEEK_MS : level === '5h' ? QUOTA_WINDOW_5H_MS : QUOTA_PROBE_MS
  const retryAfterMs = Math.max(0, Number(options.retryAfterMs) || 0)
  // 有真实 Retry-After 时优先尊重上游，但不让探测锁超过 5 小时
  const duration =
    level === 'probe'
      ? Math.min(QUOTA_WINDOW_5H_MS, Math.max(windowMs, retryAfterMs))
      : Math.max(windowMs, Math.min(QUOTA_WINDOW_WEEK_MS, retryAfterMs))

  const lock = { until: now + duration, level, at: now }
  quotaLocks.set(key, lock)
  quotaLevels.set(key, { level, at: now })
  quotaStrikes.set(key, { hits: [], burst: [], lastAt: 0, level })
  quotaWarmup.delete(key)
  recordProviderLock(provider, model, lock, now)
  schedulePersist()
  logQuotaLock(provider, model, lock)
  return lock
}

function snapshotQuota() {
  const list = []
  const now = Date.now()
  const cutoff = now - QUOTA_WINDOW_5H_MS
  // 先按 提供商 + Key 尾号 + 模型 聚合最近 5 小时的真实调用结果（日志从新到旧）
  const stats = new Map()
  const discoveredModels = new Map()
  for (const log of logs) {
    const at = new Date(log.at).getTime()
    if (Number.isNaN(at)) continue
    // 日志按时间从新到旧排列，遇到超过 5 小时的记录即可停止扫描
    if (at < cutoff) break
    if (!log.keyTail) continue
    const providerName = log.provider || ''
    const statKey = `${providerName}::${log.keyTail}::${log.model || ''}`
    const row = stats.get(statKey) || {
      calls: 0,
      success: 0,
      rateLimited: 0,
      lastStatus: 0,
      lastAt: '',
    }
    row.calls += 1
    if (!log.error && log.status >= 200 && log.status < 400) row.success += 1
    if (log.status === 429) row.rateLimited += 1
    if (!row.lastAt) {
      row.lastAt = log.at
      row.lastStatus = log.status || 0
    }
    stats.set(statKey, row)
    if (log.model) {
      const id = `${providerName}::${log.keyTail}`
      if (!discoveredModels.has(id)) discoveredModels.set(id, new Set())
      discoveredModels.get(id).add(log.model)
    }
  }

  for (const provider of config.providers || []) {
    if (!provider.quota?.enabled) continue
    const keys = apiKeysOf(provider)
    const entries = keys.length > 0 ? keys : ['']
    const configuredModels = [
      ...new Set([...(provider.models || []), ...Object.values(provider.modelAliases || {})]),
    ]
    for (const key of entries) {
      const tail = keyTailOf(key)
      const providerName = provider.name || provider.id
      const models =
        configuredModels.length > 0
          ? configuredModels
          : [...(discoveredModels.get(`${providerName}::${tail}`) || [])]
      const modelEntries = models.length > 0 ? models : ['']
      for (const model of modelEntries) {
        const candidate = { ...provider, apiKey: key }
        const scope = model || undefined
        const blocked = quotaBlocked(candidate, scope)
        const warmup = quotaWarmup.get(quotaPoolKeyOf(candidate, scope))
        let stat = stats.get(`${providerName}::${tail}::${model}`)
        // 未配置模型时展示该 Key 的真实汇总
        if (!stat && !model) {
          stat = { calls: 0, success: 0, rateLimited: 0, lastStatus: 0, lastAt: '' }
          for (const [id, value] of stats) {
            if (!id.startsWith(`${providerName}::${tail}::`)) continue
            stat.calls += value.calls
            stat.success += value.success
            stat.rateLimited += value.rateLimited
            if (!stat.lastAt && value.lastAt) {
              stat.lastAt = value.lastAt
              stat.lastStatus = value.lastStatus
            }
          }
        }
        const state = blocked ? blocked.window : warmup ? 'warmup' : 'ok'
        list.push({
          // 只暴露 Key 尾号，避免把完整 Key 传到渲染进程
          id: `${providerKeyOf(provider)}#${tail}${model ? `#${model}` : ''}`,
          providerId: providerKeyOf(provider),
          name: providerName,
          keyTail: tail,
          model: model || '',
          group: quotaGroupOf(candidate),
          keyGroup: quotaGroupOf(candidate),
          state,
          exhausted: Boolean(blocked),
          locked: Boolean(blocked?.locked),
          window: blocked?.window || '',
          retryAfter: blocked?.retryAfter || 0,
          weight: Math.round(quotaWeightOf(candidate, scope) * 100) / 100,
          warmup: warmup ? (warmup.probing ? 'probing' : 'ramping') : '',
          calls5h: stat?.calls || 0,
          success5h: stat?.success || 0,
          rateLimited5h: stat?.rateLimited || 0,
          lastStatus: stat?.lastStatus || 0,
          lastAt: stat?.lastAt || '',
        })
      }
    }
  }
  return list
}

// ---------- 每 Key 额度自动探测 ----------
// 官方没有余额查询 API（余额只在网页控制台可见），额度状态只能用真实调用推断：
// 对每把 Key 周期性发一次最小化 /chat/completions（max_tokens=1），结果与真实流量
// 走同一套记账——成功立即恢复锁定，429 走连续确认，401/403 标记 Key 无效。
// 探测本身是真实调用，会消耗少量积分/额度；默认间隔 30 分钟，可按提供商关闭。
const PROBE_FIRST_DELAY_MS = 15000
const DEFAULT_PROBE_INTERVAL_MINUTES = 30

const probeStateByProvider = new Map() // providerKey -> Map(明文 Key -> 探测状态)
const probeTimers = new Map() // providerKey -> 定时器句柄
const probeNextRunAt = new Map() // providerKey -> 下轮计划时间戳
const probeRunningProviders = new Set() // 正在跑一轮探测的提供商，防重入

function normalizeAutoProbe(input) {
  const probe = input && typeof input === 'object' ? input : {}
  const intervalRaw = Number(probe.intervalMinutes)
  return {
    enabled: probe.enabled === true,
    intervalMinutes:
      intervalRaw > 0
        ? Math.min(720, Math.max(1, Math.floor(intervalRaw)))
        : DEFAULT_PROBE_INTERVAL_MINUTES,
    model: typeof probe.model === 'string' ? probe.model.trim() : '',
  }
}

// 探测模型：显式配置优先；否则取提供商模型列表第一个可用的
function probeModelOf(provider) {
  const configured =
    typeof provider?.autoProbe?.model === 'string' ? provider.autoProbe.model.trim() : ''
  if (configured) return configured
  const models = Array.isArray(provider?.models) ? provider.models : []
  return models.find((model) => typeof model === 'string' && model.trim()) || ''
}

function probeStatesOf(providerKey) {
  if (!probeStateByProvider.has(providerKey)) probeStateByProvider.set(providerKey, new Map())
  return probeStateByProvider.get(providerKey)
}

function recordProbeResult(provider, key, result) {
  const states = probeStatesOf(providerKeyOf(provider))
  const previous = states.get(key) || {}
  states.set(key, {
    key,
    keyTail: keyTailOf(key),
    lastProbeAt: new Date().toISOString(),
    latencyMs: Math.max(0, Math.round(Number(result.latencyMs) || 0)),
    result: result.result,
    status: Number(result.status) || 0,
    message: result.message || '',
    // 401/403：记录首次失效时间；恢复成功即清除
    invalidSince:
      result.result === 'invalid' ? previous.invalidSince || new Date().toISOString() : '',
  })
}

// 探测请求：与真实转发相同的 Bearer 鉴权与最小化请求体；不 reject，用 status 表达结果
function probeKeyRequest({ baseUrl, apiKey, model }, timeout = 15000) {
  return new Promise((resolve) => {
    // 连接超时、响应中断、对端重置都可能先后触发多个事件，只接受第一个结果
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let target
    try {
      target = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions')
    } catch {
      finish({ status: 0, retryAfterMs: 0, text: '', latencyMs: 0, message: 'Base URL 无效' })
      return
    }

    const transport = target.protocol === 'https:' ? https : http
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const body = JSON.stringify({
      model: String(model),
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 1,
    })

    const startedAt = Date.now()
    const interrupted = (error) => ({
      status: 0,
      retryAfterMs: 0,
      text: '',
      latencyMs: Date.now() - startedAt,
      message: error?.message || '响应中断',
    })
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        // 响应流必须有 error 监听：否则连接中途断开时 Promise 永远不 settle，
        // 该提供商会一直被标记为「探测进行中」，自动探测停摆
        response.on('error', (error) => finish(interrupted(error)))
        response.on('aborted', () => finish(interrupted()))
        response.on('end', () => {
          finish({
            status: response.statusCode || 0,
            retryAfterMs: parseRetryAfterMs(response.headers['retry-after']),
            text: Buffer.concat(chunks).toString('utf8'),
            latencyMs: Date.now() - startedAt,
            message: '',
          })
        })
      },
    )

    request.on('timeout', () => request.destroy(new Error('探测请求超时')))
    request.on('error', (error) => finish(interrupted(error)))
    request.end(body)
  })
}

// 单把 Key 探测：走 acquireSlot 遵守并发 / RPM，结果并入真实流量的记账
async function probeSingleKey(provider, key, model) {
  const candidate = { ...provider, apiKey: key }
  // 只读检查锁定状态：锁定到期会在此转入半开探测期，后续真实 429 直接升级等级
  quotaBlocked(candidate, model)
  let release
  try {
    release = await acquireSlot(candidate, false, model)
  } catch (error) {
    // 等不到并发槽位：本轮跳过该 Key，不算探测失败，也不覆盖上一次结果
    return { result: 'skipped', status: 0, latencyMs: 0, message: error?.message || '并发排队超时' }
  }
  try {
    const response = await probeKeyRequest({ baseUrl: candidate.baseUrl, apiKey: key, model })
    const status = Number(response.status) || 0
    let result = 'error'
    if (status >= 200 && status < 400) result = 'ok'
    else if (status === 401 || status === 403) result = 'invalid'
    else if (status === 429) result = 'rate_limited'

    // 与真实流量同一套记账：成功恢复锁定，401/403/429/5xx 进入冷却
    if (result === 'ok') {
      markSuccess(candidate, model)
    } else if (status === 401 || status === 403 || status === 429 || status >= 500) {
      markFailure(
        candidate,
        status === 429
          ? Math.max(isDuanyan(provider) ? DUANYAN_RATE_RETRY_MS : 5000, response.retryAfterMs)
          : 0,
      )
    }
    if (status === 429) {
      noteQuotaHit(candidate, model, {
        retryAfterMs: response.retryAfterMs,
        signal: parse429Signal(response.text),
      })
    }

    // 探测也是一次真实上游调用：进调用日志（带 probe 标记），额度观察与用量随之累计
    const probeUsage = extractUsage([Buffer.from(response.text || '')], 'application/json')
    const probeMetrics = computeUsageMetrics({
      startedAt: Date.now() - (Number(response.latencyMs) || 0),
      firstTokenAt: null,
      endedAt: Date.now(),
      usage: probeUsage,
    })
    pushLog({
      at: new Date().toISOString(),
      model,
      provider: provider.name || provider.id,
      providerId: provider.id,
      client: '额度探测',
      status,
      ms: response.latencyMs,
      stream: false,
      attempt: 1,
      path: '/chat/completions',
      error: status >= 400 ? `HTTP ${status}` : null,
      requestId: newRequestId(),
      keyTail: keyTailOf(key),
      failover: false,
      probe: true,
      usage: probeUsage,
      ttftMs: probeMetrics.ttftMs,
      tps: probeMetrics.tps,
      reasoningTokens: probeMetrics.reasoningTokens,
      usageMissing: probeMetrics.usageMissing,
    })
    return {
      result,
      status,
      latencyMs: response.latencyMs,
      message:
        status >= 400 ? `HTTP ${status}${response.message ? `：${response.message}` : ''}` : '',
    }
  } finally {
    release()
  }
}

// 对一个提供商跑一轮探测：串行逐 Key，天然遵守 RPM；跑完返回概要
async function runProbeRound(provider, trigger = 'auto') {
  const providerKey = providerKeyOf(provider)
  if (probeRunningProviders.has(providerKey)) return { ok: false, reason: 'already_running' }
  const keys = apiKeysOf(provider)
  const model = probeModelOf(provider)
  if (keys.length === 0) return { ok: false, reason: 'no_keys' }
  if (!model) return { ok: false, reason: 'no_model' }
  probeRunningProviders.add(providerKey)
  if (trigger === 'manual') {
    pushDiagnostic(
      'info',
      '额度探测',
      '手动触发 Key 额度探测',
      `上游 ${provider.name || providerKey} · Key ${keys.length} 把 · 探测模型 ${model}`,
    )
  }
  try {
    for (const key of keys) {
      const result = await probeSingleKey(provider, key, model)
      if (result.result !== 'skipped') recordProbeResult(provider, key, result)
    }
  } finally {
    probeRunningProviders.delete(providerKey)
  }
  return { ok: true, keys: keys.length, model }
}

function clearProbeTimer(providerKey) {
  const timer = probeTimers.get(providerKey)
  if (timer) {
    clearTimeout(timer)
    probeTimers.delete(providerKey)
    probeNextRunAt.delete(providerKey)
  }
}

async function runScheduledRound(providerKey) {
  probeTimers.delete(providerKey)
  const provider = (config.providers || []).find((item) => providerKeyOf(item) === providerKey)
  const probe = provider?.autoProbe
  if (!provider || provider.enabled === false || probe?.enabled !== true) {
    probeNextRunAt.delete(providerKey)
    return
  }
  await runProbeRound(provider, 'auto')
  // 一轮跑完再排下一轮，间隔从本轮结束起算，避免与上一轮重叠；
  // 间隔取跑完后的最新配置，防止轮次期间的配置变更被旧值覆盖
  const latest = (config.providers || []).find((item) => providerKeyOf(item) === providerKey)
  const latestProbe = latest?.autoProbe
  if (!latest || latest.enabled === false || latestProbe?.enabled !== true) {
    probeNextRunAt.delete(providerKey)
    return
  }
  scheduleNextProbe(providerKey, (Number(latestProbe.intervalMinutes) || 0) * 60 * 1000)
}

function scheduleNextProbe(providerKey, delayMs) {
  clearProbeTimer(providerKey)
  const delay = Math.max(1000, Number(delayMs) || 0)
  const timer = setTimeout(() => {
    void runScheduledRound(providerKey)
  }, delay)
  if (typeof timer.unref === 'function') timer.unref()
  probeTimers.set(providerKey, timer)
  probeNextRunAt.set(providerKey, Date.now() + delay)
}

// 按当前配置全量重排自动探测；网关未运行时不自动探测（手动探测不受限）
function rescheduleProbes() {
  for (const providerKey of [...probeTimers.keys()]) clearProbeTimer(providerKey)
  probeNextRunAt.clear()
  if (!server) return
  for (const provider of config.providers || []) {
    if (provider.enabled === false) continue
    if (provider?.autoProbe?.enabled !== true) continue
    if (apiKeysOf(provider).length === 0) continue
    scheduleNextProbe(providerKeyOf(provider), PROBE_FIRST_DELAY_MS)
  }
}

// 手动触发：立即对全部（或指定）提供商探测一轮；结果写入快照供 UI 读取
async function probeAllKeys(providerId = '') {
  const providers = (config.providers || []).filter((provider) => {
    if (providerId && providerKeyOf(provider) !== String(providerId)) return false
    return true
  })
  const results = []
  for (const provider of providers) {
    // 停用的提供商不探测，但要回一句明确原因，避免 UI 把「什么都没做」当成成功
    if (provider.enabled === false) {
      results.push({
        providerId: providerKeyOf(provider),
        name: provider.name || provider.id,
        ok: false,
        reason: 'disabled',
        keys: 0,
        model: '',
      })
      continue
    }
    const round = await runProbeRound(provider, 'manual')
    results.push({
      providerId: providerKeyOf(provider),
      name: provider.name || provider.id,
      ok: round?.ok === true,
      reason: round?.reason || '',
      keys: round?.keys || 0,
      model: round?.model || probeModelOf(provider),
    })
  }
  return { ok: true, results, snapshot: snapshotKeyProbe() }
}

// 每 Key 探测状态快照：探测结果 + 当前额度锁定合并视图；独立于 quota.enabled
function snapshotKeyProbe() {
  const list = []
  for (const provider of config.providers || []) {
    const providerKey = providerKeyOf(provider)
    const keys = apiKeysOf(provider)
    const states = probeStateByProvider.get(providerKey)
    if (keys.length === 0 && (!states || states.size === 0)) continue
    const probe = normalizeAutoProbe(provider?.autoProbe)
    const model = probeModelOf(provider)
    const rows = keys.map((key) => {
      const state = states?.get(key) || null
      const candidate = { ...provider, apiKey: key }
      const blocked = quotaBlocked(candidate, model)
      return {
        keyTail: keyTailOf(key),
        result: state?.result || '',
        status: state?.status || 0,
        latencyMs: state?.latencyMs || 0,
        lastProbeAt: state?.lastProbeAt || '',
        message: state?.message || '',
        invalidSince: state?.invalidSince || '',
        locked: Boolean(blocked?.locked),
        lockWindow: blocked?.window || '',
        lockRetryAfter: blocked?.retryAfter || 0,
      }
    })
    list.push({
      providerId: providerKey,
      name: provider.name || provider.id,
      probeEnabled: probe.enabled,
      intervalMinutes: probe.intervalMinutes,
      probeModel: model,
      nextProbeAt: probeNextRunAt.get(providerKey) || 0,
      probing: probeRunningProviders.has(providerKey),
      keys: rows,
    })
  }
  return list
}

// ---------- 冷却 / 熔断 ----------
const cooldownByKey = new Map()
const COOLDOWN_BASE_MS = 5000
const COOLDOWN_MAX_MS = 60000

function cooldownKeyOf(provider) {
  return `${provider?.id || provider?.name || provider?.baseUrl || 'unknown'}::${keyIdOf(provider?.apiKey)}`
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
  if (model === undefined) return
  markQuotaWarmupSuccess(provider, model)
  // 真实请求已经成功：额度锁定立即失效，等级与确认点清零。
  // 下次再遇到 429 重新从探测开始，而不是沿用之前的 5h / 7d 等级。
  const poolKey = quotaPoolKeyOf(provider, model)
  const remembered = quotaLevels.get(poolKey)
  const hadState = Boolean(quotaLocks.get(poolKey) || remembered)
  quotaLocks.delete(poolKey)
  quotaLevels.delete(poolKey)
  quotaStrikes.delete(poolKey)
  if (hadState) {
    const name = provider?.name || provider?.id || provider?.baseUrl || '未知上游'
    const tail = keyTailOf(provider?.apiKey)
    recordProviderRecovery(provider, model, remembered?.level, remembered?.at)
    pushDiagnostic(
      'info',
      '额度',
      '真实请求成功，额度保护状态已解除',
      `上游 ${name} · 模型 ${model || '默认'}${tail ? ` · Key …${tail}` : ''} · 原等级 ${quotaLockLabel(
        remembered?.level,
      )}`,
    )
  }
}

// Retry-After 支持秒数与 HTTP-date；解析失败返回 0（回退到本地指数退避）。
// 最大采信 24 小时，避免异常大值让冷却状态停留在不可预期的时间。
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(String(value))
  return Number.isNaN(at) ? 0 : Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS)
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
  // 真实 429 已确认锁定：不再打上游，交给上层换下一个提供商
  const blocked = quotaBlocked(provider, context.model)
  if (blocked) {
    const label =
      blocked.window === 'week' ? '7 天' : blocked.window === '5h' ? '5 小时' : '5 分钟探测'
    throw Object.assign(new Error(`额度已用尽（${label}窗口）`), {
      code: 'quota_exceeded',
      status: 429,
      retryAfter: blocked.retryAfter,
      providerName: provider.name || provider.id,
    })
  }

  // 限流/并发检查：超限直接抛 rate_limited，由上层决定是否换上游。
  // 端砚的 RPM 窗口按提供商共享（官方按用户计），Key 级只隔离并发
  const release = await acquireSlot(provider, context.streaming === true, context.model)

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

        // Anthropic 适配：上游按 OpenAI 协议返回，这里转换回 Anthropic 格式再写给客户端。
        // 仅处理 2xx；错误响应仍走下方原样透传路径。与 OpenAI 透传完全隔离，避免回归。
        if (context.adapter && status < 400) {
          const adapter = context.adapter
          const upstreamType = String(upstreamRes.headers['content-type'] || '')
          const upstreamIsStream = upstreamType.includes('event-stream')
          res.writeHead(status, {
            'Content-Type': adapter.streaming ? 'text/event-stream' : 'application/json',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'x-relay-provider': encodeURIComponent(provider.name || provider.id || ''),
          })
          const transform =
            adapter.streaming && upstreamIsStream
              ? createAnthropicSseTransform(adapter.model)
              : null
          // 流式解码必须按字节流缓冲：多字节 UTF-8 字符跨 chunk 边界时，
          // chunk.toString('utf8') 会把半个字符变成 U+FFFD，StringDecoder 会等到收齐再输出
          const decoder = transform ? new StringDecoder('utf8') : null
          const chunks = []
          let captured = 0
          let firstTokenAt = 0
          upstreamRes.on('data', (chunk) => {
            if (upstreamIsStream && !firstTokenAt) firstTokenAt = Date.now()
            chunks.push(chunk)
            captured += chunk.length
            if (transform) {
              // 流式响应只保留尾部一段用于解析 usage，避免长流把整段响应堆在内存里
              while (captured > MAX_CAPTURE_BYTES && chunks.length > 1) {
                captured -= chunks.shift().length
              }
              const out = transform.push(decoder.write(chunk))
              if (out) res.write(out)
            }
          })
          upstreamRes.on('end', () => {
            if (settled) return
            settled = true
            res.off('close', abortByClient)
            release()
            if (transform) {
              const tailText = decoder.end()
              if (tailText) {
                const tailOut = transform.push(tailText)
                if (tailOut) res.write(tailOut)
              }
              const tail = transform.end()
              if (tail) res.write(tail)
            } else {
              const text = Buffer.concat(chunks).toString('utf8')
              let json
              try {
                json = JSON.parse(text)
              } catch {
                // 上游忽略 stream:false 仍返回 SSE：聚合为单条消息
                json = aggregateOpenAIStream(text)
              }
              res.write(JSON.stringify(openAIToAnthropic(json, adapter.model)))
            }
            res.end()
            const elapsed = Date.now() - startedAt
            const usage = extractUsage(chunks, upstreamType)
            const metrics = computeUsageMetrics({
              startedAt,
              firstTokenAt: upstreamIsStream && firstTokenAt ? firstTokenAt : null,
              endedAt: Date.now(),
              usage,
            })
            pushLog({
              at: new Date().toISOString(),
              model: context.model,
              provider: provider.name || provider.id,
              providerId: provider.id,
              client: context.client || '',
              status,
              ms: elapsed,
              stream: upstreamIsStream,
              attempt: context.attempt,
              path: context.path,
              error: null,
              requestId: context.requestId,
              keyTail: keyTailOf(provider.apiKey),
              failover: context.attempt > 1,
              usage,
              ttftMs: metrics.ttftMs,
              tps: metrics.tps,
              reasoningTokens: metrics.reasoningTokens,
              usageMissing: metrics.usageMissing,
              routedBy: context.routedBy || '',
            })
            recordStat({ provider, model: context.model, status, ms: elapsed, usage, metrics })
            markSuccess(provider, context.model)
            resolve({ status, provider })
          })
          upstreamRes.on('error', (error) => {
            if (settled) return
            settled = true
            res.off('close', abortByClient)
            release()
            if (!res.writableEnded) res.end()
            reject(error)
          })
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
        const isStream = contentType.includes('event-stream')
        const chunks = []
        let captured = 0
        let truncated = false
        // 首 token 时间：只有流式响应才有真实 TTFT，非流式首块即完整响应
        let firstTokenAt = 0
        upstreamRes.on('data', (chunk) => {
          if (truncated) return
          if (isStream && !firstTokenAt) firstTokenAt = Date.now()
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
          const metrics = computeUsageMetrics({
            startedAt,
            firstTokenAt: isStream && firstTokenAt ? firstTokenAt : null,
            endedAt: Date.now(),
            usage,
          })
          const attemptLog = pushLog({
            at: new Date().toISOString(),
            model: context.model,
            provider: provider.name || provider.id,
            providerId: provider.id,
            client: context.client || '',
            status,
            ms: elapsed,
            stream: isStream,
            attempt: context.attempt,
            path: context.path,
            error: status >= 400 ? `HTTP ${status}` : null,
            requestId: context.requestId,
            keyTail: keyTailOf(provider.apiKey),
            failover: context.attempt > 1,
            usage,
            ttftMs: metrics.ttftMs,
            tps: metrics.tps,
            reasoningTokens: metrics.reasoningTokens,
            usageMissing: metrics.usageMissing,
            routedBy: context.routedBy || '',
          })
          recordStat({
            provider,
            model: context.model,
            status,
            ms: elapsed,
            usage,
            metrics,
          })
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
              // 一次上游尝试只保留一条日志：把额度锁定信息合并进尝试日志，
              // 避免调用监控把同一次尝试重复计次、延迟翻倍并误判为故障转移
              attemptLog.quota = true
              attemptLog.error = `429 确认真实额度耗尽，该 Key 进入 ${quotaLockLabel(lock.level)}锁定`
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

  return result
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
    const wait = waits.length > 0 ? Math.min(...waits) : 1
    pushDiagnostic(
      'warn',
      '冷却',
      '所有上游都在冷却中，请求已拒绝',
      `模型 ${context.model || '未知'} · 路径 ${context.path} · 冷却上游 ${providers.length} 个 · ${wait} 秒后可重试`,
    )
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
          providerId: provider.id,
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
      // 统一失败分类：request/account/provider/transient，决定是否切 Key / 切上游
      const failure = classifyFailure({
        status: error.status || 0,
        code: error.code === 'rate_limited' ? '' : error.code || '',
        message: error.message || '',
        body: error.signal === 'quota' ? { error: { code: 'quota_exhausted' } } : null,
        headers: error.retryAfterMs ? { 'retry-after': String(error.retryAfterMs / 1000) } : {},
        timeout: error.code === 'upstream_timeout',
        aborted: false,
      })
      // 额度用尽：只跳过这一把 Key，继续尝试同提供商的其它 Key 和下一个提供商
      if (error.code === 'quota_exceeded') {
        quotaSkipped.push(keyTailOf(provider.apiKey))
        if (res.headersSent) return
        continue
      }
      // request 类错误（400/404/422 等参数问题）：不切 Key、不切上游，原样透传给客户端
      if (failure.class === FAILURE_CLASSES.REQUEST && error.status) {
        pushLog({
          at: new Date().toISOString(),
          model: context.model,
          provider: provider.name || provider.id,
          providerId: provider.id,
          client: context.client || '',
          status: error.status,
          ms: Date.now() - attemptStarted,
          stream: false,
          attempt: index + 1,
          path: context.path,
          error: error.message,
          requestId: context.requestId,
          keyTail: keyTailOf(provider.apiKey),
          failover: index > 0,
          usage: null,
          routedBy: context.routedBy || '',
          failureClass: failure.class,
        })
        recordStat({
          provider,
          model: context.model,
          status: error.status,
          ms: Date.now() - attemptStarted,
          error,
        })
        if (res.headersSent) return
        // 透传上游错误体由 attempt 已写出（headersSent 时不会到这里）；
        // 未写出时返回 502 保持旧行为，但日志标注 request 类
        openaiError(res, 502, `所有上游均失败：${error.message}`, 'upstream_error')
        return
      }
      // 429 累积判定：多次、有间隔的 429 才认定额度窗口用尽
      const quotaLock =
        error.status === 429
          ? noteQuotaHit(provider, context.model, {
              retryAfterMs: error.retryAfterMs,
              signal: error.signal,
            })
          : null
      // 本地限流（并发 / RPM / 排队超时）最终也返回 429，日志按 429 记录，
      // 否则调用监控会把它显示成「失败 / ERR」，与客户端实际收到的状态不一致
      const logStatus = error.status || (error.code === 'rate_limited' ? 429 : 0)
      pushLog({
        at: new Date().toISOString(),
        model: context.model,
        provider: provider.name || provider.id,
        providerId: provider.id,
        client: context.client || '',
        status: logStatus,
        ms: Date.now() - attemptStarted,
        stream: false,
        attempt: index + 1,
        path: context.path,
        error: quotaLock
          ? `429 确认真实额度耗尽，该 Key 进入 ${quotaLockLabel(quotaLock.level)}锁定`
          : error.message,
        requestId: context.requestId,
        keyTail: keyTailOf(provider.apiKey),
        failover: index > 0,
        usage: null,
        routedBy: context.routedBy || '',
        quota: Boolean(quotaLock),
        failureClass: failure.class,
      })
      recordStat({
        provider,
        model: context.model,
        status: logStatus,
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
    pushDiagnostic(
      'warn',
      '限流',
      '所有上游都被本地限流，请求已排队失败',
      `模型 ${context.model || '未知'} · 路径 ${context.path} · ${lastError.message || '并发或 RPM 已达上限'}`,
    )
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
    pushDiagnostic(
      'warn',
      '额度',
      '所有上游 Key 的额度都已用尽',
      `模型 ${context.model || '未知'} · 跳过 ${skipped} 个 Key${
        skipped ? `（…${quotaSkipped.join('、…')}）` : ''
      } · ${lastError.message || ''}`.trim(),
    )
    pushLog({
      at: new Date().toISOString(),
      model: context.model,
      provider: lastError.providerName || '额度',
      client: context.client || '',
      status: 429,
      ms: 0,
      stream: false,
      summary: true,
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
  pushDiagnostic(
    'error',
    '上游',
    '所有上游均失败，请求返回 502',
    `模型 ${context.model || '未知'} · 路径 ${context.path} · ${lastError?.message || '未知错误'}`,
  )
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

  // 路由（含模型别名与默认路由兜底）
  const route = resolveRoute(model, payload)
  if (route.error) {
    pushDiagnostic(
      route.status === 503 ? 'warn' : 'error',
      '路由',
      route.status === 503 ? '默认上游不可用' : '模型没有可用的上游提供商',
      `模型 «${model}» · 路径 ${upstreamPath} · 已启用上游 ${enabledProviders().length} 个 · ${route.error}`,
    )
    openaiError(res, route.status, route.error, route.type)
    return
  }
  const providers = route.candidates
  const routedBy = route.routedBy

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
    routedBy,
    cacheKey,
    cacheTtlMs: config.cache?.ttlMs || 300000,
    cacheMaxEntries: config.cache?.maxEntries || 200,
    // 日志里记录请求路径，统计页据此区分 chat / embeddings 的缓存命中率
    path: upstreamPath,
  })
}

// Anthropic /v1/messages：转换为 OpenAI 请求复用同一套路由 / 故障转移，响应再转回 Anthropic。
async function handleAnthropicMessages(req, res, client = '') {
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
  const streaming = payload?.stream === true
  const stickyKey = stickyKeyOf(req, payload)

  const route = resolveRoute(model, payload)
  if (route.error) {
    pushDiagnostic(
      route.status === 503 ? 'warn' : 'error',
      '路由',
      route.status === 503 ? '默认上游不可用' : '模型没有可用的上游提供商',
      `模型 «${model}» · 路径 /v1/messages · ${route.error}`,
    )
    openaiError(res, route.status, route.error, route.type)
    return
  }

  // 每个候选按（可能别名映射后的）模型生成 OpenAI 请求体
  const providers = route.candidates.map((item) => ({
    ...item,
    forwardBody: JSON.stringify(
      anthropicToOpenAI({ ...payload, model: item.forwardModel || model }),
    ),
  }))

  await forwardWithFailover(
    providers,
    '/chat/completions',
    JSON.stringify(anthropicToOpenAI(payload)),
    res,
    {
      model,
      requestId,
      client,
      stickyKey,
      streaming,
      routedBy: route.routedBy,
      path: '/v1/messages',
      adapter: { kind: 'anthropic', model, streaming },
    },
  )
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
    // 局域网内被扫描时每个请求都会走到这里，诊断只按分钟记一条，避免刷满保留区
    const now = Date.now()
    if (now - lastAuthDeniedDiagAt >= AUTH_DENIED_DIAG_INTERVAL_MS) {
      lastAuthDeniedDiagAt = now
      pushDiagnostic(
        'warn',
        '鉴权',
        '客户端访问 Key 无效，请求被拒绝',
        `路径 ${path} · 来源 ${req.socket?.remoteAddress || '本机'}`,
      )
    }
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

  if (req.method === 'POST' && (path === '/v1/messages' || path === '/messages')) {
    await handleAnthropicMessages(req, res, client.label)
    return
  }

  // /v1/responses 是可选能力，本增量未启用：返回明确 501，而不是静默 404
  if (req.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
    openaiError(res, 501, '本地中转站暂未启用 /v1/responses（可选能力）。', 'not_implemented')
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

// 局域网访问默认关闭；开启时复用访问 Key（apiKey / clientKeys）做鉴权
function normalizeLan(input) {
  return { enabled: input?.enabled === true }
}

function hasAccessKey() {
  return Boolean(config.apiKey) || config.clientKeys.length > 0
}

function start(nextConfig = {}) {
  // 允许显式传 0：让系统分配端口（冒烟/端口冲突时用）
  const requestedPort = nextConfig.port === 0 ? 0 : Number(nextConfig.port) || DEFAULT_PORT
  const lan = normalizeLan(nextConfig.lan)
  config = {
    port: requestedPort,
    providers: (Array.isArray(nextConfig.providers) ? nextConfig.providers : []).map(
      (provider) => ({
        ...provider,
        quota: normalizeQuota(provider?.quota),
        autoProbe: normalizeAutoProbe(provider?.autoProbe),
      }),
    ),
    apiKey: typeof nextConfig.apiKey === 'string' ? nextConfig.apiKey.trim() : '',
    clientKeys: normalizeClientKeys(nextConfig.clientKeys),
    sticky: nextConfig.sticky === true,
    cache: normalizeCache(nextConfig.cache),
    defaultProviderId:
      typeof nextConfig.defaultProviderId === 'string' ? nextConfig.defaultProviderId.trim() : '',
    lan,
    listenHost: lan.enabled ? '0.0.0.0' : HOST,
  }
  // 开启局域网访问必须先设置访问 Key，否则拒绝启动，避免无鉴权暴露到局域网
  if (config.lan.enabled && !hasAccessKey()) {
    return Promise.reject(
      Object.assign(new Error('开启局域网访问必须先设置访问 Key（默认 Key 或客户端 Key）。'), {
        code: 'LAN_KEY_REQUIRED',
      }),
    )
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
        const classified = classifyListenError(error, config.port)
        error.listenError = classified
        pushDiagnostic(
          'error',
          '启动',
          '中转站启动失败',
          `端口 ${config.port} · ${classified.message}`,
        )
        reject(error)
      })

      instance.listen(config.port, config.listenHost, () => {
        server = instance
        // 允许传 0 让系统分配端口（测试与端口冲突时有用）
        const actualPort = instance.address()?.port ?? config.port
        config.port = actualPort
        // 网关就绪后按配置启动自动探测（启动后 15 秒首轮，之后按各自间隔）
        rescheduleProbes()
        pushDiagnostic(
          'info',
          '启动',
          '中转站已启动',
          `监听 http://${config.listenHost}:${actualPort}/v1 · 上游 ${enabledProviders().length} 个 · 模型 ${listModels().length} 个${
            config.lan.enabled ? ' · 局域网访问已开启' : ''
          }`,
        )
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
  // 网关停止：自动探测一并停排；手动探测仍可用
  for (const providerKey of [...probeTimers.keys()]) clearProbeTimer(providerKey)
  pushDiagnostic('info', '停止', '中转站已停止', `端口 ${config.port} · 已中断进行中的上游请求`)

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
      autoProbe: normalizeAutoProbe(provider?.autoProbe),
    }))
    // Key 组合可能变化：清空调度累计权重，避免旧 Key 的权重残留
    quotaSwrr.clear()
    // 探测开关 / 间隔 / Key 列表可能变化：全量重排自动探测
    rescheduleProbes()
  }
  if (typeof nextConfig.apiKey === 'string') config.apiKey = nextConfig.apiKey.trim()
  if (Array.isArray(nextConfig.clientKeys)) {
    config.clientKeys = normalizeClientKeys(nextConfig.clientKeys)
  }
  if (typeof nextConfig.sticky === 'boolean') config.sticky = nextConfig.sticky
  if (typeof nextConfig.defaultProviderId === 'string') {
    config.defaultProviderId = nextConfig.defaultProviderId.trim()
  }
  if (nextConfig.lan && typeof nextConfig.lan === 'object') {
    config.lan = normalizeLan(nextConfig.lan)
    // 监听地址与端口一样，运行中不能热切换：提示需重启生效
    const desiredHost = config.lan.enabled ? '0.0.0.0' : HOST
    if (server && desiredHost !== config.listenHost) {
      pushDiagnostic('info', '配置', '局域网访问设置已更新', '需停止并重新启动中转站后生效。')
    }
  }
  if (nextConfig.cache && typeof nextConfig.cache === 'object') {
    config.cache = normalizeCache(nextConfig.cache)
    if (!config.cache.enabled) cacheEntries.clear()
  }
  pushDiagnostic(
    'info',
    '配置',
    '运行配置已更新',
    `上游 ${enabledProviders().length} 个 · 模型 ${listModels().length} 个 · 访问 Key ${
      config.apiKey ? '已设置' : '未设置'
    } · 会话粘性 ${config.sticky ? '开' : '关'} · 缓存 ${
      config.cache?.enabled ? `开（${Math.round(config.cache.ttlMs / 60000)} 分钟）` : '关'
    }`,
  )
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
    defaultProviderId: config.defaultProviderId || '',
    listenHost: config.listenHost || HOST,
    lan: {
      enabled: config.lan?.enabled === true,
      active: Boolean(server) && config.listenHost !== HOST,
      addresses: listLanAddresses(),
    },
    cache: { enabled: config.cache?.enabled === true, entries: cacheEntries.size },
    cooling: snapshotCooling(),
    quota: snapshotQuota(),
    keyProbe: snapshotKeyProbe(),
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

// 指定模型的测通：发一次最小化 /chat/completions（max_tokens 1），
// HTTP 2xx 即视为「该 Key 能调通该模型」，不要求响应体里有什么内容
function probeModelWithKey({ baseUrl, apiKey, model }, timeout = 15000) {
  return new Promise((resolve, reject) => {
    // 与 probeKeyRequest 同理：只接受第一个结果，避免响应流中断后 Promise 悬挂
    let settled = false
    const finishOk = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const finishError = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    let target
    try {
      target = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions')
    } catch {
      finishError(new Error('Base URL 无效'))
      return
    }

    const transport = target.protocol === 'https:' ? https : http
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const body = JSON.stringify({
      model: String(model),
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 1,
    })

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', (error) => finishError(error))
        response.on('aborted', () => finishError(new Error('响应中断')))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((response.statusCode || 500) >= 400) {
            finishError(new Error(`HTTP ${response.statusCode}：${text.slice(0, 200)}`))
            return
          }
          finishOk(text)
        })
      },
    )

    request.on('timeout', () => request.destroy(new Error('请求超时')))
    request.on('error', finishError)
    request.write(body)
    request.end()
  })
}

// 单把 Key 测通：未指定模型时请求一次 /models；指定模型时改发最小化 /chat/completions
async function testKey({ baseUrl, apiKey, model } = {}, timeout = 10000) {
  const startedAt = Date.now()
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  try {
    if (trimmedModel) {
      // 生成比列模型慢，冷启动模型首调可能超过默认 10s，这里放宽到 15s
      await probeModelWithKey({ baseUrl, apiKey, model: trimmedModel }, Math.max(timeout, 15000))
      return { ok: true, model: trimmedModel, ms: Date.now() - startedAt }
    }
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
  pushLog,
  getLogs,
  clearLogs,
  getDiagnostics,
  clearDiagnostics,
  pushDiagnostic,
  getProviderObservations,
  clearProviderObservations,
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
  identifyClient,
  isLoopbackRequest,
  normalizeAutoProbe,
  probeAllKeys,
  snapshotKeyProbe,
  rescheduleProbes,
  stickyKeyOf,
  applySticky,
  acquireSlot,
  normalizeQuota,
  quotaBlocked,
  snapshotQuota,
  resetQuota,
  unlockQuota,
  markSuccess,
  noteQuotaHit,
  quotaLocked,
  strikeConfigOf,
  quotaWeightOf,
  orderedKeysOf,
  parseRetryAfterMs,
  parse429Signal,
  quotaPoolKeyOf,
}
