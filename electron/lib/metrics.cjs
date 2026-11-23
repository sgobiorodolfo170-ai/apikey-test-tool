// CJS 版指标计算，供 Electron 主进程使用。
// 与 src/core/metrics/usage.js 保持同口径，改动时请同步，契约测试会比对。

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function usageFields(usage) {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: null, outputTokens: null, totalTokens: null }
  }
  const inputTokens = numberOrNull(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.prompt ?? usage.input,
  )
  const outputTokens = numberOrNull(
    usage.completion_tokens ?? usage.output_tokens ?? usage.completion ?? usage.output,
  )
  const totalTokens =
    numberOrNull(usage.total_tokens ?? usage.total) ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens || 0) + (outputTokens || 0)
      : null)
  return { inputTokens, outputTokens, totalTokens }
}

function reasoningFields(usage, explicit) {
  if (explicit !== undefined && explicit !== null) return numberOrNull(explicit) || 0
  return (
    numberOrNull(
      usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.reasoning_tokens,
    ) || 0
  )
}

function computeUsageMetrics({ startedAt, firstTokenAt, endedAt, usage, reasoningTokens } = {}) {
  const start = numberOrNull(startedAt)
  const first = numberOrNull(firstTokenAt)
  const end = numberOrNull(endedAt)
  const { inputTokens, outputTokens, totalTokens } = usageFields(usage)
  const reasoning = reasoningFields(usage, reasoningTokens)
  const hasUsage = inputTokens !== null || outputTokens !== null || totalTokens !== null
  const visibleOutput = outputTokens === null ? null : Math.max(0, outputTokens - reasoning)

  const ttftMs = start !== null && first !== null ? Math.max(0, first - start) : null
  const streamMs = first !== null && end !== null ? Math.max(0, end - first) : null
  const tps =
    streamMs !== null && streamMs > 0 && visibleOutput !== null && visibleOutput > 0
      ? Math.round((visibleOutput / (streamMs / 1000)) * 10) / 10
      : null

  return {
    ttftMs,
    streamMs,
    tps,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: reasoning,
    visibleOutputTokens: visibleOutput,
    usageMissing: !hasUsage,
  }
}

module.exports = { computeUsageMetrics }
