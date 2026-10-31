import { getApiAdapter } from './modes.js'
import { verifyCodeAnswer } from './codeSandbox.js'
import { FINGERPRINT_PROBES, FINGERPRINT_LIBRARY } from '../data/fingerprints.js'
import { CAPABILITY_DIMENSIONS, buildQuestionSet, BANK_VERSION } from '../data/questionBank.js'

const MAX_TOKENS = 200
const PROBE_TIMEOUT = 15000 // 单次调用超时（真实模型受网络/负载影响可能较慢）
const RETRY_DELAY_MS = 2000 // 超时/限流后的重试间隔
const THROTTLE_CAP_MS = 3000 // 限流等待上限（忽略过长的 Retry-After）
// 整轮测评兜底总时限：正常提供商（如 OpenAI/Gemini）通常几十秒内完成；
// 对限流极严的提供商，到时返回已完成部分并标注未完成题目，不再整轮失败
const EVAL_TIMEOUT_MS = 120000
// 并发设为 2：贴近真人逐问，避免高并发触发网关限流(429)导致大面积失败
const CAPABILITY_CONCURRENCY = 2
const FINGERPRINT_CONCURRENCY = 2
// 单题最多尝试次数：防止持续 5xx/网络错误时无限重试，未完成的题按 incomplete 处理
const MAX_ATTEMPTS = 3

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 单次调用模型，返回 { ok, text } 或 { ok, error, transient, cancelled }
// transient=true 表示可重试（超时/限流/网络/5xx）
async function ask(config, model, prompt, { timeout = PROBE_TIMEOUT } = {}) {
  const adapter = getApiAdapter(config.apiMode)

  try {
    const text = await adapter.chat(config, {
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS,
      timeout,
    })
    return { ok: true, text: String(text ?? '') }
  } catch (error) {
    if (error?.name === 'CanceledError' || error?.name === 'AbortError') {
      return { ok: false, cancelled: true, error: '请求已取消' }
    }
    const status = error?.response?.status
    // 404 在测评场景多为网关限流/过载伪装，同样按可恢复处理
    const transient =
      status == null ||
      status === 404 ||
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status >= 500

    let retryAfter = 0
    if (status === 429) {
      const raw = error?.response?.headers?.['retry-after']
      const seconds = raw != null ? Number(raw) : NaN
      retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
    }

    const providerMessage =
      typeof error?.response?.data?.error === 'string'
        ? error.response.data.error
        : error?.response?.data?.error?.message

    return {
      ok: false,
      transient,
      retryAfter,
      error: providerMessage || error?.message || '请求失败',
    }
  }
}

// 对全部题目执行：瞬时失败（超时/限流/404/5xx）延迟重试直到答完；
// 兜底 deadline 到期仍有个别未完成时，返回已完成部分 + incompleteIds（不再整轮失败）。
async function completeEval(
  config,
  model,
  items,
  { concurrency, deadline, retryDelayMs = RETRY_DELAY_MS, maxAttempts = MAX_ATTEMPTS, onProgress },
) {
  const results = new Array(items.length).fill(null)
  const attempts = new Array(items.length).fill(0)
  const lastErrors = new Array(items.length).fill('')
  // 轮转队列：失败的题排到队尾，避免前几题持续失败时把后面的题饿死
  const queue = Array.from({ length: items.length }, (_, i) => i)
  let done = 0
  const report = () => onProgress?.({ done, total: items.length })
  // 遇到限流后的全局节流时间点
  let throttleUntil = 0

  while (queue.length > 0) {
    if (deadline && Date.now() >= deadline) break

    if (Date.now() < throttleUntil) {
      await delay(Math.min(throttleUntil - Date.now(), THROTTLE_CAP_MS))
      if (deadline && Date.now() >= deadline) break
    }

    const batch = queue.splice(0, concurrency)
    await Promise.all(
      batch.map(async (index) => {
        const res = await ask(config, model, items[index].prompt)
        if (res.ok || res.cancelled || !res.transient) {
          results[index] = res
          done++
          report()
          return
        }
        // 瞬时失败：本轮未完成，排到队尾稍后重试；并设置全局节流（尊重 Retry-After 但设上限）
        attempts[index] += 1
        lastErrors[index] = res.error || ''
        if (attempts[index] < maxAttempts) {
          queue.push(index)
          throttleUntil = Math.max(
            throttleUntil,
            Date.now() + Math.min(res.retryAfter || retryDelayMs, THROTTLE_CAP_MS),
          )
        }
      }),
    )
  }

  const incompleteIds = []
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      const suffix = lastErrors[i] ? `：${lastErrors[i]}` : ''
      results[i] = {
        ok: false,
        transient: true,
        error: `测评未完成（已尝试 ${attempts[i]} 次${suffix}）`,
      }
      incompleteIds.push(i)
    }
  }

  return { results, incompleteIds }
}

