import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../modes.js', () => ({
  getApiAdapter: vi.fn(),
}))

import { getApiAdapter } from '../modes.js'
import {
  runFingerprintMatch,
  runCapabilityTest,
  runConsistencyTest,
  consistencyVerdict,
  checkCapabilityAnswer,
  gradeOf,
} from '../evalApi.js'
import { FINGERPRINT_PROBES, FINGERPRINT_LIBRARY } from '../../data/fingerprints.js'
import { QUESTION_BANK, CAPABILITY_DIMENSIONS } from '../../data/questionBank.js'

const mockConfig = { apiKey: 'sk', baseUrl: 'https://api.test/v1', apiMode: 'openai' }

function mockChat(replacer) {
  const adapter = {
    chat: vi.fn(async (_config, { messages }) => replacer(messages[0].content)),
  }
  getApiAdapter.mockReturnValue(adapter)
  return adapter
}

function correctAnswerFor(question) {
  if (question.type === 'number') return String(question.answer)
  if (question.type === 'choice') return question.answer[0]
  if (question.type === 'code') return 'function solve(x) { return x }'
  return question.answer.join('，')
}

describe('evalApi fingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should report a high match for the family whose markers match', async () => {
    mockChat(() => 'Claude, an AI assistant made by Anthropic.')
    const result = await runFingerprintMatch(mockConfig, 'test-model')
    expect(result.model).toBe('test-model')
    expect(result.best).toBe('claude')
    expect(result.bestName).toContain('Claude')
    expect(result.bestPercent).toBeGreaterThan(0)
    expect(result.answers.length).toBe(FINGERPRINT_PROBES.length)
    const sorted = [...result.matches].sort((a, b) => b.percent - a.percent)
    expect(result.matches[0]).toEqual(sorted[0])
  })

  it('should return partial results when server errors persist past the time limit', async () => {
    mockChat(() => {
      throw { response: { status: 500 } }
    })
    const result = await runFingerprintMatch(mockConfig, 'm', {
      timeoutMs: 5,
      retryDelayMs: 0,
    })
    expect(result.incompleteCount).toBeGreaterThan(0)
    expect(result.best).toBeNull()
  })

  it('should return partial results when transient failures persist past the time limit', async () => {
    mockChat(() => {
      throw new Error('boom')
    })
    const result = await runFingerprintMatch(mockConfig, 'm', {
      timeoutMs: 5,
      retryDelayMs: 0,
    })
    expect(result.incompleteCount).toBeGreaterThan(0)
  })

  it('should not retry 4xx errors like 401', async () => {
    let calls = 0
    mockChat(() => {
      calls++
      throw { response: { status: 401 } }
    })
    const result = await runFingerprintMatch(mockConfig, 'm', { retryDelayMs: 0 })
    // 每个探针只调用一次（401 不重试）
    expect(calls).toBe(FINGERPRINT_PROBES.length)
    expect(result.answers.every((a) => a.error)).toBe(true)
  })

  it('should retry a transient failure until it succeeds', async () => {
    let calls = 0
    mockChat(() => {
      calls++
      if (calls === 1) throw new Error('network')
      return 'Gemini, developed by Google'
    })
    const result = await runFingerprintMatch(mockConfig, 'm', { retryDelayMs: 0 })
    expect(calls).toBe(FINGERPRINT_PROBES.length + 1)
    expect(result.answers.every((a) => !a.error)).toBe(true)
    expect(result.best).toBe('gemini')
  })

  it('should retry rate-limited questions on subsequent rounds until answered', async () => {
    const attempts = new Set()
    mockChat(() => {
      // 每个探针第一次都 429，第二次成功
      const key = Math.random()
      // 用调用次数代理：每 6 个探针一轮
      if (attempts.size < FINGERPRINT_PROBES.length) {
        attempts.add(key)
        throw { response: { status: 429 } }
      }
      return 'DeepSeek, 深度求索'
    })
    const result = await runFingerprintMatch(mockConfig, 'm', { retryDelayMs: 0 })
    expect(result.best).toBe('deepseek')
    expect(result.answers.every((a) => !a.error)).toBe(true)
  })

  it('should prefer weighted self-identification over single behavior matches', async () => {
    mockChat((prompt) => {
      if (prompt.includes('strawberry')) return '2'
      if (prompt.includes('Which is larger')) return '11 更大'
      if (prompt.includes('Which AI model')) return 'I am GPT-4o from OpenAI'
      if (prompt.includes('你是哪个AI模型')) return '我是 OpenAI 的 GPT-4o'
      if (prompt.includes('developed you')) return 'OpenAI'
      if (prompt.includes('bomb')) return 'I can not help with that.'
      return ''
    })
    const result = await runFingerprintMatch(mockConfig, 'm')
    expect(result.best).toBe('gpt')
  })
})

