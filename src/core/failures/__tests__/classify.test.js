// 契约测试：src/core/failures/classify.js（ESM）与 electron/lib/failures.cjs（CJS）
// 必须对同一输入给出完全一致的分类结果。
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { FAILURE_CLASSES, classifyFailure, isQuotaSignal, parseRetryAfterMs } from '../classify.js'

const require = createRequire(import.meta.url)
const cjs = require('../../../../electron/lib/failures.cjs')

// 覆盖四类 + 边界的代表性输入
const CASES = [
  { name: '2xx 不算失败', input: { status: 200 } },
  { name: '400 请求错误', input: { status: 400, message: 'bad request' } },
  { name: '404 请求错误', input: { status: 404 } },
  { name: '422 请求错误', input: { status: 422 } },
  { name: '401 凭据', input: { status: 401 } },
  { name: '403 凭据', input: { status: 403 } },
  { name: '429 瞬时限流', input: { status: 429, body: { error: { code: 'rate_limit' } } } },
  {
    name: '429 额度耗尽',
    input: { status: 429, body: { error: { code: 'insufficient_quota' } } },
  },
  {
    name: '429 额度文案',
    input: { status: 429, body: 'You exceeded your current quota' },
  },
  { name: '429 带 Retry-After', input: { status: 429, headers: { 'retry-after': '30' } } },
  { name: '408 超时状态', input: { status: 408 } },
  { name: '425 Too Early', input: { status: 425 } },
  { name: '500 上游错误', input: { status: 500 } },
  { name: '502 上游错误', input: { status: 502 } },
  { name: '503 上游错误', input: { status: 503 } },
  { name: '网络错误 ECONNREFUSED', input: { code: 'ECONNREFUSED' } },
  { name: '网络错误 ENOTFOUND', input: { code: 'ENOTFOUND' } },
  { name: '请求超时 ECONNABORTED', input: { code: 'ECONNABORTED' } },
  { name: '显式 timeout', input: { timeout: true } },
  { name: '客户端取消', input: { aborted: true } },
  { name: 'ERR_CANCELED', input: { code: 'ERR_CANCELED' } },
  { name: '无状态无错误码', input: {} },
]

describe('failures 契约：ESM 与 CJS 分类一致', () => {
  it('FAILURE_CLASSES 枚举一致', () => {
    expect(cjs.FAILURE_CLASSES).toEqual(FAILURE_CLASSES)
  })

  it('isQuotaSignal 一致', () => {
    for (const payload of [
      { error: { code: 'insufficient_quota' } },
      'rate limit exceeded',
      'quota_exhausted',
      null,
      42,
    ]) {
      expect(cjs.isQuotaSignal(payload)).toBe(isQuotaSignal(payload))
    }
  })

  it('Retry-After 异常大值时双实现都限制在 24 小时', () => {
    const huge = '1000000000000'
    expect(parseRetryAfterMs(huge)).toBe(24 * 60 * 60 * 1000)
    expect(cjs.parseRetryAfterMs(huge)).toBe(24 * 60 * 60 * 1000)
  })

  it('parseRetryAfterMs 一致（数字秒）', () => {
    for (const value of ['30', '0.5', '', null, 'invalid-date']) {
      // 日期解析依赖当前时间，只比对非日期输入
      if (value === null || value === '' || value === 'invalid-date') {
        expect(cjs.parseRetryAfterMs(value)).toBe(parseRetryAfterMs(value))
      } else {
        expect(cjs.parseRetryAfterMs(value)).toBe(parseRetryAfterMs(value))
      }
    }
  })

  for (const { name, input } of CASES) {
    it(`分类一致：${name}`, () => {
      const esm = classifyFailure(input)
      const cjsResult = cjs.classifyFailure(input)
      expect(cjsResult).toEqual(esm)
    })
  }

  it('四类语义正确', () => {
    expect(classifyFailure({ status: 400 }).class).toBe(FAILURE_CLASSES.REQUEST)
    expect(classifyFailure({ status: 401 }).class).toBe(FAILURE_CLASSES.ACCOUNT)
    expect(classifyFailure({ status: 500 }).class).toBe(FAILURE_CLASSES.PROVIDER)
    expect(classifyFailure({ status: 429 }).class).toBe(FAILURE_CLASSES.TRANSIENT)
  })

  it('429 不自动重试，按 Retry-After 冷却', () => {
    const result = classifyFailure({ status: 429, headers: { 'retry-after': '30' } })
    expect(result.retryable).toBe(false)
    expect(result.cooldownMs).toBe(30000)
    expect(result.switchKey).toBe(true)
  })

  it('额度耗尽切 Key 也切上游', () => {
    const result = classifyFailure({ status: 429, body: { error: { code: 'quota_exhausted' } } })
    expect(result.class).toBe(FAILURE_CLASSES.ACCOUNT)
    expect(result.switchKey).toBe(true)
    expect(result.switchProvider).toBe(true)
  })

  it('请求错误不切 Key 不切上游', () => {
    const result = classifyFailure({ status: 400 })
    expect(result.switchKey).toBe(false)
    expect(result.switchProvider).toBe(false)
    expect(result.retryable).toBe(false)
  })

  it('5xx 切上游可重试', () => {
    const result = classifyFailure({ status: 502 })
    expect(result.retryable).toBe(true)
    expect(result.switchProvider).toBe(true)
    expect(result.switchKey).toBe(false)
  })

  it('取消不算失败', () => {
    const result = classifyFailure({ aborted: true })
    expect(result.retryable).toBe(false)
    expect(result.evidence.cancelled).toBe(true)
  })
})