// ---------- 模型指纹匹配 ----------

export async function runFingerprintMatch(
  config,
  model,
  {
    concurrency = FINGERPRINT_CONCURRENCY,
    timeoutMs = EVAL_TIMEOUT_MS,
    retryDelayMs = RETRY_DELAY_MS,
    maxAttempts = MAX_ATTEMPTS,
    onProgress,
  } = {},
) {
  // 即使调用方传 0 也保留兜底时限，避免无 deadline 时无限重试
  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : EVAL_TIMEOUT_MS)
  const { results, incompleteIds } = await completeEval(config, model, FINGERPRINT_PROBES, {
    concurrency,
    deadline,
    retryDelayMs,
    maxAttempts,
    onProgress,
  })

  const answers = results.map((res, i) => ({ probe: FINGERPRINT_PROBES[i], ...res }))

  // 按加权命中计算各家族匹配度：命中权重/适用权重。自述类探测词权重更高。
  const matches = FINGERPRINT_LIBRARY.map((family) => {
    let applicable = 0
    let matched = 0
    let weightApplicable = 0
    let weightMatched = 0

    for (const item of answers) {
      const markers = family.markers[item.probe.id]
      if (!markers || markers.length === 0) continue

      const weight = item.probe.weight || 1
      applicable++
      weightApplicable += weight

      if (item.ok && markers.some((re) => re.test(item.text))) {
        matched++
        weightMatched += weight
      }
    }

    const percent = weightApplicable > 0 ? Math.round((weightMatched / weightApplicable) * 100) : 0

    return { id: family.id, name: family.name, matched, applicable, percent }
  })
    .filter((m) => m.applicable > 0)
    .sort((a, b) => b.percent - a.percent || b.matched - a.matched)

  const top = matches.find((m) => m.percent > 0) || null
  return {
    model,
    best: top?.id || null,
    bestName: top?.name || null,
    bestPercent: top?.percent || 0,
    matches,
    incompleteCount: incompleteIds.length,
    answers: answers.map((item) => ({
      probe: item.probe.id,
      weight: item.probe.weight || 1,
      prompt: item.probe.prompt,
      answer: item.ok ? item.text : '',
      cancelled: item.cancelled || undefined,
      error: item.ok ? undefined : item.error,
    })),
  }
}

// ---------- 能力题库测评 ----------

