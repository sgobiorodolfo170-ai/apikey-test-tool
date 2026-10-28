import { describe, it, expect } from 'vitest'
import { buildChannelComparison, toComparisonMarkdown } from '../comparison.js'

function record(overrides = {}) {
  const {
    id = 'r',
    timestamp = '2026-10-29T01:00:00.000Z',
    baseUrl = 'https://a',
    provider = '渠道A',
    checkup = {},
  } = overrides
  return {
    id,
    timestamp,
    config: { baseUrl, provider, apiMode: 'openai' },
    checkup: {
      model: 'gpt-4o',
      verdict: { score: 80, level: '良好', color: 'success', scoreVersion: 2 },
      capability: { overall: 78 },
      stability: { successRate: 100 },
      consistency: { agreement: 90, accuracy: 90 },
      ...checkup,
    },
  }
}

describe('buildChannelComparison', () => {
  it('keeps only the latest checkup per channel', () => {
    const rows = buildChannelComparison([
      record({
        id: 'new',
        timestamp: '2026-10-29T02:00:00.000Z',
        checkup: { verdict: { score: 88, level: '优秀', color: 'success', scoreVersion: 2 } },
      }),
      record({
        id: 'old',
        timestamp: '2026-10-28T02:00:00.000Z',
        checkup: { verdict: { score: 70, level: '良好', color: 'success', scoreVersion: 2 } },
      }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].score).toBe(88)
    expect(rows[0].delta).toBe(18)
  })

  it('sorts by score descending and separates channels', () => {
    const rows = buildChannelComparison([
      record({
        id: 'a',
        baseUrl: 'https://a',
        provider: '渠道A',
        checkup: { verdict: { score: 62, level: '一般', color: 'warning', scoreVersion: 2 } },
      }),
      record({
        id: 'b',
        baseUrl: 'https://b',
        provider: '渠道B',
        checkup: { verdict: { score: 91, level: '优秀', color: 'success', scoreVersion: 2 } },
      }),
    ])

    expect(rows.map((r) => r.name)).toEqual(['渠道B', '渠道A'])
    expect(rows[0].delta).toBeNull()
  })

  it('prefers the saved channel name over the provider name', () => {
    const rows = buildChannelComparison(
      [record({ baseUrl: 'https://a', provider: '随手填的名字' })],
      [{ id: 'ch1', name: '正式渠道名', baseUrl: 'https://a', apiMode: 'openai' }],
    )

    expect(rows[0].name).toBe('正式渠道名')
  })

  it('folds agreement and accuracy into one consistency score', () => {
    const rows = buildChannelComparison([
      record({ checkup: { consistency: { agreement: 100, accuracy: 40 } } }),
    ])

    expect(rows[0].consistency).toBe(70)
  })

  it('leaves missing dimensions as null', () => {
    const rows = buildChannelComparison([
      record({ checkup: { capability: null, stability: null, consistency: null } }),
    ])

    expect(rows[0].capability).toBeNull()
    expect(rows[0].stability).toBeNull()
    expect(rows[0].consistency).toBeNull()
  })

  it('ignores records without a checkup verdict', () => {
    const rows = buildChannelComparison([
      // 只有连通测试、没跑过体检的记录
      { id: 'plain', timestamp: '2026-10-29T00:00:00.000Z', config: { baseUrl: 'https://c' } },
      {
        id: 'partial',
        timestamp: '2026-10-28T00:00:00.000Z',
        config: { baseUrl: 'https://d' },
        checkup: {},
      },
    ])

    expect(rows).toHaveLength(0)
  })
})

describe('toComparisonMarkdown', () => {
  it('renders a markdown table with the score and dimensions', () => {
    const rows = buildChannelComparison([
      record({
        baseUrl: 'https://a',
        provider: '渠道A',
        checkup: { verdict: { score: 82, level: '良好', color: 'success', scoreVersion: 2 } },
      }),
      record({
        id: 'b',
        baseUrl: 'https://b',
        provider: '渠道B',
        checkup: { verdict: { score: 61, level: '一般', color: 'warning', scoreVersion: 2 } },
      }),
    ])

    const md = toComparisonMarkdown(rows)

    expect(md).toContain('| 渠道 | 综合 | 变化 | 能力 | 稳定性 | 一致性 | 最近体检 |')
    expect(md).toContain('| 渠道A | 82 | - | 78 | 100% | 90 |')
    expect(md).toContain('| 渠道B | 61 | - |')
  })

  it('returns an empty string without rows', () => {
    expect(toComparisonMarkdown([])).toBe('')
  })
})
