import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../modes.js', () => ({
  getApiAdapter: vi.fn(),
  apiModeLabel: vi.fn(() => 'OpenAI'),
}))

vi.mock('../evalApi.js', () => ({
  runFingerprintMatch: vi.fn(),
  runCapabilityTest: vi.fn(),
  runStabilityTest: vi.fn(),
  runConsistencyTest: vi.fn(),
}))

import { getApiAdapter } from '../modes.js'
import {
  runFingerprintMatch,
  runCapabilityTest,
  runStabilityTest,
  runConsistencyTest,
} from '../evalApi.js'
import { runCheckup, toHistoryCheckup } from '../checkup.js'

const config = {
  provider: '中转A',
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk',
  apiMode: 'openai',
}

function makeAdapter(overrides = {}) {
  return {
    testConnection: vi.fn(async () => ({ connected: true, connectTime: 120 })),
    listModels: vi.fn(async () => ({
      success: true,
      models: [{ id: 'slow-model' }, { id: 'fast-model' }],
    })),
    testModels: vi.fn(async (_config, models) =>
      models.map((model) => ({
        model,
        latency: model === 'fast-model' ? 200 : 900,
        status: 'success',
      })),
    ),
    ...overrides,
  }
}

describe('runCheckup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stops early and still produces a report when the connection fails', async () => {
    getApiAdapter.mockReturnValue(
      makeAdapter({
        testConnection: vi.fn(async () => ({
          connected: false,
          connectTime: 0,
          error: '401 无效',
        })),
      }),
    )

    const stages = []
    const result = await runCheckup(config, { onProgress: (p) => stages.push(p.stage) })

    expect(result.connection.connected).toBe(false)
    expect(result.verdict.score).toBe(0)
    expect(result.verdict.level).toBe('不可用')
    expect(result.report).toContain('# API 渠道体检报告')
    expect(runFingerprintMatch).not.toHaveBeenCalled()
    expect(stages).toEqual(['connect', 'done'])
  })

  it('runs the full pipeline and picks the fastest model as the target', async () => {
    const adapter = makeAdapter()
    getApiAdapter.mockReturnValue(adapter)

    runFingerprintMatch.mockResolvedValue({
      bestName: 'OpenAI GPT 系列',
      bestPercent: 75,
      matches: [{ name: 'OpenAI GPT 系列', percent: 75 }],
      answers: [{ probe: 'identity', answer: 'x' }],
      incompleteCount: 0,
    })
    runCapabilityTest.mockResolvedValue({
      overall: 82,
      grade: { label: '良好', color: 'success' },
      correctCount: 31,
      total: 38,
      incompleteCount: 0,
      dimensions: [{ name: '逻辑推理', score: 90, correct: 5, total: 6 }],
    })
    runStabilityTest.mockResolvedValue({
      rounds: 5,
      success: 5,
      failed: 0,
      rateLimited: 0,
      successRate: 100,
      p50: 300,
      p95: 500,
      avg: 320,
      errors: [],
    })
    runConsistencyTest.mockResolvedValue({
      rounds: 3,
      agreement: 100,
      accuracy: 100,
      verdict: { label: '一致性好', color: 'success', note: 'ok' },
      probes: [],
    })

    const stages = []
    const result = await runCheckup(config, { onProgress: (p) => stages.push(p.stage) })

    expect(adapter.listModels).toHaveBeenCalled()
    expect(result.models.total).toBe(2)
    expect(result.speed.success).toBe(2)
    expect(result.speed.fastest.model).toBe('fast-model')
    expect(result.config.model).toBe('fast-model')
    expect(runCapabilityTest).toHaveBeenCalledWith(config, 'fast-model', expect.any(Object))
    expect(result.verdict.score).toBe(90)
    expect(result.report).toContain('| 逻辑推理 | 90 | 5/6 |')
    expect(stages).toEqual([
      'connect',
      'models',
      'speed',
      'fingerprint',
      'capability',
      'stability',
      'consistency',
      'done',
    ])
  })

  it('honours an explicitly chosen model over the fastest one', async () => {
    getApiAdapter.mockReturnValue(makeAdapter())
    runFingerprintMatch.mockResolvedValue({
      bestName: null,
      bestPercent: 0,
      matches: [],
      answers: [],
    })
    runCapabilityTest.mockResolvedValue({
      overall: 70,
      grade: { label: '良好', color: 'success' },
      correctCount: 20,
      total: 38,
      dimensions: [],
    })
    runStabilityTest.mockResolvedValue({
      successRate: 100,
      rounds: 5,
      success: 5,
      failed: 0,
      rateLimited: 0,
      p50: 1,
      p95: 2,
      avg: 1,
      errors: [],
    })

    const result = await runCheckup(config, { model: 'slow-model' })

    expect(result.config.model).toBe('slow-model')
    expect(runCapabilityTest).toHaveBeenCalledWith(config, 'slow-model', expect.any(Object))
  })

  it('keeps going when the model list fails', async () => {
    getApiAdapter.mockReturnValue(
      makeAdapter({
        listModels: vi.fn(async () => {
          throw new Error('403')
        }),
      }),
    )
    runFingerprintMatch.mockResolvedValue({
      bestName: null,
      bestPercent: 0,
      matches: [],
      answers: [],
    })
    runCapabilityTest.mockResolvedValue({
      overall: 60,
      grade: { label: '中等' },
      correctCount: 10,
      total: 38,
      dimensions: [],
    })
    runStabilityTest.mockResolvedValue({
      successRate: 100,
      rounds: 5,
      success: 5,
      failed: 0,
      rateLimited: 0,
      p50: 1,
      p95: 2,
      avg: 1,
      errors: [],
    })

    const result = await runCheckup(config, { model: 'manual-model' })

    expect(result.models.total).toBe(0)
    expect(result.config.model).toBe('manual-model')
    expect(result.verdict.notes.join(' ')).toContain('模型列表')
  })
})

describe('toHistoryCheckup', () => {
  it('drops heavy answer payloads but keeps the report', () => {
    const trimmed = toHistoryCheckup({
      finishedAt: '2026-10-26T12:00:00.000Z',
      durationMs: 1000,
      config: { model: 'gpt-4o-mini' },
      verdict: { score: 88, level: '优秀', color: 'success', notes: ['ok'] },
      capability: {
        overall: 88,
        grade: { label: '优秀' },
        correctCount: 30,
        total: 38,
        dimensions: [
          { name: '逻辑推理', score: 90, correct: 5, total: 6, questions: [{ id: 'q1' }] },
        ],
      },
      fingerprint: {
        bestName: 'GPT',
        bestPercent: 70,
        matches: [{ name: 'GPT', percent: 70 }],
        answers: [{ probe: 'x', answer: 'long text' }],
      },
      stability: { rounds: 5, successRate: 100, failed: 0, rateLimited: 0, p50: 1, p95: 2 },
      report: '# report',
    })

    expect(trimmed.report).toBe('# report')
    expect(trimmed.capability.dimensions[0].questions).toBeUndefined()
    expect(trimmed.fingerprint.answers).toBeUndefined()
    expect(trimmed.model).toBe('gpt-4o-mini')
  })
})
