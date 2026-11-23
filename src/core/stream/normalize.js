// 流式事件归一：把 OpenAI / Anthropic / Gemini / Ollama / Responses 的
// 流式事件统一成 StreamEvent { type, text, usage, raw }。
// type: 'delta'（正文增量）| 'usage'（用量）| 'done' | 'error'

export const STREAM_EVENT_TYPES = {
  DELTA: 'delta',
  USAGE: 'usage',
  DONE: 'done',
  ERROR: 'error',
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// 从各家 usage 结构提取统一字段（与 metrics/usage.js 同口径的输入侧）
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = numberOrNull(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = numberOrNull(usage.completion_tokens ?? usage.output_tokens)
  const totalTokens =
    numberOrNull(usage.total_tokens) ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens || 0) + (outputTokens || 0)
      : null)
  const reasoningTokens =
    numberOrNull(
      usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens ??
        usage.reasoning_tokens,
    ) || 0
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null
  return { inputTokens, outputTokens, totalTokens, reasoningTokens }
}

// OpenAI chat.completions / Azure：choices[0].delta.content
function fromOpenAI(json) {
  const choice = json?.choices?.[0]
  const delta = choice?.delta?.content
  if (typeof delta === 'string' && delta) {
    return { type: STREAM_EVENT_TYPES.DELTA, text: delta }
  }
  if (choice?.message?.content) {
    return { type: STREAM_EVENT_TYPES.DELTA, text: choice.message.content }
  }
  if (json?.usage) {
    const usage = normalizeUsage(json.usage)
    if (usage) return { type: STREAM_EVENT_TYPES.USAGE, usage }
  }
  return null
}

// Anthropic messages：content_block_delta.delta.text
function fromAnthropic(json) {
  if (json?.type === 'content_block_delta' && typeof json.delta?.text === 'string') {
    return { type: STREAM_EVENT_TYPES.DELTA, text: json.delta.text }
  }
  if (json?.type === 'message_delta' && json?.usage) {
    const usage = normalizeUsage(json.usage)
    if (usage) return { type: STREAM_EVENT_TYPES.USAGE, usage }
  }
  if (json?.type === 'message_start' && json?.message?.usage) {
    const usage = normalizeUsage(json.message.usage)
    if (usage) return { type: STREAM_EVENT_TYPES.USAGE, usage }
  }
  if (json?.type === 'error') {
    return {
      type: STREAM_EVENT_TYPES.ERROR,
      message: json?.error?.message || '上游流式错误',
    }
  }
  return null
}

// Gemini streamGenerateContent：candidates[0].content.parts[].text
function fromGemini(json) {
  const parts = json?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    const text = parts.map((part) => part?.text || '').join('')
    if (text) return { type: STREAM_EVENT_TYPES.DELTA, text }
  }
  if (json?.usageMetadata) {
    const usage = normalizeUsage({
      prompt_tokens: json.usageMetadata.promptTokenCount,
      completion_tokens: json.usageMetadata.candidatesTokenCount,
      total_tokens: json.usageMetadata.totalTokenCount,
    })
    if (usage) return { type: STREAM_EVENT_TYPES.USAGE, usage }
  }
  return null
}

// Ollama /api/chat（NDJSON）：message.content
function fromOllama(json) {
  const delta = json?.message?.content
  if (typeof delta === 'string' && delta) {
    return { type: STREAM_EVENT_TYPES.DELTA, text: delta }
  }
  if (json?.done === true) return { type: STREAM_EVENT_TYPES.DONE }
  return null
}

// OpenAI Responses：response.output_text.delta
function fromResponses(json) {
  if (json?.type === 'response.output_text.delta' && typeof json.delta === 'string') {
    return { type: STREAM_EVENT_TYPES.DELTA, text: json.delta }
  }
  if (json?.type === 'response.completed' && json?.response?.usage) {
    const usage = normalizeUsage(json.response.usage)
    if (usage) return { type: STREAM_EVENT_TYPES.USAGE, usage }
  }
  return null
}

const EXTRACTORS = {
  openai: fromOpenAI,
  anthropic: fromAnthropic,
  gemini: fromGemini,
  ollama: fromOllama,
  responses: fromResponses,
}

// 按协议解析单个事件 JSON；未知协议回退到 OpenAI 形状
export function normalizeStreamEvent(json, protocol = 'openai') {
  if (!json || typeof json !== 'object') return null
  const extract = EXTRACTORS[protocol] || fromOpenAI
  const event = extract(json)
  if (!event) return null
  return { raw: json, ...event }
}

// 判断 SSE data 是否为结束标记
export function isStreamDone(data) {
  return data === '[DONE]' || data === 'DONE'
}
