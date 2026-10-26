// 流式响应的增量解析器。
// SSE 与 NDJSON 都可能被网络切成任意边界，所以必须自带缓冲，按事件/整行切分。

export function createSseParser(onEvent) {
  let buffer = ''

  function emit(rawBlock) {
    let event = 'message'
    const dataLines = []

    for (const line of rawBlock.split('\n')) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }

    if (dataLines.length === 0) return
    onEvent({ event, data: dataLines.join('\n') })
  }

  return {
    push(chunk) {
      // 统一换行，兼容服务端返回的 \r\n；跨块被截断的 \r 会在下次拼接后还原
      buffer = (buffer + chunk).replace(/\r\n/g, '\n')
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        emit(block)
      }
    },
    flush() {
      if (buffer.trim()) {
        const rest = buffer
        buffer = ''
        emit(rest)
      }
    },
  }
}

// Ollama 的 /api/chat 返回按行分隔的 JSON 对象
export function createNdjsonParser(onObject) {
  let buffer = ''

  return {
    push(chunk) {
      buffer = (buffer + chunk).replace(/\r\n/g, '\n')
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          onObject(JSON.parse(line))
        } catch {
          /* 不完整或非 JSON 行，跳过 */
        }
      }
    },
    flush() {
      const rest = buffer.trim()
      buffer = ''
      if (!rest) return
      try {
        onObject(JSON.parse(rest))
      } catch {
        /* ignore */
      }
    },
  }
}
