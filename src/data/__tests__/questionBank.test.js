import { describe, it, expect } from 'vitest'
import {
  QUESTION_BANK,
  QUESTION_TEMPLATES,
  PROMPT_VARIANTS,
  BANK_VERSION,
  buildQuestionSet,
  createSeededRng,
  CAPABILITY_DIMENSIONS,
} from '../questionBank.js'

const SEEDS = [1, 7, 42, 2026, 99999]

function templateOf(id) {
  return QUESTION_TEMPLATES.find((t) => t.id === id)
}

function built(id, seed) {
  const rng = createSeededRng(seed)
  // 模板按声明顺序消耗同一个 rng，逐个推进以保持与 buildQuestionSet 一致
  let result = null
  for (const tpl of QUESTION_TEMPLATES) {
    const q = tpl.build(rng)
    if (tpl.id === id) result = q
  }
  return result
}

describe('seeded rng', () => {
  it('is deterministic for the same seed', () => {
    const a = createSeededRng(123)
    const b = createSeededRng(123)
    const seqA = Array.from({ length: 5 }, () => a())
    const seqB = Array.from({ length: 5 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('produces values in [0, 1)', () => {
    const rng = createSeededRng(7)
    for (let i = 0; i < 200; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('buildQuestionSet', () => {
  it('appends one generated question per template', () => {
    const set = buildQuestionSet({ seed: 42 })
    expect(set.length).toBe(QUESTION_BANK.length + QUESTION_TEMPLATES.length)
    expect(set.filter((q) => q.generated)).toHaveLength(QUESTION_TEMPLATES.length)
  })

  it('is reproducible with the same seed and varies across seeds', () => {
    const a = buildQuestionSet({ seed: 42 })
    const b = buildQuestionSet({ seed: 42 })
    const c = buildQuestionSet({ seed: 43 })

    expect(a.map((q) => q.prompt)).toEqual(b.map((q) => q.prompt))
    expect(a.map((q) => q.answer)).toEqual(b.map((q) => q.answer))
    expect(a.map((q) => q.prompt)).not.toEqual(c.map((q) => q.prompt))
  })

  it('can generate templates only', () => {
    const set = buildQuestionSet({ seed: 5, includeStatic: false })
    expect(set).toHaveLength(QUESTION_TEMPLATES.length)
    expect(set.every((q) => q.generated)).toBe(true)
  })

  it('keeps ids unique and dimensions valid', () => {
    const set = buildQuestionSet({ seed: 2026 })
    const ids = new Set(set.map((q) => q.id))
    expect(ids.size).toBe(set.length)

    const dimensionIds = new Set(CAPABILITY_DIMENSIONS.map((d) => d.id))
    for (const q of set) {
      expect(dimensionIds.has(q.dimension)).toBe(true)
      expect(q.difficulty).toBeGreaterThanOrEqual(1)
      expect(q.difficulty).toBeLessThanOrEqual(5)
      expect(typeof q.prompt).toBe('string')
      expect(q.prompt.length).toBeGreaterThan(0)
    }
  })
})

describe('generated answers are consistent with the prompts', () => {
  it('追及问题：追及时间 = 距离差 / 速度差', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_chase', seed)
      const [, fast, slow, gap] = q.prompt.match(
        /甲车速度(\d+)km\/h，乙车速度(\d+)km\/h，甲车落后乙车(\d+)公里/,
      )
      expect(q.answer).toBe(Number(gap) / (Number(fast) - Number(slow)))
    }
  })

  it('工程问题：1/a + 1/b = 1/t', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_work', seed)
      const [, a, b] = q.prompt.match(/甲单独做要 (\d+) 天，乙单独做要 (\d+) 天/)
      expect(1 / Number(a) + 1 / Number(b)).toBeCloseTo(1 / q.answer, 6)
    }
  })

  it('涨跌还原：(1+up)(1-down) 与答案一致', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_percent', seed)
      const [, up, down] = q.prompt.match(/先涨价 (\d+)%，再在涨价后的价格上降价 (\d+)%/)
      expect(q.answer).toBe(Math.round((1 + up / 100) * (1 - down / 100) * 100))
    }
  })

  it('年龄问题：n 年后父亲正好是儿子的 2 倍', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_age', seed)
      const [, father, son] = q.prompt.match(/父亲今年(\d+)岁，儿子今年(\d+)岁/)
      expect(Number(father) + q.answer).toBe(2 * (Number(son) + q.answer))
    }
  })

  it('鸡兔同笼：腿数 = 2 * 头数 + 2 * 兔子数', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_chicken', seed)
      const [, heads, legs] = q.prompt.match(/共有(\d+)个头、(\d+)条腿/)
      expect(Number(legs)).toBe(2 * Number(heads) + 2 * q.answer)
      expect(q.answer).toBeLessThan(Number(heads))
    }
  })

  it('钟面夹角：与 30h - 5.5m 一致且不超过 180', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_clock', seed)
      const [, h, m] = q.prompt.match(/显示 (\d+):(\d+) 时/)
      const raw = Math.abs(30 * Number(h) - 5.5 * Number(m))
      expect(q.answer).toBe(Math.round(raw > 180 ? 360 - raw : raw))
      expect(q.answer).toBeGreaterThanOrEqual(0)
      expect(q.answer).toBeLessThanOrEqual(180)
    }
  })

  it('数列：公差恒定，下一项正确', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_sequence', seed)
      const terms = q.prompt
        .match(/数列 ([\d, ]+), \?/)[1]
        .split(',')
        .map((n) => Number(n.trim()))
      const step = terms[1] - terms[0]
      terms.forEach((n, i) => expect(n).toBe(terms[0] + i * step))
      expect(q.answer).toBe(terms[0] + 5 * step)
    }
  })

  it('保证取球：答案 = 蓝球数 + 1', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_guarantee', seed)
      const [, , blue] = q.prompt.match(/有(\d+)个红球和(\d+)个蓝球/)
      expect(q.answer).toBe(Number(blue) + 1)
    }
  })

  it('条件筛选求和：只累加奇数', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_interference', seed)
      const numbers = q.prompt
        .match(/跳过偶数：([\d, ]+)。/)[1]
        .split(',')
        .map((n) => Number(n.trim()))
      const expected = numbers.filter((n) => n % 2 === 1).reduce((sum, n) => sum + n, 0)
      expect(q.answer).toBe(expected)
      expect(numbers.filter((n) => n % 2 === 1).length).toBe(3)
    }
  })

  it('单位换算：米 * 100', () => {
    for (const seed of SEEDS) {
      const q = built('tpl_unit', seed)
      const meters = Number(q.prompt.match(/([\d.]+) 米等于多少厘米/)[1])
      expect(q.answer).toBe(Math.round(meters * 100))
    }
  })
})

