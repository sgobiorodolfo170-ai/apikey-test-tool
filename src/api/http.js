import axios from 'axios'

// 统一 HTTP 出口。
// - 在 Electron 中（preload 已注入 electronAPI.request）走主进程 net.fetch：
//   绕过渲染进程的 CORS 限制，且请求不经过渲染进程的网络栈。
// - 在纯浏览器（npm run dev）与单元测试中没有该桥接，回退到 axios，
//   调用形状与 axios 完全一致，便于测试直接 mock axios。

let requestSeq = 0

function getBridge() {
  if (typeof window === 'undefined') return null
  const api = window.electronAPI
  if (!api || typeof api.request !== 'function') return null
  return api
}

export function isIpcTransport() {
  return getBridge() !== null
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64 || '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// FormData 无法通过 IPC 结构化克隆，转成可序列化的 parts（文件走 base64）
async function serializeBody(data) {
  if (data === undefined || data === null) return undefined
  if (typeof data === 'string') return data
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const parts = []
    for (const [name, value] of data.entries()) {
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        parts.push({
          name,
          filename: value.name || 'blob',
          type: value.type || 'application/octet-stream',
          base64: arrayBufferToBase64(await value.arrayBuffer()),
        })
      } else {
        parts.push({ name, value: String(value) })
      }
    }
    return { __formData: true, parts }
  }
  return data
}

function decodeBody(result, responseType) {
  if (responseType === 'arraybuffer') return base64ToArrayBuffer(result.base64)
  const text = result.text ?? ''
  const contentType = (result.contentType || '').toLowerCase()
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(text)
  if (looksJson) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function makeCancelError() {
  const error = new Error('canceled')
  error.name = 'CanceledError'
  error.code = 'ERR_CANCELED'
  error.__CANCEL__ = true
  return error
}

async function ipcRequest(method, url, data, options = {}) {
  const bridge = getBridge()
  const { headers = {}, timeout, signal, responseType } = options

  if (signal?.aborted) throw makeCancelError()

  const requestId = `req_${Date.now()}_${++requestSeq}`
  const onAbort = () => {
    bridge.abortRequest?.(requestId)
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  try {
    const result = await bridge.request({
      requestId,
      url,
      method,
      headers: { ...headers },
      body: await serializeBody(data),
      timeout,
      responseType,
    })

    if (!result || result.ok !== true) {
      if (result?.cancelled) throw makeCancelError()
      const error = new Error(result?.message || '网络请求失败')
      error.code = result?.code || 'ERR_NETWORK'
      error.isNetworkError = true
      throw error
    }

    const response = {
      data: decodeBody(result, responseType),
      status: result.status,
      statusText: result.statusText,
      headers: result.headers || {},
    }

    if (result.status >= 200 && result.status < 300) return response

    const error = new Error(`Request failed with status code ${result.status}`)
    error.response = response
    error.status = result.status
    throw error
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function request(method, url, data, options = {}) {
  if (!isIpcTransport()) {
    const config = { ...options }
    return method === 'GET' ? axios.get(url, config) : axios.post(url, data, config)
  }
  return ipcRequest(method, url, data, options)
}

function parseMaybeJson(text) {
  if (!text) return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function statusError(status, statusText, text, headers) {
  const error = new Error(`Request failed with status code ${status}`)
  error.response = { status, statusText, data: parseMaybeJson(text), headers: headers || {} }
  error.status = status
  return error
}

// 流式请求：命中 IPC 时逐块回调；非 2xx 抛 axios 形状错误，便于各协议做端点回退
async function ipcStream(url, data, options = {}, onChunk) {
  const bridge = typeof window === 'undefined' ? null : window.electronAPI
  if (!bridge || typeof bridge.stream !== 'function') {
    throw new Error('当前环境不支持流式请求')
  }
  const { headers = {}, timeout, signal } = options

  if (signal?.aborted) throw makeCancelError()

  const requestId = `str_${Date.now()}_${++requestSeq}`
  const onAbort = () => {
    bridge.abortRequest?.(requestId)
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  let result
  try {
    result = await bridge.stream(
      {
        requestId,
        url,
        method: 'POST',
        headers: { ...headers },
        body: await serializeBody(data),
        timeout,
      },
      (event) => {
        if (event?.type === 'chunk' && event.text) onChunk?.(event.text)
      },
    )
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  if (!result) throw new Error('流式请求失败')
  if (result.cancelled) {
    return { status: 200, statusText: 'OK', headers: {}, cancelled: true }
  }
  if (result.ok === false) {
    const error = new Error(result.message || '网络请求失败')
    error.code = result.code || 'ERR_NETWORK'
    error.isNetworkError = true
    throw error
  }
  if (result.status >= 300) {
    throw statusError(result.status, result.statusText, result.text, result.headers)
  }
  return { status: result.status, statusText: result.statusText, headers: result.headers || {} }
}

// 浏览器调试模式下的兜底：用 fetch 读 ReadableStream（仍受 CORS 限制）
async function fetchStream(url, data, options = {}, onChunk) {
  const { headers = {}, signal, timeout } = options
  const controller = new AbortController()
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null
  const onOuterAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw makeCancelError()
    signal.addEventListener('abort', onOuterAbort, { once: true })
  }

  const isForm = typeof FormData !== 'undefined' && data instanceof FormData
  const body = isForm || typeof data === 'string' ? data : JSON.stringify(data)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })

    if (!response.ok) {
      throw statusError(response.status, response.statusText, await response.text(), {})
    }
    if (!response.body) {
      onChunk?.(await response.text())
      return { status: response.status, statusText: response.statusText, headers: {} }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text) onChunk?.(text)
    }
    const tail = decoder.decode()
    if (tail) onChunk?.(tail)

    return { status: response.status, statusText: response.statusText, headers: {} }
  } catch (error) {
    if (error.name === 'AbortError') throw makeCancelError()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}

export function stream(url, data, options, onChunk) {
  if (typeof window !== 'undefined' && typeof window.electronAPI?.stream === 'function') {
    return ipcStream(url, data, options, onChunk)
  }
  return fetchStream(url, data, options, onChunk)
}

const http = {
  get: (url, options) => request('GET', url, undefined, options),
  post: (url, data, options) => request('POST', url, data, options),
  request,
  stream,
}

export default http
