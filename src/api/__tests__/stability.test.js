import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../modes.js', () => ({
  getApiAdapter: vi.fn(),
}))

import { getApiAdapter } from '../modes.js'
import { runStabilityTest, checkCapabilityAnswer, percentile } from '../evalApi.js'

const config = { apiKey: 'sk', baseUrl: 'https://api.test/v1', apiMode: 'openai' }

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20)
    expect(percentile([40, 10, 30, 20], 95)).toBe(40)
    expect(percentile([100], 95)).toBe(100)
    expect(percentile([], 50)).toBe(0)
  })
})

describe('checkCapabilityAnswer', () => {
  it('accepts the answer anywhere in the reply (number)', () => {
    const q = { type: 'number', answer: 702 }
    expect(checkCapabilityAnswer(q, '17 × 43 - 29 = 702')).toBe(true)
    expect(checkCapabilityAnswer(q, '702')).toBe(true)
    expect(checkCapabilityAnswer(q, '731')).toBe(false)
  })

  it('handles full-width digits and punctuation', () => {
    expect(checkCapabilityAnswer({ type: 'number', answer: 702 }, '答案是７０２')).toBe(true)
    expect(checkCapabilityAnswer({ type: 'choice', answer: ['答案：4'] }, '答案：４')).toBe(true)
  })

  it('respects the tolerance option', () => {
    const q = { type: 'number', answer: 1280.5, tolerance: 0.01 }
    expect(checkCapabilityAnswer(q, '1280.50')).toBe(true)
    expect(checkCapabilityAnswer(q, '1281')).toBe(false)
  })

  it('does not let a single letter match inside a word (choice)', () => {
    const q = { type: 'choice', answer: ['A'] }
    expect(checkCapabilityAnswer(q, 'A')).toBe(true)
    expect(checkCapabilityAnswer(q, '选 A')).toBe(true)
    expect(checkCapabilityAnswer(q, 'Bad answer')).toBe(false)
  })

  it('requires every keyword for keyword questions', () => {
    const q = { type: 'keyword', answer: ['造纸', '印刷', '火药', '指南针'] }
    expect(checkCapabilityAnswer(q, '造纸术、印刷术、火药、指南针')).toBe(true)
    expect(checkCapabilityAnswer(q, '造纸术、印刷术')).toBe(false)
  })

  it('supports regex questions', () => {
    const q = { type: 'regex', answer: ['^ok$'] }
    expect(checkCapabilityAnswer(q, 'ok')).toBe(true)
    expect(checkCapabilityAnswer(q, 'nope')).toBe(false)
  })
})

describe('runStabilityTest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('aggregates success rate, latency percentiles and 429 count', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce({
        response: { status: 429, data: { error: { message: 'slow down' } } },
      })

    getApiAdapter.mockReturnValue({ chat })

    const progress = []
    const result = await runStabilityTest(config, 'gpt-4o-mini', {
      rounds: 3,
      concurrency: 1,
      onProgress: (p) => progress.push(p.done),
    })

    expect(result.rounds).toBe(3)
    expect(result.success).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.rateLimited).toBe(1)
    expect(result.successRate).toBe(67)
    expect(Number.isFinite(result.p50)).toBe(true)
    expect(result.max).toBeGreaterThanOrEqual(result.min)
    expect(result.errors[0]).toContain('slow down')
    expect(progress).toEqual([1, 2, 3])
  })

  it('marks cancelled rounds and stops pulling new work', async () => {
    const chat = vi.fn().mockRejectedValue({ name: 'CanceledError' })
    getApiAdapter.mockReturnValue({ chat })

    const result = await runStabilityTest(config, 'm', { rounds: 4, concurrency: 1 })

    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(0)
    expect(chat.mock.calls.length).toBeLessThan(4)
  })
})
