const { contextBridge, ipcRenderer } = require('electron')

// 流式响应按 requestId 分发：渲染进程每次请求注册一个回调，结束后自动移除
const streamHandlers = new Map()

ipcRenderer.on('http-stream-event', (_event, data) => {
  if (!data || !data.requestId) return
  const handler = streamHandlers.get(data.requestId)
  if (handler) handler(data)
})

contextBridge.exposeInMainWorld('electronAPI', {
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),
  existsFile: (filePath) => ipcRenderer.invoke('exists-file', filePath),
  logError: (errorType, errorMessage, stackTrace) =>
    ipcRenderer.invoke('log-error', errorType, errorMessage, stackTrace),

  // 主进程 HTTP 代理：绕开渲染进程的 CORS 限制，并让密钥不进入渲染进程的网络栈
  request: (payload) => ipcRenderer.invoke('http-request', payload),
  stream: (payload, onEvent) => {
    const requestId = payload && payload.requestId
    if (requestId && typeof onEvent === 'function') {
      streamHandlers.set(requestId, onEvent)
    }
    return ipcRenderer.invoke('http-stream', payload).finally(() => {
      if (requestId) streamHandlers.delete(requestId)
    })
  },
  abortRequest: (requestId) => ipcRenderer.invoke('http-abort', requestId),

  // 代码题本地执行（主进程子进程 + 硬超时）
  runCode: (payload) => ipcRenderer.invoke('run-code', payload),

  // 用系统浏览器打开外部链接（主进程会校验域名）
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 密钥加密存储（Electron safeStorage）
  secureStore: (op, data) => ipcRenderer.invoke('secure-store', op, data),
  secureAvailable: () => ipcRenderer.invoke('secure-available'),

  on: (channel, callback) => {
    const validChannels = ['app-cleanup']
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args))
    }
  },
  removeAllListeners: (channel) => {
    const validChannels = ['app-cleanup']
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel)
    }
  },
})