describe('template registry', () => {
  it('every template declares a build function and metadata', () => {
    for (const tpl of QUESTION_TEMPLATES) {
      expect(typeof tpl.build).toBe('function')
      expect(typeof tpl.id).toBe('string')
      expect(tpl.id.startsWith('tpl_')).toBe(true)
      expect(typeof tpl.dimension).toBe('string')
      expect(tpl.difficulty).toBeGreaterThanOrEqual(1)
      expect(tpl.difficulty).toBeLessThanOrEqual(5)
    }
    expect(templateOf('tpl_chase')).toBeTruthy()
  })
})

describe('prompt variants', () => {
  it('always uses a declared variant', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const q of buildQuestionSet({ seed })) {
        const pool = PROMPT_VARIANTS[q.id]
        if (!pool) continue
        expect(pool).toContain(q.prompt)
      }
    }
  })

  it('changes wording across seeds without touching the answer', () => {
    const pick = (seed) => buildQuestionSet({ seed }).filter((q) => PROMPT_VARIANTS[q.id])

    const first = pick(1)
    const second = pick(2)
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map(pick)

    expect(first).toHaveLength(Object.keys(PROMPT_VARIANTS).length)
    first.forEach((q, i) => expect(q.answer).toEqual(second[i].answer))
    expect(many.some((set) => set.some((q, i) => q.prompt !== first[i].prompt))).toBe(true)
  })

  it('exposes a bank version', () => {
    expect(BANK_VERSION).toBeGreaterThanOrEqual(2)
  })
})

describe('code questions', () => {
  it('carry executable test cases', () => {
    const codeQuestions = QUESTION_BANK.filter((q) => q.type === 'code')
    expect(codeQuestions.length).toBeGreaterThanOrEqual(3)
    for (const q of codeQuestions) {
      expect(q.language).toBe('js')
      expect(Array.isArray(q.tests)).toBe(true)
      expect(q.tests.length).toBeGreaterThan(0)
      for (const t of q.tests) {
        expect(t).toHaveProperty('input')
        expect(t).toHaveProperty('expected')
      }
    }
  })
})
