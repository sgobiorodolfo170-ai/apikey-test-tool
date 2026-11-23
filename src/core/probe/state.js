// 探测状态机：把一次连接 / 模型测试的结果归一到固定状态。
// 原则：5xx 与超时只表示“这次没测到”，不把 Key 判死；只有明确拒绝才降级。

export const PROBE_STATES = Object.freeze([
  'unknown',
  'reachable',
  'rejected',
  'rate_limited',
  'quota_exhausted',
])

export function isProbeState(value) {
  return PROBE_STATES.includes(value)
}

const QUOTA_PATTERN = /quota|insufficient_quota|quota_exhausted|额度|余额/
const RATE_PATTERN = /rate_limit|too_many_requests|限流|rate limited/

function normalizeSignal(input) {
  const signal = String(input?.signal || '').toLowerCase()
  const text = `${input?.errorClass || ''} ${input?.error || ''}`.toLowerCase()
  return {
    quota: signal === 'quota' || QUOTA_PATTERN.test(text),
    rate: signal === 'rate' || RATE_PATTERN.test(text),
  }
}

export function classifyProbeResult(input = {}) {
  const status = Number(input.status) || 0
  const signal = normalizeSignal(input)

  if (input.streamTruncated) {
    return {
      state: 'unknown',
      errorClass: 'transient',
      retryable: false,
      switchKey: false,
      switchProvider: false,
      cooldownMs: 0,
    }
  }

  if (status === 401 || status === 403) {
    return {
      state: 'rejected',
      errorClass: 'account',
      retryable: false,
      switchKey: true,
      switchProvider: false,
      cooldownMs: 0,
    }
  }

  if (status === 429) {
    if (signal.quota) {
      return {
        state: 'quota_exhausted',
        errorClass: 'account',
        retryable: false,
        switchKey: true,
        switchProvider: true,
        cooldownMs: Math.max(Number(input.retryAfterMs) || 0, 5 * 60 * 1000),
      }
    }
    return {
      state: 'rate_limited',
      errorClass: 'transient',
      retryable: false,
      switchKey: true,
      switchProvider: false,
      cooldownMs: Math.max(Number(input.retryAfterMs) || 0, 5000),
    }
  }

  if (status >= 500 || status === 0) {
    return {
      state: 'unknown',
      errorClass: 'provider',
      retryable: true,
      switchKey: false,
      switchProvider: true,
      cooldownMs: 5000,
    }
  }

  if (status >= 200 && status < 400) {
    return {
      state: 'reachable',
      errorClass: '',
      retryable: false,
      switchKey: false,
      switchProvider: false,
      cooldownMs: 0,
    }
  }

  if (status >= 400 && status < 500) {
    return {
      state: 'rejected',
      errorClass: 'request',
      retryable: false,
      switchKey: false,
      switchProvider: false,
      cooldownMs: 0,
    }
  }

  return {
    state: 'unknown',
    errorClass: 'transient',
    retryable: false,
    switchKey: false,
    switchProvider: false,
    cooldownMs: 0,
  }
}

export function nextProbeState(previous, input, now = Date.now()) {
  const prev = isProbeState(previous) ? previous : 'unknown'
  const result = classifyProbeResult(input)
  // 已经可达的渠道遇到 5xx / 超时，只保留“上次可达”，不因为一次抖动降级。
  const state = result.state === 'unknown' && prev === 'reachable' ? 'reachable' : result.state

  return {
    state,
    previous: prev,
    errorClass: result.errorClass,
    retryable: result.retryable,
    switchKey: result.switchKey,
    switchProvider: result.switchProvider,
    cooldownMs: result.cooldownMs,
    checkedAt: now,
    evidence: {
      status: Number(input?.status) || 0,
      error: input?.error || '',
      latencyMs: Number(input?.latencyMs) || 0,
      streamTruncated: input?.streamTruncated === true,
    },
  }
}

export function probeStateLabel(state) {
  if (state === 'reachable') return '可达'
  if (state === 'rejected') return '被拒绝'
  if (state === 'rate_limited') return '限流'
  if (state === 'quota_exhausted') return '额度耗尽'
  return '未测到'
}

// 连接测试结果 -> 状态机输入。连接成功但适配器没给状态码时按 200 处理；
// 结果缺失（null/undefined）按连接失败处理，绝不当作可达。
export function probeInputFromConnection(result = {}) {
  if (result && result.connected) {
    return {
      status: Number(result.status) || 200,
      latencyMs: Number(result.connectTime) || 0,
    }
  }
  return {
    status: Number(result?.status) || 0,
    error: result?.error || '连接失败',
    latencyMs: Number(result?.connectTime) || 0,
  }
}

// 模型测速结果 -> 状态机输入。适配器通常只返回 success/failed 与错误文案，
// 这里从文案里兜底识别 401/429，避免把“Key 无效”记成未知。
export function probeInputFromTestResult(result = {}) {
  if (result.status === 'success') {
    return { status: 200, latencyMs: Number(result.latency) || 0 }
  }
  if (result.status === 'cancelled') {
    return { status: 0, error: result.error || '请求已取消', errorClass: 'transient' }
  }

  const error = result.error || ''
  let status = Number(result.httpStatus || result.statusCode || 0)
  if (!status && /API Key|invalid.*key|unauthorized|401/i.test(error)) status = 401
  if (!status && /429|rate limit|too many/i.test(error)) status = 429
  return {
    status,
    error,
    latencyMs: Number(result.latency) || 0,
  }
}
