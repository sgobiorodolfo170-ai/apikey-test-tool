// 渠道体检报告：把体检结果转成可复制、可存档的 Markdown。
// 纯函数，不依赖网络与 DOM，方便单测。

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

// 评分口径版本：改动权重/维度时递增，历史记录据此标注，避免跨版本直接比分数
export const SCORE_VERSION = 2
export const SCORE_WEIGHTS = { capability: 0.55, stability: 0.3, consistency: 0.15 }

export function scoreLevel(score) {
  if (score >= 85) return { label: '优秀', color: 'success' }
  if (score >= 70) return { label: '良好', color: 'success' }
  if (score >= 55) return { label: '一般', color: 'warning' }
  return { label: '存疑', color: 'danger' }
}

// 一致性折算成一个分数：一致且正确才算好。
// 稳定答错（100/0）与前后矛盾（50/50）都会落到 50 分左右，再叠加能力分进一步区分。
function consistencyScore(consistency) {
  const agreement = Number(consistency?.agreement) || 0
  const accuracy = Number(consistency?.accuracy) || 0
  return Math.round((agreement + accuracy) / 2)
}

// 评分只看「能力 / 稳定性 / 一致性」：
// 指纹匹配度代表身份识别置信度，不应当作质量分，否则小众模型会被系统性压低。
export function computeVerdict({
  capability,
  stability,
  fingerprint,
  models,
  connection,
  consistency,
}) {
  const notes = []

  if (connection && connection.connected === false) {
    return {
      score: 0,
      level: '不可用',
      color: 'danger',
      scoreVersion: SCORE_VERSION,
      weights: SCORE_WEIGHTS,
      notes: [`连通失败：${connection.error || '未知原因'}`],
    }
  }

  const parts = []
  if (capability) parts.push({ weight: SCORE_WEIGHTS.capability, score: capability.overall })
  if (stability) parts.push({ weight: SCORE_WEIGHTS.stability, score: stability.successRate })
  if (consistency)
    parts.push({ weight: SCORE_WEIGHTS.consistency, score: consistencyScore(consistency) })

  const weightSum = parts.reduce((sum, p) => sum + p.weight, 0)
  const score = weightSum
    ? Math.round(parts.reduce((sum, p) => sum + p.score * p.weight, 0) / weightSum)
    : 0
  const level = scoreLevel(score)

  if (capability) {
    if (capability.overall < 50) {
      notes.push(`能力评分仅 ${capability.overall} 分，明显低于可用模型水平，疑似降智或非原版模型`)
    } else if (capability.overall < 70) {
      notes.push(`能力评分 ${capability.overall} 分，处于中等偏下，建议换时段复测`)
    }
    if (capability.incompleteCount > 0) {
      notes.push(`有 ${capability.incompleteCount} 道题因限流/超时未完成，评分可能偏低`)
    }
  }

  if (stability) {
    if (stability.successRate < 80) {
      notes.push(`稳定性采样成功率 ${stability.successRate}%，失败 ${stability.failed} 次`)
    }
    if (stability.rateLimited > 0) {
      notes.push(`采样期间触发 ${stability.rateLimited} 次 429 限流，并发能力受限`)
    }
    if (stability.p50 > 0 && stability.p95 > stability.p50 * 3) {
      notes.push(`延迟抖动大：P50 ${stability.p50}ms，P95 ${stability.p95}ms`)
    }
  }

  if (consistency) {
    if (consistency.agreement < 60) {
      notes.push(
        `一致性 ${consistency.agreement}%：同一问题答案前后不一致，疑似多模型轮换或负载分流`,
      )
    } else if (consistency.accuracy < 60) {
      notes.push(`一致性探测正确率 ${consistency.accuracy}%：多次采样稳定答错，疑似降级为小模型`)
    }
  }

  if (fingerprint) {
    if (!fingerprint.bestName) {
      notes.push('未能识别模型家族，可能是小众模型或中转改写了系统提示')
    } else if (fingerprint.bestPercent >= 70) {
      notes.push(`指纹与 ${fingerprint.bestName} 匹配度 ${fingerprint.bestPercent}%，身份特征明显`)
    } else {
      notes.push(
        `指纹最接近 ${fingerprint.bestName}（${fingerprint.bestPercent}%），匹配度偏低，需结合能力评分判断`,
      )
    }
  }

  if (models && models.total === 0) {
    notes.push('未能获取模型列表，可能接口不兼容或权限不足')
  }

  if (notes.length === 0) notes.push('各项指标正常')

  return {
    score,
    level: level.label,
    color: level.color,
    scoreVersion: SCORE_VERSION,
    weights: SCORE_WEIGHTS,
    notes,
  }
}

function tableRow(cells) {
  return `| ${cells.join(' | ')} |`
}

