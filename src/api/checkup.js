import { getApiAdapter, apiModeLabel } from './modes.js'
import {
  runFingerprintMatch,
  runCapabilityTest,
  runStabilityTest,
  runConsistencyTest,
} from './evalApi.js'
import { computeVerdict, buildCheckupMarkdown } from '../utils/report.js'

// 一键体检：连通 → 模型列表 → 抽样测速 → 指纹 → 能力 → 稳定性 → 结论 + 报告
// 任一步失败都不中断，尽量把已有信息沉淀成报告。
export async function runCheckup(
  config,
  { model, sampleSize = 5, stabilityRounds = 5, consistencyRounds = 3, onProgress } = {},
) {
  const startedAt = Date.now()
  const adapter = getApiAdapter(config.apiMode)
  const emit = (stage, label, index) => onProgress?.({ stage, label, index, total: 7 })

  const checkup = {
    startedAt: new Date(startedAt).toISOString(),
    config: {
      provider: config.provider || '',
      baseUrl: config.baseUrl || '',
      apiMode: config.apiMode || '',
      apiModeLabel: apiModeLabel(config.apiMode),
      model: (model || '').trim(),
    },
    connection: { connected: false, connectTime: 0, error: '未执行' },
    models: { total: 0, list: [] },
    speed: { tested: 0, success: 0, avgLatency: 0, fastest: null, sample: [] },
    fingerprint: null,
    capability: null,
    stability: null,
    consistency: null,
  }

  emit('connect', '测试连通性', 0)
  try {
    checkup.connection = await adapter.testConnection(config)
  } catch (error) {
    checkup.connection = { connected: false, connectTime: 0, error: error.message }
  }

  if (!checkup.connection?.connected) {
    checkup.finishedAt = new Date().toISOString()
    checkup.durationMs = Date.now() - startedAt
    checkup.verdict = computeVerdict(checkup)
    checkup.report = buildCheckupMarkdown(checkup)
    emit('done', '连通失败，已生成报告', 7)
    return checkup
  }

  emit('models', '获取模型列表', 1)
  let models = []
  try {
    const listed = await adapter.listModels(config)
    models = (listed.models || []).map((m) => m.id).filter(Boolean)
  } catch {
    // 列表失败不影响后续单模型体检
  }
  checkup.models = { total: models.length, list: models.slice(0, 200) }

  emit('speed', '抽样测速', 2)
  const sampleModels = models.slice(0, Math.max(1, sampleSize))
  let speedResults = []
  if (sampleModels.length > 0) {
    try {
      speedResults = await adapter.testModels(config, sampleModels, 5)
    } catch {
      speedResults = []
    }
  }

  const okResults = speedResults.filter((r) => r.status === 'success')
  const fastest = [...okResults].sort((a, b) => a.latency - b.latency)[0] || null
  checkup.speed = {
    tested: speedResults.length,
    success: okResults.length,
    avgLatency: okResults.length
      ? Math.round(okResults.reduce((sum, r) => sum + r.latency, 0) / okResults.length)
      : 0,
    fastest: fastest ? { model: fastest.model, latency: fastest.latency } : null,
    sample: speedResults,
  }

  const target = checkup.config.model || fastest?.model || models[0] || ''
  checkup.config.model = target

  if (target) {
    emit('fingerprint', `指纹匹配：${target}`, 3)
    try {
      checkup.fingerprint = await runFingerprintMatch(config, target, {
        onProgress: (p) => emit('fingerprint', `指纹匹配 ${p.done}/${p.total}`, 3),
      })
    } catch (error) {
      checkup.fingerprintError = error.message
    }

    emit('capability', '能力测评', 4)
    try {
      checkup.capability = await runCapabilityTest(config, target, {
        onProgress: (p) => emit('capability', `能力测评 ${p.done}/${p.total}`, 4),
      })
    } catch (error) {
      checkup.capabilityError = error.message
    }

    emit('stability', '稳定性采样', 5)
    try {
      checkup.stability = await runStabilityTest(config, target, {
        rounds: stabilityRounds,
        onProgress: (p) => emit('stability', `稳定性 ${p.done}/${p.total}`, 5),
      })
    } catch (error) {
      checkup.stabilityError = error.message
    }

    emit('consistency', '一致性探测', 6)
    try {
      checkup.consistency = await runConsistencyTest(config, target, {
        rounds: consistencyRounds,
        onProgress: (p) => emit('consistency', `一致性 ${p.done}/${p.total}`, 6),
      })
    } catch (error) {
      checkup.consistencyError = error.message
    }
  }

  checkup.finishedAt = new Date().toISOString()
  checkup.durationMs = Date.now() - startedAt
  checkup.verdict = computeVerdict(checkup)
  checkup.report = buildCheckupMarkdown(checkup)
  emit('done', '体检完成', 7)

  return checkup
}

// 存档用精简版：去掉逐题明细与探测原文，避免 history.json 迅速膨胀
export function toHistoryCheckup(checkup) {
  if (!checkup) return null
  return {
    finishedAt: checkup.finishedAt,
    durationMs: checkup.durationMs,
    model: checkup.config?.model || '',
    verdict: checkup.verdict || null,
    capability: checkup.capability
      ? {
          overall: checkup.capability.overall,
          grade: checkup.capability.grade,
          correctCount: checkup.capability.correctCount,
          total: checkup.capability.total,
          dimensions: (checkup.capability.dimensions || []).map((d) => ({
            name: d.name,
            score: d.score,
            correct: d.correct,
            total: d.total,
          })),
        }
      : null,
    fingerprint: checkup.fingerprint
      ? {
          bestName: checkup.fingerprint.bestName,
          bestPercent: checkup.fingerprint.bestPercent,
          matches: (checkup.fingerprint.matches || []).slice(0, 3),
        }
      : null,
    consistency: checkup.consistency
      ? {
          agreement: checkup.consistency.agreement,
          accuracy: checkup.consistency.accuracy,
          verdict: checkup.consistency.verdict,
        }
      : null,
    stability: checkup.stability
      ? {
          rounds: checkup.stability.rounds,
          successRate: checkup.stability.successRate,
          failed: checkup.stability.failed,
          rateLimited: checkup.stability.rateLimited,
          p50: checkup.stability.p50,
          p95: checkup.stability.p95,
        }
      : null,
    report: checkup.report || '',
  }
}