// 统一全角字符（含全角标点/数字）与空白，避免“答案：４”这类写法判错
function normalize(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function extractNumbers(value) {
  // 先归一化全角数字（７０２ → 702），再提取
  const raw = normalize(value).replace(/,/g, '')
  const matches = raw.match(/-?\d+(?:\.\d+)?/g)
  return matches ? matches.map(Number).filter(Number.isFinite) : []
}

export function checkCapabilityAnswer(question, response) {
  const text = normalize(response)

  switch (question.type) {
    case 'number': {
      // 只要回复中出现过正确答案即算对：
      // 避免“17 × 43 - 29 = 702”被取到第一个数字 17 而误判
      const tolerance = question.tolerance ?? 1e-6
      return extractNumbers(response).some((n) => Math.abs(n - question.answer) <= tolerance)
    }
    case 'choice': {
      const answerList = Array.isArray(question.answer) ? question.answer : [question.answer]
      // 选项需以独立字符/短语出现（或被“选X/答案X”包裹），避免字母误匹配到句子里的单词
      return answerList.some((a) => {
        const na = normalize(a)
        if (!na) return false
        if (/^[a-z0-9]+$/i.test(na)) {
          return new RegExp(`(^|[^a-z0-9])${na}([^a-z0-9]|$)`).test(text)
        }
        return text.includes(na)
      })
    }
    case 'keyword':
      return question.answer.every((a) => text.includes(normalize(a)))
    case 'regex':
      return question.answer.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(String(response || ''))
        } catch {
          return false
        }
      })
    default:
      return false
  }
}

export function gradeOf(percent) {
  if (percent >= 90) return { label: '优秀', color: 'success' }
  if (percent >= 75) return { label: '良好', color: 'success' }
  if (percent >= 60) return { label: '中等', color: 'warning' }
  return { label: '待提升', color: 'danger' }
}

// 最近秩法分位数：样本量小时也能给出稳定的 P95
export function percentile(values, p) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export async function runCapabilityTest(
  config,
  model,
  {
    concurrency = CAPABILITY_CONCURRENCY,
    timeoutMs = EVAL_TIMEOUT_MS,
    retryDelayMs = RETRY_DELAY_MS,
    maxAttempts = MAX_ATTEMPTS,
    onProgress,
    questions,
    seed,
  } = {},
) {
  // 默认使用「静态题 + 随机模板题」的组合，避免被训练数据背住；
  // 调用方也可传入固定题目集（测试或复现某次测评）
  const usedSeed = questions ? null : (seed ?? Date.now())
  const questionSet = questions || buildQuestionSet({ seed: usedSeed })

  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : EVAL_TIMEOUT_MS)
  const { results, incompleteIds } = await completeEval(config, model, questionSet, {
    concurrency,
    deadline,
    retryDelayMs,
    maxAttempts,
    onProgress,
  })

  let earned = 0
  let max = 0
  let correctCount = 0
  let skippedCount = 0
  const dimMap = new Map()

  for (let i = 0; i < results.length; i++) {
    const res = results[i]
    const q = questionSet[i]
    let correct = false
    let execution = null

    if (q.type === 'code') {
      // 代码题不看关键词，直接丢进本地沙箱跑测试用例
      if (res.ok) {
        execution = await verifyCodeAnswer(q, res.text)
      }
      if (!execution || !execution.executed) {
        // 执行不可用（环境不支持 / 静态检查拒绝）：不计入分母，避免误伤
        skippedCount++
      } else {
        correct = execution.passed
      }
    } else {
      correct = res.ok ? checkCapabilityAnswer(q, res.text) : false
    }

    const scored = q.type !== 'code' || (execution && execution.executed)

    if (scored) {
      max += q.difficulty
      if (correct) {
        earned += q.difficulty
        correctCount++
      }
    }

    if (!dimMap.has(q.dimension)) {
      dimMap.set(q.dimension, {
        dimension: q.dimension,
        correct: 0,
        total: 0,
        earned: 0,
        max: 0,
        questions: [],
      })
    }
    const dim = dimMap.get(q.dimension)
    dim.total++
    if (scored) {
      dim.max += q.difficulty
      if (correct) {
        dim.correct++
        dim.earned += q.difficulty
      }
    }
    dim.questions.push({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
      correct,
      skipped: !scored || undefined,
      execution: execution
        ? {
            executed: execution.executed,
            passed: execution.passed,
            reason: execution.reason,
            results: execution.results,
          }
        : undefined,
      answer: res.ok ? res.text : '',
      error: res.ok ? undefined : res.error,
    })
  }

  const overall = max > 0 ? Math.round((earned / max) * 100) : 0
  const dimensions = CAPABILITY_DIMENSIONS.map((d) => {
    const data = dimMap.get(d.id) || { correct: 0, total: 0, earned: 0, max: 0, questions: [] }
    return {
      ...d,
      correct: data.correct,
      total: data.total,
      earned: data.earned,
      max: data.max,
      score: data.max > 0 ? Math.round((data.earned / data.max) * 100) : 0,
      questions: data.questions,
    }
  }).filter((d) => d.total > 0)

  return {
    model,
    overall,
    grade: gradeOf(overall),
    correctCount,
    total: results.length,
    answered: results.length - incompleteIds.length,
    incompleteCount: incompleteIds.length,
    generatedCount: questionSet.filter((q) => q.generated).length,
    bankVersion: BANK_VERSION,
    codeCount: questionSet.filter((q) => q.type === 'code').length,
    skippedCount,
    seed: usedSeed,
    dimensions,
  }
}