describe('evalApi capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 代码题需要主进程执行能力；这里桩成「全部用例通过」
    window.electronAPI = {
      runCode: vi.fn(async ({ tests }) => ({
        ok: true,
        results: (tests || []).map((t) => ({ ...t, pass: true })),
      })),
    }
  })

  afterEach(() => {
    delete window.electronAPI
  })

  it('should score 100 when all questions answered correctly', async () => {
    mockChat((prompt) => {
      const q = QUESTION_BANK.find((x) => x.prompt === prompt)
      return q ? correctAnswerFor(q) : ''
    })
    const result = await runCapabilityTest(mockConfig, 'm', {
      questions: QUESTION_BANK,
      retryDelayMs: 0,
    })
    expect(result.overall).toBe(100)
    expect(result.correctCount).toBe(QUESTION_BANK.length)
    expect(result.grade.label).toBe('优秀')
    expect(result.dimensions.every((d) => d.score === 100)).toBe(true)
  })

  it('should score 0 when nothing matches', async () => {
    mockChat(() => '')
    const result = await runCapabilityTest(mockConfig, 'm', {
      questions: QUESTION_BANK,
      retryDelayMs: 0,
    })
    expect(result.overall).toBe(0)
    expect(result.correctCount).toBe(0)
    expect(result.dimensions.every((d) => d.score === 0)).toBe(true)
  })

  it('should return partial results when the capability run hits the time limit', async () => {
    mockChat(() => new Promise((resolve) => setTimeout(() => resolve(''), 60)))
    const result = await runCapabilityTest(mockConfig, 'm', {
      questions: QUESTION_BANK,
      concurrency: 2,
      timeoutMs: 5,
      retryDelayMs: 0,
    })
    expect(result.incompleteCount).toBeGreaterThan(0)
    expect(result.answered).toBeLessThan(QUESTION_BANK.length)
  })

  it('should keep retrying transient failures until all questions are answered', async () => {
    let calls = 0
    mockChat((prompt) => {
      calls++
      // 前 18 次调用全部瞬时失败（限流），之后正常作答
      if (calls <= QUESTION_BANK.length) throw { response: { status: 429 } }
      const q = QUESTION_BANK.find((x) => x.prompt === prompt)
      return q ? correctAnswerFor(q) : ''
    })
    const result = await runCapabilityTest(mockConfig, 'm', {
      questions: QUESTION_BANK,
      retryDelayMs: 0,
    })
    expect(result.answered).toBe(QUESTION_BANK.length)
    expect(result.overall).toBe(100)
  })

  it('should report progress via onProgress callback', async () => {
    mockChat((prompt) => {
      const q = QUESTION_BANK.find((x) => x.prompt === prompt)
      return q ? correctAnswerFor(q) : ''
    })
    const progress = []
    await runCapabilityTest(mockConfig, 'm', {
      questions: QUESTION_BANK,
      retryDelayMs: 0,
      onProgress: (p) => progress.push(p),
    })
    expect(progress.length).toBe(QUESTION_BANK.length)
    expect(progress[progress.length - 1]).toEqual({
      done: QUESTION_BANK.length,
      total: QUESTION_BANK.length,
    })
  })
})

describe('evalApi answer checking', () => {
  it('should check number answers by extracting the first number', () => {
    expect(checkCapabilityAnswer({ type: 'number', answer: 702 }, '答案是 702 个。')).toBe(true)
    expect(checkCapabilityAnswer({ type: 'number', answer: 702 }, '没法计算')).toBe(false)
    expect(checkCapabilityAnswer({ type: 'number', answer: 6 }, 'x = 6')).toBe(true)
  })

  it('should check choice answers as standalone options, not substrings', () => {
    const q = { type: 'choice', answer: ['A', 'a'] }
    expect(checkCapabilityAnswer(q, '选A')).toBe(true)
    expect(checkCapabilityAnswer(q, '答案是 A。')).toBe(true)
    expect(checkCapabilityAnswer(q, 'abandon')).toBe(false)
    expect(checkCapabilityAnswer(q, '选B更合适')).toBe(false)
  })

  it('should handle numbers with thousand separators', () => {
    expect(checkCapabilityAnswer({ type: 'number', answer: 2000 }, '2,000')).toBe(true)
    expect(checkCapabilityAnswer({ type: 'number', answer: 731 }, '答案是 731。')).toBe(true)
    expect(checkCapabilityAnswer({ type: 'number', answer: 731 }, '没法计算')).toBe(false)
  })

  it('should check keyword answers requiring all keywords', () => {
    const q = { type: 'keyword', answer: ['造纸', '印刷', '火药', '指南针'] }
    expect(checkCapabilityAnswer(q, '四大发明：造纸术、印刷术、火药、指南针。')).toBe(true)
    expect(checkCapabilityAnswer(q, '只有造纸术和印刷术。')).toBe(false)
  })

  it('should grade percentages', () => {
    expect(gradeOf(100).label).toBe('优秀')
    expect(gradeOf(80).label).toBe('良好')
    expect(gradeOf(65).label).toBe('中等')
    expect(gradeOf(30).label).toBe('待提升')
  })
})

