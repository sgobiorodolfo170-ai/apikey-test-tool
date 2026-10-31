import { describe, it, expect } from 'vitest'
import { buildCheckupMarkdown, computeVerdict, scoreLevel, formatDuration } from '../report.js'

function makeCheckup(overrides = {}) {
  return {
    startedAt: '2026-10-26T12:00:00.000Z',
    finishedAt: '2026-10-26T12:02:30.000Z',
    durationMs: 150000,
    config: {
      provider: '某中转',
      baseUrl: 'https://api.example.com/v1',
      apiMode: 'openai',
      apiModeLabel: 'OpenAI',
      model: 'gpt-4o-mini',
    },
    connection: { connected: true, connectTime: 210 },
    models: { total: 12, list: [] },
    speed: {
      tested: 2,
      success: 2,
      avgLatency: 480,
      fastest: { model: 'gpt-4o-mini', latency: 300 },
      sample: [
        { model: 'gpt-4o-mini', latency: 300, status: 'success' },
        { model: 'gpt-4o', latency: 660, status: 'success' },
      ],
    },
    fingerprint: {
      bestName: 'OpenAI GPT 系列',
      bestPercent: 72,
      matches: [{ name: 'OpenAI GPT 系列', percent: 72 }],
    },
    capability: {
      overall: 80,
      grade: { label: '良好', color: 'success' },
      correctCount: 30,
      total: 38,
      incompleteCount: 0,
      dimensions: [{ name: '逻辑推理', score: 90, correct: 5, total: 6 }],
    },
    stability: {
      rounds: 5,
      success: 5,
      failed: 0,
      rateLimited: 0,
      successRate: 100,
      p50: 320,
      p95: 520,
      avg: 350,
      errors: [],
    },
    ...overrides,
  }
}

describe('computeVerdict', () => {
  it('renormalizes weights when consistency is missing', () => {
    const verdict = computeVerdict(makeCheckup())
    expect(verdict.score).toBe(87)
    expect(verdict.level).toBe('优秀')
    expect(verdict.scoreVersion).toBe(2)
  })

  it('marks a missing required dimension as insufficient data', () => {
    const verdict = computeVerdict(makeCheckup({ capability: null, consistency: null }))

    expect(verdict.level).toBe('数据不足')
    expect(verdict.confidence).toBe('low')
    // 只保留稳定性 30 分，不再按剩余权重归一化成 100
    expect(verdict.score).toBe(30)
    expect(verdict.notes.join(' ')).toContain('缺少能力测评')
  })

  it('folds consistency into the score when present', () => {
    const stable = makeCheckup({
      consistency: { agreement: 100, accuracy: 100 },
    })
    expect(computeVerdict(stable).score).toBe(89)

    const flaky = makeCheckup({
      consistency: { agreement: 50, accuracy: 50 },
    })
    expect(computeVerdict(flaky).score).toBe(82)
  })

  it('returns unusable when the connection failed', () => {
    const verdict = computeVerdict({ connection: { connected: false, error: '401' } })
    expect(verdict.score).toBe(0)
    expect(verdict.level).toBe('不可用')
    expect(verdict.notes[0]).toContain('401')
  })

  it('flags a suspiciously low capability score', () => {
    const checkup = makeCheckup()
    checkup.capability.overall = 32
    const verdict = computeVerdict(checkup)
    expect(verdict.notes.join(' ')).toContain('疑似降智')
  })

  it('flags rate limiting and unstable success rate', () => {
    const checkup = makeCheckup()
    checkup.stability = { ...checkup.stability, successRate: 60, failed: 2, rateLimited: 2 }
    const verdict = computeVerdict(checkup)
    expect(verdict.notes.join(' ')).toContain('429')
    expect(verdict.notes.join(' ')).toContain('成功率')
  })

  it('does not use fingerprint confidence as a quality score', () => {
    const low = makeCheckup()
    low.fingerprint = { bestName: null, bestPercent: 0, matches: [] }
    expect(computeVerdict(low).score).toBe(computeVerdict(makeCheckup()).score)
  })

  it('flags inconsistency in the notes', () => {
    const checkup = makeCheckup({ consistency: { agreement: 40, accuracy: 95 } })
    expect(computeVerdict(checkup).notes.join(' ')).toContain('前后不一致')
  })
})

describe('scoreLevel / formatDuration', () => {
  it('maps scores to levels', () => {
    expect(scoreLevel(90).label).toBe('优秀')
    expect(scoreLevel(70).label).toBe('良好')
    expect(scoreLevel(55).label).toBe('一般')
    expect(scoreLevel(10).label).toBe('存疑')
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45000)).toBe('45秒')
    expect(formatDuration(150000)).toBe('2分30秒')
  })
})

describe('buildCheckupMarkdown', () => {
  it('renders all sections with the verdict and dimensions', () => {
    const md = buildCheckupMarkdown(makeCheckup())

    expect(md).toContain('# API 渠道体检报告')
    expect(md).toContain('**综合评分：87 / 100 · 优秀**')
    expect(md).toContain('评分口径 v2')
    expect(md).toContain('某中转')
    expect(md).toContain('gpt-4o-mini')
    expect(md).toContain('| 逻辑推理 | 90 | 5/6 |')
    expect(md).toContain('成功率 **100%**')
    expect(md).toContain('OpenAI GPT 系列')
  })

  it('still renders a report for a failed connection', () => {
    const md = buildCheckupMarkdown(
      makeCheckup({
        connection: { connected: false, connectTime: 0, error: 'API Key无效' },
        capability: null,
        stability: null,
        fingerprint: null,
        verdict: computeVerdict({ connection: { connected: false, error: 'API Key无效' } }),
      }),
    )

    expect(md).toContain('连通状态 | 失败')
    expect(md).toContain('不可用')
  })

  it('returns empty string without data', () => {
    expect(buildCheckupMarkdown(null)).toBe('')
  })
})