// ---------- 一致性探测 ----------
// 同一问题重复采样，区分两种典型故障：
//   - 前后矛盾（agreement 低）：疑似多模型轮换 / 负载分流
//   - 稳定答错（accuracy 低但 agreement 高）：疑似降级成小模型

export const CONSISTENCY_PROBES = [
  { id: 'add', prompt: '只回答数字：17 + 28 = ?', expected: '45' },
  { id: 'compare', prompt: '9.11 和 9.8 哪个更大？只回答较大的那个数字。', expected: '9.8' },
  { id: 'count', prompt: '单词 "strawberry" 里有几个字母 r？只回答数字。', expected: '3' },
]

// 把回答归一成「答案标签」：命中预期值就记成预期值，否则记为 other:<首个数字>
// 这样 "9.8 比 9.11 大" 与 "9.8" 会被视为同一个答案
function canonicalizeAnswer(probe, text) {
  const numbers = extractNumbers(text).map(String)
  if (numbers.includes(probe.expected)) return probe.expected
  if (numbers.length > 0) return `other:${numbers[0]}`
  return `text:${normalize(text).slice(0, 20)}`
}

export function consistencyVerdict(agreement, accuracy, validCount) {
  // 全部采样失败时不能推断“轮换”或“降级”，否则会把网络/鉴权故障误报成模型问题
  if (validCount === 0) {
    return {
      label: '无法判定',
      color: 'warning',
      note: '所有采样均失败（网络/鉴权/限流），未获得有效回答，无法判断一致性',
    }
  }
  if (accuracy >= 90 && agreement >= 90) {
    return { label: '一致性好', color: 'success', note: '多次采样结果稳定且正确' }
  }
  if (agreement < 60) {
    return {
      label: '前后矛盾',
      color: 'danger',
      note: '同一问题答案不一致，疑似多模型轮换或负载分流',
    }
  }
  if (accuracy < 60) {
    return { label: '稳定答错', color: 'danger', note: '答案一致但错误，疑似降级为小模型' }
  }
  return { label: '轻微抖动', color: 'warning', note: '存在少量不一致，建议错峰复测' }
}

