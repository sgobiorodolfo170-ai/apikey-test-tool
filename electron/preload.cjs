const { contextBridge, ipcRenderer } = require('electron')

// 流式响应按 requestId 分发：渲染进程每次请求注册一个回调，结束后自动移除
const streamHandlers = new Map()

// IPC 结构化克隆只接受纯数据：Vue 的响应式 Proxy（Pinia store / reactive 对象）
// 无法被克隆，直接传会抛 "An object could not be cloned"（ERROR_LOG.md 有 5 次真实记录）。
// 统一在桥接层归一化：本身可克隆的原样传；不可克隆的（Proxy 等）退化为 JSON 深拷贝；
// 连 JSON 都失败的（循环引用等）传 null，也不让 invoke 直接崩。
function toPlainPayload(value) {
  if (value === null || typeof value !== 'object') return value
  try {
    structuredClone(value)
    return value
  } catch {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return null
    }
  }
}

// 所有 invoke 的参数统一过一遍归一化，新增桥方法自动获得同样保护
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args.map(toPlainPayload))
}

ipcRenderer.on('http-stream-event', (_event, data) => {
  if (!data || !data.requestId) return
  const handler = streamHandlers.get(data.requestId)
  if (handler) handler(data)
})

contextBridge.exposeInMainWorld('electronAPI', {
  getUserDataPath: () => invoke('get-user-data-path'),
  // 数据目录：所有项目数据文件（历史、渠道、中转站配置与统计）的存放位置
  getDataDir: () => invoke('get-data-dir'),
  chooseDataDir: () => invoke('choose-data-dir'),
  readFile: (filePath) => invoke('read-file', filePath),
  writeFile: (filePath, data) => invoke('write-file', filePath, data),
  existsFile: (filePath) => invoke('exists-file', filePath),
  logError: (errorType, errorMessage, stackTrace) =>
    invoke('log-error', errorType, errorMessage, stackTrace),

  // 主进程 HTTP 代理：绕开渲染进程的 CORS 限制，并让密钥不进入渲染进程的网络栈
  request: (payload) => invoke('http-request', payload),
  stream: (payload, onEvent) => {
    const requestId = payload && payload.requestId
    if (requestId && typeof onEvent === 'function') {
      streamHandlers.set(requestId, onEvent)
    }
    return invoke('http-stream', payload).finally(() => {
      if (requestId) streamHandlers.delete(requestId)
    })
  },
  abortRequest: (requestId) => invoke('http-abort', requestId),

  // 代码题本地执行（主进程子进程 + 硬超时）
  runCode: (payload) => invoke('run-code', payload),

  // 用系统浏览器打开外部链接（主进程会校验域名）
  openExternal: (url) => invoke('open-external', url),

  // 折叠聊天测试卡片：主窗口临时收窄到左区卡片宽度，展开时恢复原尺寸
  setWindowCollapsed: (payload) => invoke('window-set-collapsed', payload),

  // 卡片尺寸变化后让主窗口跟随（窗口与卡片保持固定间距）
  setWindowSize: (payload) => invoke('window-set-size', payload),

  // 中转站：本地 OpenAI 兼容聚合端点
  relay: {
    start: (config) => invoke('relay-start', config),
    stop: () => invoke('relay-stop'),
    status: () => invoke('relay-status'),
    unlockQuota: (providerId) => invoke('relay-quota-unlock', providerId),
    probeKeys: (providerId) => invoke('relay-key-probe', providerId),
    update: (config) => invoke('relay-update', config),
    fetchModels: (payload) => invoke('relay-models', payload),
    testKey: (payload) => invoke('relay-test-key', payload),
    logs: () => invoke('relay-logs'),
    clearLogs: () => invoke('relay-clear-logs'),
    diagnostics: () => invoke('relay-diagnostics'),
    clearDiagnostics: () => invoke('relay-diagnostics-clear'),
    observations: () => invoke('relay-observations'),
    stats: () => invoke('relay-stats'),
    clearStats: () => invoke('relay-stats-clear'),
    tokenHistory: () => invoke('relay-token-history'),
  },

  // 密钥加密存储（Electron safeStorage）
  secureStore: (op, data) => invoke('secure-store', op, data),
  secureAvailable: () => invoke('secure-available'),

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