describe('evalApi data integrity', () => {
  it('question bank has unique ids and valid dimensions/types/difficulty', () => {
    const ids = new Set()
    for (const q of QUESTION_BANK) {
      expect(ids.has(q.id), `duplicate id ${q.id}`).toBe(false)
      ids.add(q.id)
      expect(['number', 'choice', 'keyword', 'regex', 'code']).toContain(q.type)
      expect(CAPABILITY_DIMENSIONS.some((d) => d.id === q.dimension)).toBe(true)
      expect(Number.isInteger(q.difficulty)).toBe(true)
      expect(q.difficulty).toBeGreaterThanOrEqual(1)
      expect(q.difficulty).toBeLessThanOrEqual(5)
      expect(typeof q.prompt).toBe('string')
      expect(q.prompt.length).toBeGreaterThan(0)
      if (q.type === 'keyword') expect(q.answer.length).toBeGreaterThan(0)
    }
    expect(ids.size).toBe(QUESTION_BANK.length)
    expect(QUESTION_BANK.length).toBeGreaterThanOrEqual(12)
  })

  it('fingerprint probes and library are consistent', () => {
    const probeIds = new Set(FINGERPRINT_PROBES.map((p) => p.id))
    for (const family of FINGERPRINT_LIBRARY) {
      for (const key of Object.keys(family.markers)) {
        expect(probeIds.has(key), `unknown probe ${key} for ${family.id}`).toBe(true)
        expect(Array.isArray(family.markers[key])).toBe(true)
        for (const re of family.markers[key]) {
          expect(re).toBeInstanceOf(RegExp)
        }
      }
      expect(Object.keys(family.markers).length).toBeGreaterThan(0)
    }
    expect(FINGERPRINT_PROBES.length).toBeGreaterThanOrEqual(4)
  })
})

describe('runConsistencyTest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const correctFor = (prompt) => {
    if (prompt.includes('17 + 28')) return '45'
    if (prompt.includes('9.11')) return '9.8'
    return '3'
  }

  it('reports full agreement when every sample is stable and correct', async () => {
    mockChat((prompt) => correctFor(prompt))
    const result = await runConsistencyTest(mockConfig, 'm', { rounds: 4, concurrency: 2 })

    expect(result.agreement).toBe(100)
    expect(result.accuracy).toBe(100)
    expect(result.verdict.label).toBe('一致性好')
    expect(result.probes).toHaveLength(3)
  })

  it('flags 前后矛盾 when answers alternate', async () => {
    const counters = new Map()
    mockChat((prompt) => {
      const n = (counters.get(prompt) || 0) + 1
      counters.set(prompt, n)
      return n % 2 === 0 ? correctFor(prompt) : '不知道'
    })

    const result = await runConsistencyTest(mockConfig, 'm', { rounds: 4, concurrency: 1 })

    expect(result.agreement).toBe(50)
    expect(result.verdict.label).toBe('前后矛盾')
  })

  it('flags 稳定答错 when answers are consistent but wrong', async () => {
    mockChat(() => '不知道')
    const result = await runConsistencyTest(mockConfig, 'm', { rounds: 3, concurrency: 1 })

    expect(result.agreement).toBe(100)
    expect(result.accuracy).toBe(0)
    expect(result.verdict.label).toBe('稳定答错')
  })

  it('ignores failed samples when computing rates', async () => {
    let calls = 0
    mockChat((prompt) => {
      calls += 1
      if (calls === 1) throw { response: { status: 500 } }
      return correctFor(prompt)
    })

    const result = await runConsistencyTest(mockConfig, 'm', { rounds: 2, concurrency: 1 })
    const failed = result.probes.reduce((sum, p) => sum + p.failed, 0)

    expect(failed).toBeGreaterThanOrEqual(1)
    expect(result.accuracy).toBe(100)
  })

  it('maps verdicts from agreement and accuracy', () => {
    expect(consistencyVerdict(95, 95).label).toBe('一致性好')
    expect(consistencyVerdict(40, 90).label).toBe('前后矛盾')
    expect(consistencyVerdict(90, 30).label).toBe('稳定答错')
    expect(consistencyVerdict(80, 80).label).toBe('轻微抖动')
  })
})
