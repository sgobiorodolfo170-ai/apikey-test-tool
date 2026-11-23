import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { computeUsageMetrics, formatTps, formatTtft } from '../usage.js'

const require = createRequire(import.meta.url)
const {
  computeUsageMetrics: computeUsageMetricsCjs,
} = require('../../../../electron/lib/metrics.cjs')

describe('usage metrics', () => {
  it('separates TTFT from decode speed and excludes reasoning tokens', () => {
    const result = computeUsageMetrics({
      startedAt: 1000,
      firstTokenAt: 1500,
      endedAt: 2500,
      usage: {
        prompt_tokens: 50,
        completion_tokens: 100,
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    })

    expect(result.ttftMs).toBe(500)
    expect(result.streamMs).toBe(1000)
    expect(result.visibleOutputTokens).toBe(80)
    expect(result.tps).toBe(80)
    expect(result.inputTokens).toBe(50)
    expect(result.outputTokens).toBe(100)
    expect(result.totalTokens).toBe(150)
    expect(result.usageMissing).toBe(false)
  })

  it('supports Anthropic usage keys and missing usage', () => {
    const anthropic = computeUsageMetrics({
      startedAt: 0,
      firstTokenAt: 100,
      endedAt: 600,
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    expect(anthropic.inputTokens).toBe(10)
    expect(anthropic.outputTokens).toBe(5)
    expect(anthropic.totalTokens).toBe(15)
    expect(anthropic.tps).toBe(10)

    const missing = computeUsageMetrics({ startedAt: 0, firstTokenAt: 100, endedAt: 600 })
    expect(missing.usageMissing).toBe(true)
    expect(missing.inputTokens).toBeNull()
    expect(missing.outputTokens).toBeNull()
    expect(missing.tps).toBeNull()
  })

  it('returns null TTFT and speed when there is no first token', () => {
    const result = computeUsageMetrics({
      startedAt: 0,
      endedAt: 900,
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    expect(result.ttftMs).toBeNull()
    expect(result.streamMs).toBeNull()
    expect(result.tps).toBeNull()
  })

  it('does not count reasoning-only output as visible speed', () => {
    const result = computeUsageMetrics({
      startedAt: 0,
      firstTokenAt: 100,
      endedAt: 1100,
      usage: { prompt_tokens: 1, completion_tokens: 10 },
      reasoningTokens: 10,
    })
    expect(result.reasoningTokens).toBe(10)
    expect(result.visibleOutputTokens).toBe(0)
    expect(result.tps).toBeNull()
  })

  it('formats values for UI', () => {
    expect(formatTtft(123.6)).toBe('124ms')
    expect(formatTtft(null)).toBe('—')
    expect(formatTps(12.345)).toBe('12.3 tok/s')
    expect(formatTps(0)).toBe('—')
  })

  it('keeps the CJS implementation in sync', () => {
    const cases = [
      {
        startedAt: 1000,
        firstTokenAt: 1500,
        endedAt: 2500,
        usage: {
          prompt_tokens: 50,
          completion_tokens: 100,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      },
      {
        startedAt: 0,
        firstTokenAt: 100,
        endedAt: 600,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      { startedAt: 0, firstTokenAt: 100, endedAt: 600 },
      { startedAt: 0, endedAt: 900, usage: { prompt_tokens: 1, completion_tokens: 1 } },
      {
        startedAt: 0,
        firstTokenAt: 100,
        endedAt: 1100,
        usage: { completion_tokens: 10 },
        reasoningTokens: 10,
      },
    ]
    for (const input of cases) {
      expect(computeUsageMetricsCjs(input)).toEqual(computeUsageMetrics(input))
    }
  })
})
