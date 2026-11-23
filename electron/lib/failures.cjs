// CJS 版失败分类，供 Electron 主进程使用。
// 与 src/core/failures/classify.js 保持同规则，改动时请同步，契约测试会比对。

const FAILURE_CLASSES = {
  REQUEST: 'request',
  ACCOUNT: 'account',
  PROVIDER: 'provider',
  TRANSIENT: 'transient',
}

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

function isQuotaSignal(payload) {
  const text = textOf(payload)
  return QUOTA_SIGNALS.some((signal) => text.includes(signal))
}

// 与 src/core/failures/classify.js 同口径：Retry-After 最大采信 24 小时
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

function parseRetryAfterMs(value) {
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

function classifyFailure(input = {}) {
  const status = Number(input.status) || 0
  const code = String(input.code || '')
  const headers = input.headers || {}
  const retryAfterMs = parseRetryAfterMs(headers['retry-after'] ?? headers['Retry-After'])
  const evidence = { status, code, message: String(input.message || '') }

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
      retryable: false,
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
    return {
      class: FAILURE_CLASSES.REQUEST,
      retryable: false,
      switchKey: false,
      switchProvider: false,
      cooldownMs: 0,
      evidence,
    }
  }

  return {
    class: FAILURE_CLASSES.PROVIDER,
    retryable: true,
    switchKey: false,
    switchProvider: true,
    cooldownMs: 0,
    evidence,
  }
}

module.exports = { FAILURE_CLASSES, classifyFailure, isQuotaSignal, parseRetryAfterMs }
