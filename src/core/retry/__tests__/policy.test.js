import { describe, expect, it } from 'vitest'
import { FAILURE_CLASSES, classifyFailure } from '../../failures/classify.js'
import { RETRY_ACTIONS, decideRetryAction, shouldRetry } from '../policy.js'

const failureOf = (input) => classifyFailure(input)

describe('decideRetryAction', () => {
  it('已输出内容后绝不重试', () => {
    for (const input of [{ status: 500 }, { status: 429 }, { code: 'ECONNRESET' }]) {
      const decision = decideRetryAction({ failure: failureOf(input), hasOutput: true })
      expect(decision.action).toBe(RETRY_ACTIONS.ABORT)
      expect(decision.reason).toBe('stream_truncated')
    }
  })

  it('request 类错误直接透传', () => {
    const decision = decideRetryAction({ failure: failureOf({ status: 400 }) })
    expect(decision.action).toBe(RETRY_ACTIONS.ABORT)
    expect(decision.reason).toBe('request_error')
  })

  it('429 短冷却后重试同一上游', () => {
    const decision = decideRetryAction({
      failure: failureOf({ status: 429, headers: { 'retry-after': '30' } }),
    })
    expect(decision.action).toBe(RETRY_ACTIONS.RETRY_SAME)
    expect(decision.waitMs).toBe(30000)
    expect(decision.reason).toBe('rate_limited_cooldown')
  })

  it('429 无 Retry-After 时 waitMs 为 0（由调用方用默认间隔）', () => {
    const decision = decideRetryAction({ failure: failureOf({ status: 429 }) })
    expect(decision.action).toBe(RETRY_ACTIONS.RETRY_SAME)
    expect(decision.waitMs).toBe(0)
  })

  it('account 类切 Key', () => {
    const decision = decideRetryAction({ failure: failureOf({ status: 401 }) })
    expect(decision.action).toBe(RETRY_ACTIONS.SWITCH_KEY)
    expect(decision.reason).toBe('account_error')
  })

  it('额度耗尽优先切 Key', () => {
    const decision = decideRetryAction({
      failure: failureOf({ status: 429, body: { error: { code: 'quota_exhausted' } } }),
    })
    expect(decision.action).toBe(RETRY_ACTIONS.SWITCH_KEY)
  })

  it('provider 类切上游', () => {
    const decision = decideRetryAction({ failure: failureOf({ status: 502 }) })
    expect(decision.action).toBe(RETRY_ACTIONS.SWITCH_PROVIDER)
    expect(decision.reason).toBe('provider_error')
  })

  it('transient 可重试类按指数退避', () => {
    const decision = decideRetryAction({
      failure: failureOf({ status: 408 }),
      attempt: 2,
      baseDelayMs: 2000,
    })
    expect(decision.action).toBe(RETRY_ACTIONS.RETRY_SAME)
    expect(decision.waitMs).toBe(4000)
  })

  it('超过最大尝试次数后终止', () => {
    const decision = decideRetryAction({
      failure: failureOf({ status: 502 }),
      attempt: 3,
      maxAttempts: 3,
    })
    expect(decision.action).toBe(RETRY_ACTIONS.ABORT)
    expect(decision.reason).toBe('max_attempts')
  })

  it('Retry-After 超过退避上限时终止，不静默缩短等待', () => {
    const decision = decideRetryAction({
      failure: failureOf({ status: 429, headers: { 'retry-after': '3600' } }),
      maxDelayMs: 30000,
    })
    expect(decision.action).toBe(RETRY_ACTIONS.ABORT)
    expect(decision.reason).toBe('cooldown_exceeds_limit')
  })

  it('缺失 failure 时终止', () => {
    const decision = decideRetryAction({ failure: null })
    expect(decision.action).toBe(RETRY_ACTIONS.ABORT)
  })
})

describe('shouldRetry', () => {
  it('返回 retry 布尔与决策详情', () => {
    const retry = shouldRetry(failureOf({ status: 502 }), { attempt: 1 })
    expect(retry.retry).toBe(true)
    expect(retry.action).toBe(RETRY_ACTIONS.SWITCH_PROVIDER)

    const stop = shouldRetry(failureOf({ status: 400 }), {})
    expect(stop.retry).toBe(false)
  })
})

describe('与 FAILURE_CLASSES 的联动', () => {
  it('四类都有明确动作', () => {
    expect(decideRetryAction({ failure: { class: FAILURE_CLASSES.REQUEST } }).action).toBe(
      RETRY_ACTIONS.ABORT,
    )
    expect(
      decideRetryAction({ failure: { class: FAILURE_CLASSES.ACCOUNT, switchKey: true } }).action,
    ).toBe(RETRY_ACTIONS.SWITCH_KEY)
    expect(
      decideRetryAction({ failure: { class: FAILURE_CLASSES.PROVIDER, switchProvider: true } })
        .action,
    ).toBe(RETRY_ACTIONS.SWITCH_PROVIDER)
    expect(
      decideRetryAction({
        failure: { class: FAILURE_CLASSES.TRANSIENT, retryable: false, cooldownMs: 5000 },
      }).action,
    ).toBe(RETRY_ACTIONS.RETRY_SAME)
  })
})