export function buildCheckupMarkdown(checkup) {
  if (!checkup) return ''
  const {
    config = {},
    connection = {},
    models = {},
    speed = {},
    fingerprint,
    capability,
    stability,
    consistency,
  } = checkup
  // 允许直接传入原始体检结果（未预先计算 verdict）
  const verdict = checkup.verdict || computeVerdict(checkup)
  const generatedAt = new Date(checkup.finishedAt || Date.now())
  const timeText = generatedAt.toLocaleString('zh-CN', { hour12: false })

  const lines = []
  lines.push('# API 渠道体检报告')
  lines.push('')
  lines.push(`> 生成时间：${timeText} | 耗时：${formatDuration(checkup.durationMs)}`)
  lines.push('')

  lines.push('## 一、体检结论')
  lines.push('')
  if (verdict) {
    lines.push(`**综合评分：${verdict.score} / 100 · ${verdict.level}**`)
    lines.push('')
    const version = verdict.scoreVersion || SCORE_VERSION
    lines.push(
      `> 评分口径 v${version}：能力 ${Math.round(SCORE_WEIGHTS.capability * 100)}% + 稳定性 ${Math.round(
        SCORE_WEIGHTS.stability * 100,
      )}% + 一致性 ${Math.round(SCORE_WEIGHTS.consistency * 100)}%（指纹仅作身份参考）`,
    )
    lines.push('')
    for (const note of verdict.notes || []) lines.push(`- ${note}`)
    lines.push('')
  }

  lines.push('## 二、基本信息')
  lines.push('')
  lines.push(tableRow(['项目', '值']))
  lines.push(tableRow(['---', '---']))
  lines.push(tableRow(['提供商', config.provider || '未命名']))
  lines.push(tableRow(['Base URL', config.baseUrl || '-']))
  lines.push(tableRow(['API 模式', config.apiModeLabel || config.apiMode || '-']))
  lines.push(tableRow(['体检模型', config.model || '-']))
  lines.push(tableRow(['连通状态', connection.connected ? '已连接' : '失败']))
  lines.push(tableRow(['连接耗时', `${connection.connectTime || 0}ms`]))
  lines.push('')

  lines.push('## 三、模型与速度')
  lines.push('')
  lines.push(`- 可用模型：**${models.total ?? 0}** 个`)
  if (speed.tested) {
    lines.push(
      `- 抽样测速：${speed.success}/${speed.tested} 成功，平均 ${speed.avgLatency}ms，最快 ${
        speed.fastest?.model || '-'
      }（${speed.fastest?.latency ?? '-'}ms）`,
    )
  }
  lines.push('')

  const sampled = speed.sample || []
  if (sampled.length > 0) {
    lines.push(tableRow(['模型', '延迟', '状态']))
    lines.push(tableRow(['---', '---', '---']))
    for (const item of sampled) {
      lines.push(
        tableRow([
          item.model,
          item.status === 'success' ? `${item.latency}ms` : '-',
          item.status === 'success' ? '成功' : item.error || '失败',
        ]),
      )
    }
    lines.push('')
  }

  if (fingerprint) {
    lines.push('## 四、模型指纹')
    lines.push('')
    lines.push(
      `- 最佳匹配：**${fingerprint.bestName || '未能识别'}**${
        fingerprint.bestPercent ? `（${fingerprint.bestPercent}%）` : ''
      }`,
    )
    if (fingerprint.matches?.length) {
      const top = fingerprint.matches.slice(0, 3)
      lines.push(`- 前三名：${top.map((m) => `${m.name} ${m.percent}%`).join('、')}`)
    }
    lines.push('')
  }

  if (capability) {
    lines.push('## 五、能力测评')
    lines.push('')
    lines.push(
      `- 综合评分：**${capability.overall} / 100**（${capability.grade?.label || '-'}） 答对 ${capability.correctCount}/${capability.total}`,
    )
    lines.push('')
    lines.push(tableRow(['维度', '得分', '正确/总数']))
    lines.push(tableRow(['---', '---', '---']))
    for (const dim of capability.dimensions || []) {
      lines.push(tableRow([dim.name, String(dim.score), `${dim.correct}/${dim.total}`]))
    }
    lines.push('')
  }

  if (stability) {
    lines.push('## 六、稳定性')
    lines.push('')
    lines.push(
      `- 采样 ${stability.rounds} 次：成功 ${stability.success}，失败 ${stability.failed}，限流 ${stability.rateLimited}`,
    )
    lines.push(
      `- 成功率 **${stability.successRate}%** P50 ${stability.p50}ms P95 ${stability.p95}ms 平均 ${stability.avg}ms`,
    )
    if (stability.errors?.length) {
      lines.push(`- 典型错误：${stability.errors.join('；')}`)
    }
    lines.push('')
  }

  if (consistency) {
    lines.push('## 七、一致性')
    lines.push('')
    lines.push(
      `- 一致率 **${consistency.agreement}%** 正确率 **${consistency.accuracy}%** 结论：${consistency.verdict?.label || '-'}`,
    )
    lines.push(`- ${consistency.verdict?.note || ''}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    `由 API Key 测试工具生成。评分口径 v${SCORE_VERSION}，不同版本的历史报告分数不可直接比较。`,
  )
  lines.push('')

  return lines.join('\n')
}
