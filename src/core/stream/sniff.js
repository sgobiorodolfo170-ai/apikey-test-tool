// 流式响应格式嗅探：按首块内容识别 SSE / NDJSON / JSON。
// 上游可能返回错误的 Content-Type（如 text/plain 的 SSE），
// 因此不能只信响应头，首块内容才是可靠依据。

export const STREAM_FORMATS = {
  SSE: 'sse',
  NDJSON: 'ndjson',
  JSON: 'json',
  UNKNOWN: 'unknown',
}

// 从 Content-Type 推断格式（仅作初始猜测，首块可覆盖）
export function sniffByContentType(contentType = '') {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('event-stream')) return STREAM_FORMATS.SSE
  if (type.includes('ndjson') || type.includes('x-ndjson')) return STREAM_FORMATS.NDJSON
  if (type.includes('json')) return STREAM_FORMATS.JSON
  return STREAM_FORMATS.UNKNOWN
}

// 按首块文本嗅探真实格式：
// - 以 "data:" / "event:" / "id:" / "retry:" / ":" 开头的行 → SSE
// - 首个非空行是完整 JSON 对象且后面还有行 → NDJSON
// - 整体是一个 JSON（对象/数组）→ JSON
export function sniffByFirstChunk(text = '') {
  const raw = String(text || '')
  const trimmed = raw.trimStart()
  if (!trimmed) return STREAM_FORMATS.UNKNOWN

  // SSE：首行以事件字段开头（含心跳注释行 ": ping"）
  const firstLineEnd = trimmed.indexOf('\n')
  const firstLine = (firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd)).trim()
  if (
    /^(data|event|id|retry):/.test(firstLine) ||
    (firstLine.startsWith(':') && firstLine.length > 1)
  ) {
    return STREAM_FORMATS.SSE
  }

  // NDJSON：首行是 JSON 对象，且存在后续行
  if (firstLine.startsWith('{')) {
    try {
      JSON.parse(firstLine)
      const rest = firstLineEnd === -1 ? '' : trimmed.slice(firstLineEnd + 1).trim()
      if (rest) return STREAM_FORMATS.NDJSON
      // 只有一行 JSON：可能是单对象流（Ollama 逐行），也可能是普通 JSON 响应
      // 单行完整对象按 NDJSON 处理是安全的：解析器按行消费，行为一致
      return STREAM_FORMATS.NDJSON
    } catch {
      // 首行不是完整 JSON：可能是被切断的 NDJSON 行，也可能是 SSE 的 data 行变体
      // 继续按 NDJSON 尝试（行解析器对不完整行有缓冲）
      return STREAM_FORMATS.NDJSON
    }
  }

  // JSON：整体是数组或对象
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return STREAM_FORMATS.JSON

  return STREAM_FORMATS.UNKNOWN
}

// 综合嗅探：首块优先，Content-Type 兜底（首块为空时）
export function sniffStreamFormat(firstChunkText, contentType) {
  const byContent = sniffByFirstChunk(firstChunkText)
  if (byContent !== STREAM_FORMATS.UNKNOWN) return byContent
  const byHeader = sniffByContentType(contentType)
  if (byHeader !== STREAM_FORMATS.UNKNOWN) return byHeader
  return STREAM_FORMATS.UNKNOWN
}
