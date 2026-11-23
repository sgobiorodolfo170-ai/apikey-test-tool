import { describe, expect, it } from 'vitest'
import {
  classifyProbeResult,
  isProbeState,
  nextProbeState,
  probeInputFromConnection,
  PROBE_STATES,
  probeStateLabel,
} from '../state.js'

describe('probe state machine', () => {
  it('exposes the fixed state set', () => {
    expect(PROBE_STATES).toEqual([
      'unknown',
      'reachable',
      'rejected',
      'rate_limited',
      'quota_exhausted',
    ])
    expect(isProbeState('reachable')).toBe(true)
    expect(isProbeState('missing')).toBe(false)
  })

  it('classifies success, rejection, rate limit and quota', () => {
    expect(classifyProbeResult({ status: 200 }).state).toBe('reachable')
    expect(classifyProbeResult({ status: 401 }).state).toBe('rejected')
    expect(classifyProbeResult({ status: 403 }).errorClass).toBe('account')
    expect(classifyProbeResult({ status: 404 }).errorClass).toBe('request')
    expect(classifyProbeResult({ status: 429 }).state).toBe('rate_limited')
    expect(classifyProbeResult({ status: 429, error: 'insufficient_quota' }).state).toBe(
      'quota_exhausted',
    )
    expect(classifyProbeResult({ status: 429, signal: 'quota' }).cooldownMs).toBe(300000)
  })

  it('does not turn a transient failure into a rejected key', () => {
    expect(classifyProbeResult({ status: 500 }).state).toBe('unknown')
    expect(classifyProbeResult({ status: 0, error: 'timeout' }).state).toBe('unknown')
    expect(nextProbeState('reachable', { status: 500 }).state).toBe('reachable')
    expect(nextProbeState('reachable', { status: 0 }).state).toBe('reachable')
  })

  it('marks truncated streams as unknown without retry', () => {
    const result = classifyProbeResult({ status: 200, streamTruncated: true })
    expect(result.state).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  it('keeps previous state and evidence', () => {
    const result = nextProbeState('unknown', {
      status: 401,
      error: 'invalid key',
      latencyMs: 42,
    })
    expect(result.state).toBe('rejected')
    expect(result.previous).toBe('unknown')
    expect(result.evidence).toEqual({
      status: 401,
      error: 'invalid key',
      latencyMs: 42,
      streamTruncated: false,
    })
    expect(result.checkedAt).toEqual(expect.any(Number))
  })

  it('labels states for UI', () => {
    expect(probeStateLabel('reachable')).toBe('可达')
    expect(probeStateLabel('quota_exhausted')).toBe('额度耗尽')
    expect(probeStateLabel('missing')).toBe('未测到')
  })

  it('connection input: missing result never counts as reachable', () => {
    // null/undefined 结果按连接失败处理，不能反向映射成 200
    expect(probeInputFromConnection(null)).toEqual({ status: 0, error: '连接失败', latencyMs: 0 })
    const fromNull = classifyProbeResult(probeInputFromConnection(null))
    expect(fromNull.state).toBe('unknown')
    // 成功但没给状态码 → 200
    expect(probeInputFromConnection({ connected: true, connectTime: 12 })).toEqual({
      status: 200,
      latencyMs: 12,
    })
    // 失败但带了状态码（如 401）→ 保留给状态机分类
    expect(probeInputFromConnection({ connected: false, status: 401 })).toEqual({
      status: 401,
      error: '连接失败',
      latencyMs: 0,
    })
  })
})
