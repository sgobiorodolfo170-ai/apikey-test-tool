// 重试与切换策略：由失败分类驱动，不改变调用方结构。
// 规则：
// - 429：短冷却（≤ maxDelayMs）后重试同一上游；超过上限不在本地干等，直接终止交给调用方换上游
// - 已向客户端输出内容后不重试（避免重复计费）
// - request 类错误不切 Key、不切上游，原样透传
// - account 类错误切同上游下一把 Key
// - provider 类错误切下一个上游
// - transient 类错误按退避重试

import { FAILURE_CLASSES } from '../failures/classify.js'

export const RETRY_ACTIONS = {
  RETRY_SAME: 'retry_same', // 同一上游同一 Key 重试
  SWITCH_KEY: 'switch_key', // 同一上游换下一把 Key
  SWITCH_PROVIDER: 'switch_provider', // 换下一个上游
  ABORT: 'abort', // 终止，把错误透传给客户端
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 2000
const DEFAULT_MAX_DELAY_MS = 30000

function clampDelay(value, maxDelayMs) {
  return Math.min(Math.max(0, Math.round(value || 0)), maxDelayMs)
}

// 单次失败 → 下一步动作。
// input: { failure, attempt, hasOutput, maxAttempts, baseDelayMs, maxDelayMs }
// failure 是 classifyFailure 的返回值。
export function decideRetryAction({
  failure,
  attempt = 1,
  hasOutput = false,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
  const nextAttempt = attempt + 1
  const canRetryMore = nextAttempt <= maxAttempts

  // 已输出内容：绝不重试（避免重复计费 / 重复输出）
  if (hasOutput) {
    return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'stream_truncated' }
  }

  // 取消 / 请求错误：直接透传
  if (!failure || failure.class === FAILURE_CLASSES.REQUEST) {
    return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'request_error' }
  }

  // 429（transient）：短冷却后重试同一上游；Retry-After 超过退避上限说明上游要求长时间等待，
  // 本地静默缩短等待只会反复撞墙，直接终止由调用方换 Key / 换上游
  if (failure.class === FAILURE_CLASSES.TRANSIENT && !failure.retryable) {
    if (!canRetryMore) return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'max_attempts' }
    if (failure.cooldownMs > maxDelayMs) {
      return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'cooldown_exceeds_limit' }
    }
    return {
      action: RETRY_ACTIONS.RETRY_SAME,
      waitMs: clampDelay(failure.cooldownMs, maxDelayMs),
      reason: 'rate_limited_cooldown',
    }
  }

  // account 类：切 Key（同上游）
  if (failure.class === FAILURE_CLASSES.ACCOUNT) {
    if (failure.switchKey && canRetryMore) {
      return { action: RETRY_ACTIONS.SWITCH_KEY, waitMs: 0, reason: 'account_error' }
    }
    if (failure.switchProvider && canRetryMore) {
      return { action: RETRY_ACTIONS.SWITCH_PROVIDER, waitMs: 0, reason: 'account_error' }
    }
    return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'max_attempts' }
  }

  // provider 类：切上游
  if (failure.class === FAILURE_CLASSES.PROVIDER) {
    if (failure.switchProvider && canRetryMore) {
      return {
        action: RETRY_ACTIONS.SWITCH_PROVIDER,
        waitMs: clampDelay(failure.cooldownMs, maxDelayMs),
        reason: 'provider_error',
      }
    }
    return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'max_attempts' }
  }

  // transient 且 retryable（408/425）：指数退避重试
  const waitMs = clampDelay(failure.cooldownMs || baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
  if (!canRetryMore) return { action: RETRY_ACTIONS.ABORT, waitMs: 0, reason: 'max_attempts' }
  return { action: RETRY_ACTIONS.RETRY_SAME, waitMs, reason: 'transient_backoff' }
}

// 便捷封装：给定失败与上下文，返回「是否继续、等多久、怎么切」
export function shouldRetry(failure, context = {}) {
  const decision = decideRetryAction({ failure, ...context })
  return {
    retry: decision.action !== RETRY_ACTIONS.ABORT,
    ...decision,
  }
}
