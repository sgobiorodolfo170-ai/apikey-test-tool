// 失败分类：request / account / provider / transient 四类。
// 与 electron/lib/failures.cjs 保持同规则双实现，契约测试比对一致性。
//
// 分类语义（决定调度行为）：
// - request    请求本身有错（参数/模型名/路径）：不切 Key、不切上游，原样透传
// - account    账号/凭据问题（401/403/额度耗尽）：切同上游下一把 Key
// - provider   上游整体问题（5xx/网络/超时）：切下一个上游
// - transient  瞬时问题（429 限流/408/425）：按 Retry-After 冷却后可重试

export const FAILURE_CLASSES = {
  REQUEST: 'request',
  ACCOUNT: 'account',
  PROVIDER: 'provider',
  TRANSIENT: 'transient',
}

// 429 响应体里表示「额度耗尽」的关键词（OpenAI / 常见中转的 error.code / type / message）
const QUOTA_SIGNALS = [
  'quota_exhausted',
  'insufficient_quota',
  'quota_exceeded',
  'billing',
  'exceeded your current quota',
]

function textOf(value) {
  if (typeof value === 'string') return value.toLowerCase()
  if (value && typeof value === 'object') {
    return Object.values(value)
      .map((item) => textOf(item))
      .join(' ')
  }
  return ''
}

// 从 429 响应体判断是「额度耗尽」还是「瞬时限流」
export function isQuotaSignal(payload) {
  const text = textOf(payload)
  return QUOTA_SIGNALS.some((signal) => text.includes(signal))
}

// Retry-After 最大采信 24 小时：异常值不应让 Key / 上游被冷却到不可预期的时间
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

// 解析 Retry-After（秒或 HTTP 日期），返回毫秒；无法解析返回 0
export function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS)
  }
  const date = new Date(String(value))
  if (!Number.isNaN(date.getTime())) {
    return Math.min(Math.max(0, date.getTime() - Date.now()), MAX_RETRY_AFTER_MS)
  }
  return 0
}

// 网络错误码 → provider 类
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ERR_NETWORK',
  'ERR_CERT',
])

// 主入口：把一次失败归为四类之一。
// input: { status, code, message, body, headers, timeout, aborted }
// 返回 { class, retryable, switchKey, switchProvider, cooldownMs, evidence }
export function classifyFailure(input = {}) {
  const status = Number(input.status) || 0
  const code = String(input.code || '')
  const headers = input.headers || {}
  const retryAfterMs = parseRetryAfterMs(headers['retry-after'] ?? headers['Retry-After'])
  const evidence = { status, code, message: String(input.message || '') }

  // 客户端主动取消：不算失败，不重试
  if (input.aborted || code === 'ERR_CANCELED') {
    return {
      class: FAILURE_CLASSES.REQUEST,
      retryable: false,
      switchKey: false,
      switchProvider: false,
      cooldownMs: 0,
      evidence: { ...evidence, cancelled: true },
    }
  }

  // 超时 / 网络错误：上游整体问题，切上游
  if (input.timeout || NETWORK_CODES.has(code)) {
    return {
      class: FAILURE_CLASSES.PROVIDER,
      retryable: true,
      switchKey: false,
      switchProvider: true,
      cooldownMs: 0,
      evidence,
    }
  }

  if (status === 401 || status === 403) {
    // 凭据问题：切 Key，不重试同一把
    return {
      class: FAILURE_CLASSES.ACCOUNT,
      retryable: false,
      switchKey: true,
      switchProvider: false,
      cooldownMs: 0,
      evidence,
    }
  }

  if (status === 429) {
    // 429 分两种：额度耗尽（account，切 Key/上游）与瞬时限流（transient，冷却重试）
    if (isQuotaSignal(input.body)) {
      return {
        class: FAILURE_CLASSES.ACCOUNT,
        retryable: false,
        switchKey: true,
        switchProvider: true,
        cooldownMs: 0,
        evidence: { ...evidence, quota: true },
      }
    }
    return {
      class: FAILURE_CLASSES.TRANSIENT,
      retryable: false, // 429 不自动重试，按 Retry-After 冷却
      switchKey: true,
      switchProvider: false,
      cooldownMs: retryAfterMs,
      evidence,
    }
  }

  if (status === 408 || status === 425) {
    return {
      class: FAILURE_CLASSES.TRANSIENT,
      retryable: true,
      switchKey: false,
      switchProvider: false,
      cooldownMs: retryAfterMs,
      evidence,
    }
  }

  if (status >= 500) {
    return {
      class: FAILURE_CLASSES.PROVIDER,
      retryable: true,
      switchKey: false,
      switchProvider: true,
      cooldownMs: 0,
      evidence,
    }
  }

  if (status >= 400) {
    // 400/404/422 等请求错误：不切 Key、不切上游，原样透传
    return {
      class: FAILURE_CLASSES.REQUEST,
      retryable: false,
      switchKey: false,
      switchProvider: false,
      cooldownMs: 0,
      evidence,
    }
  }

  // 无状态码且非已知网络错误：按 provider 处理（保守，可切上游）
  return {
    class: FAILURE_CLASSES.PROVIDER,
    retryable: true,
    switchKey: false,
    switchProvider: true,
    cooldownMs: 0,
    evidence,
  }
}