export async function runConsistencyTest(
  config,
  model,
  { rounds = 4, concurrency = 2, onProgress } = {},
) {
  const totalRounds = Math.max(1, rounds)
  const totalCalls = CONSISTENCY_PROBES.length * totalRounds
  let done = 0
  const probes = []

  for (const probe of CONSISTENCY_PROBES) {
    const answers = new Array(totalRounds).fill(null)

    for (let start = 0; start < totalRounds; start += concurrency) {
      const batch = []
      for (let i = start; i < Math.min(start + concurrency, totalRounds); i++) {
        batch.push(
          ask(config, model, probe.prompt).then((res) => {
            answers[i] = res
            done += 1
            onProgress?.({ done, total: totalCalls })
          }),
        )
      }
      await Promise.all(batch)
    }

    const canonicals = answers.map((res) =>
      res?.ok ? canonicalizeAnswer(probe, res.text) : 'error',
    )
    const valid = canonicals.filter((c) => c !== 'error')

    const counts = new Map()
    for (const c of valid) counts.set(c, (counts.get(c) || 0) + 1)
    const majority = counts.size > 0 ? Math.max(...counts.values()) : 0

    probes.push({
      id: probe.id,
      prompt: probe.prompt,
      expected: probe.expected,
      answers: canonicals,
      agreement: valid.length ? Math.round((majority / valid.length) * 100) : 0,
      accuracy: valid.length
        ? Math.round((valid.filter((c) => c === probe.expected).length / valid.length) * 100)
        : 0,
      validCount: valid.length,
      uniqueCount: counts.size,
      failed: totalRounds - valid.length,
    })
  }

  const average = (list) =>
    list.length ? Math.round(list.reduce((sum, v) => sum + v, 0) / list.length) : 0

  const agreement = average(probes.map((p) => p.agreement))
  const accuracy = average(probes.map((p) => p.accuracy))
  const validCount = probes.reduce((sum, p) => sum + p.validCount, 0)

  return {
    model,
    rounds: totalRounds,
    probes,
    agreement,
    accuracy,
    validCount,
    failedSamples: totalCalls - validCount,
    verdict: consistencyVerdict(agreement, accuracy, validCount),
  }
}

// ---------- 稳定性 / 限速探测 ----------
// 固定短 prompt 连续打 N 次，统计成功率与延迟分位；429 单独计数，用来判断限流阈值

export async function runStabilityTest(
  config,
  model,
  { rounds = 5, concurrency = 2, timeoutMs = 30000, onProgress } = {},
) {
  const adapter = getApiAdapter(config.apiMode)
  const total = Math.max(1, rounds)
  const results = new Array(total).fill(null)
  const queue = Array.from({ length: total }, (_, i) => i)
  let done = 0
  let cancelled = false

  async function worker() {
    while (queue.length > 0 && !cancelled) {
      const index = queue.shift()
      const startedAt = Date.now()

      try {
        await adapter.chat(config, {
          model,
          messages: [{ role: 'user', content: '只回复 ok' }],
          maxTokens: 8,
          timeout: timeoutMs,
        })
        results[index] = { ok: true, latency: Date.now() - startedAt }
      } catch (error) {
        const isCancel =
          error?.name === 'CanceledError' ||
          error?.name === 'AbortError' ||
          error?.code === 'ERR_CANCELED'
        if (isCancel) cancelled = true
        results[index] = {
          ok: false,
          cancelled: isCancel || undefined,
          latency: Date.now() - startedAt,
          status: error?.response?.status,
          rateLimited: error?.response?.status === 429 || undefined,
          error: error?.response?.data?.error?.message || error?.message || '请求失败',
        }
      }

      done++
      onProgress?.({ done, total })
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), total) }, () => worker()),
  )

  const finished = results.filter(Boolean)
  const success = finished.filter((r) => r.ok)
  const failed = finished.filter((r) => !r.ok)
  const rateLimited = finished.filter((r) => r.rateLimited)
  const latencies = success.map((r) => r.latency)
  const avg = latencies.length
    ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
    : 0

  return {
    model,
    rounds: finished.length,
    success: success.length,
    failed: failed.length,
    rateLimited: rateLimited.length,
    cancelled: cancelled || undefined,
    successRate: finished.length ? Math.round((success.length / finished.length) * 100) : 0,
    avg,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    min: latencies.length ? Math.min(...latencies) : 0,
    max: latencies.length ? Math.max(...latencies) : 0,
    errors: [...new Set(failed.map((r) => r.error))].slice(0, 5),
  }
}
