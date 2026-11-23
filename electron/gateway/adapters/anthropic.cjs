// Anthropic /v1/messages ↔ OpenAI chat/completions 协议转换。
// 本地网关的上游统一按 OpenAI 兼容协议转发；本模块只负责请求 / 响应 / SSE 的归一，
// 不涉及网络与调度，便于离线单测。工具调用（tool_use）暂不在本增量内支持。

function textOfBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .join('')
}

// Anthropic content（字符串或块数组）→ OpenAI content（字符串或多模态 parts）
function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  let hasNonText = false
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'text', text: block })
    } else if (block?.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' })
    } else if (block?.type === 'image' && block.source) {
      hasNonText = true
      const media = block.source.media_type || 'image/png'
      const url =
        block.source.type === 'base64'
          ? `data:${media};base64,${block.source.data || ''}`
          : block.source.url || ''
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  return hasNonText ? parts : parts.map((part) => part.text).join('')
}

function mapStopReason(reason) {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'stop':
    case 'content_filter':
    default:
      return 'end_turn'
  }
}

// Anthropic 请求 → OpenAI chat/completions 请求
function anthropicToOpenAI(body = {}) {
  const messages = []
  const system = body.system
  if (typeof system === 'string' && system.trim()) {
    messages.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = textOfBlocks(system).trim()
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    messages.push({
      role: msg?.role === 'assistant' ? 'assistant' : 'user',
      content: normalizeContent(msg?.content),
    })
  }
  const out = { model: body.model, messages, stream: body.stream === true }
  if (Number.isFinite(body.max_tokens)) out.max_tokens = body.max_tokens
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences
  }
  return out
}

// OpenAI 非流式响应 → Anthropic message
function openAIToAnthropic(json = {}, model = '') {
  const choice = Array.isArray(json.choices) ? json.choices[0] : null
  const content = choice?.message?.content
  const usage = json.usage || {}
  return {
    id: json.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: json.model || model,
    content: [{ type: 'text', text: typeof content === 'string' ? content : '' }],
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  }
}

function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

// 把一段 OpenAI SSE 文本聚合为单个非流式响应（上游忽略 stream:false 时的兜底）。
function aggregateOpenAIStream(text) {
  let content = ''
  let finishReason = 'stop'
  let usage = {}
  let model = ''
  const normalized = String(text).replace(/\r\n/g, '\n')
  for (const block of normalized.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') continue
    try {
      const json = JSON.parse(data)
      const choice = Array.isArray(json.choices) ? json.choices[0] : null
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (json.usage) usage = json.usage
      if (json.model) model = json.model
    } catch {
      // 忽略残缺事件
    }
  }
  return { model, choices: [{ message: { content }, finish_reason: finishReason }], usage }
}

// OpenAI SSE → Anthropic SSE 事件流。push 喂入上游原始文本，返回应写给客户端的事件文本。
// 跨 chunk 的事件用缓冲拼接；[DONE] 或 end() 触发收尾事件。
function createAnthropicSseTransform(model = '') {
  let buffer = ''
  let started = false
  let finished = false
  let inputTokens = 0
  let outputTokens = 0
  let stopReason = 'end_turn'
  const messageId = `msg_${Date.now()}`

  const startEvents = () =>
    [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sseEvent('ping', { type: 'ping' }),
    ].join('')

  const finishEvents = () =>
    [
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ].join('')

  const handleChunk = (json) => {
    let out = ''
    if (!started) {
      started = true
      out += startEvents()
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : null
    const text = choice?.delta?.content
    if (typeof text === 'string' && text.length > 0) {
      out += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
    }
    if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason)
    if (json.usage) {
      inputTokens = json.usage.prompt_tokens || inputTokens
      outputTokens = json.usage.completion_tokens || outputTokens
    }
    return out
  }

  return {
    push(text) {
      if (finished) return ''
      buffer += String(text).replace(/\r\n/g, '\n')
      let out = ''
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') {
          finished = true
          out += finishEvents()
          continue
        }
        try {
          out += handleChunk(JSON.parse(data))
        } catch {
          // 忽略无法解析的心跳 / 残缺事件
        }
      }
      return out
    },
    end() {
      if (finished) return ''
      finished = true
      return (started ? '' : startEvents()) + finishEvents()
    },
  }
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  createAnthropicSseTransform,
  aggregateOpenAIStream,
  normalizeContent,
  mapStopReason,
}
