const {
  app,
  BrowserWindow,
  ipcMain,
  net,
  safeStorage,
  shell,
  Menu,
  Tray,
  nativeImage,
  screen,
} = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const relay = require('./relay.cjs')
const { isPathSafe: isPathInside } = require('./lib/path-safety.cjs')
const { normalizeWindowBounds } = require('./lib/window-bounds.cjs')

// 冒烟/CI 用：把 userData 指到临时目录，既隔离单实例锁，也不污染真实历史记录
if (process.env.APKEY_USER_DATA_DIR) {
  app.setPath('userData', process.env.APKEY_USER_DATA_DIR)
}

const USER_DATA_PATH = app.getPath('userData')

// 仅允许访问 userData 目录内的路径（实现在 lib/path-safety.cjs，便于单测）
function isPathSafe(targetPath) {
  return isPathInside(USER_DATA_PATH, targetPath)
}

let mainWindow = null
let tray = null
let quitting = false
// 页面加载失败后的自动重试次数（成功后归零）
let loadRetries = 0

const RELAY_CONFIG_FILE = path.join(USER_DATA_PATH, 'relay.json')
const APP_SETTINGS_FILE = path.join(USER_DATA_PATH, 'app-settings.json')
const DEFAULT_APP_SETTINGS = { tray: true, autoLaunch: false }
let appSettings = { ...DEFAULT_APP_SETTINGS }

const LOG_FILE = 'ERROR_LOG.md'
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')

// 存储所有事件监听器的引用，用于清理
const eventListeners = {
  uncaughtException: null,
  unhandledRejection: null,
  windowAllClosed: null,
  activate: null,
  willQuit: null,
  beforeQuit: null,
}

// IPC 处理函数列表
const ipcHandlers = [
  'get-user-data-path',
  'read-file',
  'write-file',
  'exists-file',
  'log-error',
  'http-request',
  'http-stream',
  'run-code',
  'open-external',
  'relay-start',
  'relay-stop',
  'relay-status',
  'relay-update',
  'relay-models',
  'relay-logs',
  'relay-clear-logs',
  'relay-stats',
  'relay-stats-clear',
  'http-abort',
  'secure-store',
  'secure-available',
]

// 进行中的 HTTP 请求：requestId -> AbortController
const activeHttpRequests = new Map()
const HTTP_DEFAULT_TIMEOUT = 30000

function getLogFilePath() {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, LOG_FILE)
}

function formatDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function debounce(fn, delay) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

function loadWindowState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
      return {
        ...normalizeWindowBounds(raw, screen.getAllDisplays()),
        maximized: raw?.maximized === true,
      }
    }
  } catch {
    // 状态文件损坏或不可读时使用默认窗口尺寸
  }
  return normalizeWindowBounds(null)
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    const maximized = mainWindow.isMaximized()
    const state = { ...bounds, maximized }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {
    // 窗口状态写入失败不影响应用运行
  }
}

const MAX_LOG_BYTES = 1024 * 1024 // 超过 1MB 归档，避免日志无限增长

function rotateLogIfNeeded(logPath) {
  try {
    if (!fs.existsSync(logPath)) return
    if (fs.statSync(logPath).size < MAX_LOG_BYTES) return
    const archive = logPath.replace(/\.md$/, '.1.md')
    if (fs.existsSync(archive)) fs.unlinkSync(archive)
    fs.renameSync(logPath, archive)
  } catch {
    // 归档失败（文件被占用等）时继续写当前文件
  }
}

function logError(errorType, errorMessage, stackTrace) {
  try {
    const logPath = getLogFilePath()
    const timestamp = formatDate()

    rotateLogIfNeeded(logPath)
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '# 错误日志\n\n', 'utf-8')
    }

    // 追加写而不是“读全文 → 拼接 → 覆盖”，避免日志变大后阻塞主进程
    const logEntry = `========================================
时间: ${timestamp}
========================================
错误类型: ${errorType}
错误信息: ${errorMessage}
堆栈跟踪: ${stackTrace || '无'}
----------------------------------------

`
    fs.appendFileSync(logPath, logEntry, 'utf-8')
    console.error(`[ERROR LOGGED] ${timestamp} - ${errorType}: ${errorMessage}`)
  } catch (e) {
    console.error('写入错误日志失败:', e)
  }
}

eventListeners.uncaughtException = (error) => {
  logError('Uncaught Exception', error.message, error.stack)
  console.error('未捕获的异常:', error)
}
process.on('uncaughtException', eventListeners.uncaughtException)

eventListeners.unhandledRejection = (reason, _promise) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason)
  const stackTrace = reason instanceof Error ? reason.stack : null
  logError('Unhandled Promise Rejection', errorMessage, stackTrace)
  console.error('未处理的 Promise 拒绝:', reason)
}
process.on('unhandledRejection', eventListeners.unhandledRejection)

// ---------- 主进程 HTTP 代理 ----------
// 渲染进程直接发请求会受 CORS 限制（官方 OpenAI / Anthropic 等均不放行浏览器直连），
// 且 API Key 会暴露在渲染进程。统一由主进程 net.fetch 发出，天然绕过 CORS，
// 同时把密钥留在主进程侧。

function buildRequestBody(body, headers) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body.__formData === true && Array.isArray(body.parts)) {
    const form = new FormData()
    for (const part of body.parts) {
      if (typeof part.base64 === 'string') {
        const bytes = Buffer.from(part.base64, 'base64')
        const blob = new Blob([bytes], { type: part.type || 'application/octet-stream' })
        form.append(part.name, blob, part.filename || 'blob')
      } else {
        form.append(part.name, String(part.value ?? ''))
      }
    }
    return form
  }
  if (!headers['content-type'] && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  return JSON.stringify(body)
}

// 把 Chromium 网络错误码翻译成 axios 风格的 code，复用渲染进程已有的错误文案
function mapFetchError(error, { timedOut, cancelled }) {
  if (cancelled) return { cancelled: true, code: 'ERR_CANCELED', message: '请求已取消' }
  if (timedOut) return { code: 'ECONNABORTED', message: '请求超时' }

  const raw = String(error?.cause?.code || error?.code || error?.message || '')
  const codes = [
    ['ERR_NAME_NOT_RESOLVED', 'ENOTFOUND'],
    ['ERR_CONNECTION_REFUSED', 'ECONNREFUSED'],
    ['ERR_CONNECTION_RESET', 'ECONNRESET'],
    ['ERR_CONNECTION_CLOSED', 'ECONNRESET'],
    ['ERR_CONNECTION_TIMED_OUT', 'ETIMEDOUT'],
    ['ERR_INTERNET_DISCONNECTED', 'ENETUNREACH'],
    ['ERR_ADDRESS_UNREACHABLE', 'ENETUNREACH'],
    ['ERR_CERT', 'ERR_CERT'],
  ]
  for (const [needle, code] of codes) {
    if (raw.includes(needle)) return { code, message: error?.message || code }
  }
  return { code: 'ERR_NETWORK', message: error?.message || '网络请求失败' }
}

async function handleHttpRequest(payload) {
  const {
    requestId,
    url,
    method = 'GET',
    headers = {},
    body,
    timeout = HTTP_DEFAULT_TIMEOUT,
    responseType,
  } = payload || {}

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, code: 'ERR_INVALID_URL', message: `无效的请求地址: ${url}` }
  }

  const controller = new AbortController()
  const key = String(requestId || `${Date.now()}-${Math.random()}`)
  activeHttpRequests.set(key, controller)

  let timedOut = false
  const timer =
    timeout > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeout)
      : null

  const requestHeaders = { ...headers }
  const requestBody = buildRequestBody(body, requestHeaders)

  try {
    const response = await net.fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
      redirect: 'follow',
    })

    const responseHeaders = {}
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value
    })

    const result = {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      contentType: responseHeaders['content-type'] || '',
    }

    if (responseType === 'arraybuffer') {
      const buffer = Buffer.from(await response.arrayBuffer())
      result.base64 = buffer.toString('base64')
    } else {
      result.text = await response.text()
    }
    return result
  } catch (error) {
    const cancelled = controller.signal.aborted && !timedOut
    return { ok: false, ...mapFetchError(error, { timedOut, cancelled }) }
  } finally {
    if (timer) clearTimeout(timer)
    activeHttpRequests.delete(key)
  }
}

// ---------- 流式代理（SSE / NDJSON） ----------
// 逐块把响应推回渲染进程；非 2xx 时把 body 一次性读完返回，交给渲染层按普通错误处理。

function sendStreamEvent(sender, payload) {
  if (!sender || sender.isDestroyed()) return
  try {
    sender.send('http-stream-event', payload)
  } catch {
    // 窗口已关闭，忽略
  }
}

async function handleHttpStream(sender, payload) {
  const { requestId, url, method = 'POST', headers = {}, body, timeout = 120000 } = payload || {}

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, code: 'ERR_INVALID_URL', message: `无效的请求地址: ${url}` }
  }

  const key = String(requestId || `${Date.now()}-${Math.random()}`)
  const controller = new AbortController()
  activeHttpRequests.set(key, controller)

  let timedOut = false
  const timer =
    timeout > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeout)
      : null

  const requestHeaders = { ...headers }
  if (!requestHeaders.Accept && !requestHeaders.accept) {
    requestHeaders.Accept = 'text/event-stream'
  }
  const requestBody = buildRequestBody(body, requestHeaders)

  try {
    const response = await net.fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
      redirect: 'follow',
    })

    const responseHeaders = {}
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value
    })

    const meta = {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      contentType: responseHeaders['content-type'] || '',
    }

    if (!response.ok || !response.body) {
      return { ...meta, text: await response.text() }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text) sendStreamEvent(sender, { requestId: key, type: 'chunk', text })
    }

    const tail = decoder.decode()
    if (tail) sendStreamEvent(sender, { requestId: key, type: 'chunk', text: tail })

    sendStreamEvent(sender, { requestId: key, type: 'done' })
    return meta
  } catch (error) {
    const mapped = mapFetchError(error, {
      timedOut,
      cancelled: controller.signal.aborted && !timedOut,
    })

    // 用户主动停止：不当成错误，返回已完成的内容
    if (mapped.cancelled) {
      sendStreamEvent(sender, { requestId: key, type: 'done', cancelled: true })
      return { ok: true, cancelled: true, status: 200, statusText: 'OK', headers: {} }
    }

    sendStreamEvent(sender, { requestId: key, type: 'error', ...mapped })
    return { ok: false, ...mapped }
  } finally {
    if (timer) clearTimeout(timer)
    activeHttpRequests.delete(key)
  }
}

// ---------- 密钥加密（Electron safeStorage / Windows DPAPI） ----------
// 落盘前把 apiKey 加密成 enc:<base64>，读取时还原；旧版明文数据仍可读。

const SECRET_FIELDS = new Set(['apiKey', 'api_key'])

function walkSecrets(node, fn, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((item) => walkSecrets(item, fn, depth + 1))
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_FIELDS.has(key) && typeof value === 'string') {
      out[key] = fn(value)
    } else {
      out[key] = walkSecrets(value, fn, depth + 1)
    }
  }
  return out
}

function handleSecureStore(op, data) {
  const available = safeStorage.isEncryptionAvailable()

  if (op === 'encrypt') {
    if (!available) return { ok: true, encrypted: false, data }
    const result = walkSecrets(data, (value) => {
      if (!value || value.startsWith('enc:')) return value
      return `enc:${safeStorage.encryptString(value).toString('base64')}`
    })
    return { ok: true, encrypted: true, data: result }
  }

  if (op === 'decrypt') {
    const result = walkSecrets(data, (value) => {
      if (!value.startsWith('enc:')) return value
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
      } catch {
        // 换了机器/用户或数据损坏时解密失败，返回空值让用户重新输入
        return ''
      }
    })
    return { ok: true, data: result }
  }

  return { ok: false, error: `未知操作: ${op}` }
}

// ---------- 代码题本地执行（不可信代码） ----------
// 模型返回的代码按不可信输入处理：
//   静态黑名单 → 独立子进程 → vm 禁用代码生成 → 3 秒硬超时 → 用完即删临时目录。
// 不向子进程传任何密钥或用户数据，即使逃逸也拿不到有价值的信息。

const SANDBOX_TIMEOUT_MS = 3000
const SANDBOX_MAX_CODE = 4000
const SANDBOX_FORBIDDEN = [
  { re: /\brequire\s*\(/, reason: '禁止 require' },
  { re: /\bimport\s*[({'"]/, reason: '禁止 import' },
  { re: /\bprocess\b/, reason: '禁止访问 process' },
  { re: /\bglobalThis\b/, reason: '禁止访问 globalThis' },
  { re: /\bchild_process\b/, reason: '禁止访问子进程' },
  { re: /\bFunction\s*\(/, reason: '禁止 Function 构造器' },
  { re: /\beval\s*\(/, reason: '禁止 eval' },
  { re: /__proto__/, reason: '禁止操作原型' },
  { re: /\bconstructor\b/, reason: '禁止访问 constructor' },
  { re: /\bfetch\s*\(/, reason: '禁止网络请求' },
  { re: /\bXMLHttpRequest\b/, reason: '禁止网络请求' },
  { re: /while\s*\(\s*(true|1)\s*\)/, reason: '禁止死循环' },
  { re: /for\s*\(\s*;\s*;\s*\)/, reason: '禁止死循环' },
]

// 子进程里跑的测试脚手架（受信任代码，由主进程写入）
const CODE_HARNESS_SOURCE = `const fs = require('fs')
const vm = require('vm')
const path = require('path')

const dir = __dirname
const code = fs.readFileSync(path.join(dir, 'solution.js'), 'utf8')
const tests = JSON.parse(fs.readFileSync(path.join(dir, 'tests.json'), 'utf8'))

const out = { results: [], error: null }

try {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(code, context, { timeout: 1000 })

  let solve
  try {
    solve = vm.runInContext('typeof solve === "function" ? solve : undefined', context)
  } catch (e) {
    solve = undefined
  }

  if (typeof solve !== 'function') {
    out.error = '未找到 solve 函数'
  } else {
    for (const t of tests) {
      try {
        const actual = solve(t.input)
        out.results.push({
          input: t.input,
          expected: t.expected,
          actual: actual === undefined ? null : actual,
          pass: JSON.stringify(actual) === JSON.stringify(t.expected),
        })
      } catch (e) {
        out.results.push({
          input: t.input,
          expected: t.expected,
          actual: null,
          pass: false,
          error: String((e && e.message) || e),
        })
      }
    }
  }
} catch (e) {
  out.error = String((e && e.message) || e)
}

process.stdout.write(JSON.stringify(out))
`

function runSandboxChild(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'harness.cjs')], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已退出
      }
      resolve({ ok: false, error: `执行超时（>${SANDBOX_TIMEOUT_MS}ms）` })
    }, SANDBOX_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })

    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop()
      try {
        const parsed = JSON.parse(lastLine)
        resolve({ ok: true, ...parsed })
      } catch {
        resolve({
          ok: false,
          error: (stderr.trim() || '无输出').slice(0, 300),
        })
      }
    })
  })
}

async function handleRunCode(payload) {
  const { language = 'js', code, tests } = payload || {}

  if (language !== 'js') {
    return { ok: false, error: `暂只支持执行 JavaScript，收到 ${language}` }
  }
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: '代码为空' }
  }
  if (code.length > SANDBOX_MAX_CODE) {
    return { ok: false, error: '代码过长' }
  }
  const blocked = SANDBOX_FORBIDDEN.find((item) => item.re.test(code))
  if (blocked) {
    return { ok: false, error: `代码包含受限用法：${blocked.reason}` }
  }
  if (!Array.isArray(tests) || tests.length === 0 || tests.length > 10) {
    return { ok: false, error: '测试用例无效' }
  }

  let dir = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apikey-sbx-'))
    fs.writeFileSync(path.join(dir, 'solution.js'), code, 'utf8')
    fs.writeFileSync(path.join(dir, 'harness.cjs'), CODE_HARNESS_SOURCE, 'utf8')
    fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify(tests), 'utf8')
    return await runSandboxChild(dir)
  } catch (error) {
    return { ok: false, error: error.message }
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响结果
      }
    }
  }
}

function loadAppSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8'))
    return { ...DEFAULT_APP_SETTINGS, ...raw }
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}

function saveAppSettings() {
  try {
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(appSettings))
  } catch {
    // 忽略
  }
}

function readRelayConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(RELAY_CONFIG_FILE, 'utf8'))
    // 新版文件是 { version, data } 包装；旧版直接是配置对象
    if (raw && raw.data && typeof raw.data === 'object') return raw.data
    return raw
  } catch {
    return null
  }
}

function isDevToolsWindow(win) {
  if (!win || win.isDestroyed() || win === mainWindow) return false
  return String(win.webContents?.getURL() || '').startsWith('devtools://')
}

// 独立 DevTools 窗口可能置顶并抢焦点，导致主窗口点不进来：取消置顶、不占任务栏后把主窗口置前
function releaseDevToolsOverlay() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isDevToolsWindow(win)) continue
    win.setAlwaysOnTop(false)
    win.setSkipTaskbar(true)
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.moveTop()
}

function openDevToolsDetached() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.openDevTools({ mode: 'detach' })
  // DevTools 窗口是异步创建的，出现后再解除置顶，并把焦点还给主窗口
  setTimeout(releaseDevToolsOverlay, 600)
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
  }, 700)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.moveTop()
  mainWindow.focus()
  releaseDevToolsOverlay()
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const status = relay.getStatus()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      {
        label: '启动中转站',
        enabled: !status.running,
        click: () => {
          startRelayFromConfig()
        },
      },
      {
        label: '停止中转站',
        enabled: status.running,
        click: () => {
          relay.stop()
          refreshTrayMenu()
        },
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: Boolean(appSettings.autoLaunch),
        click: (item) => setAutoLaunch(item.checked),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function createTray() {
  if (tray && !tray.isDestroyed()) return
  try {
    const iconPath = path.join(__dirname, '../ico/icon-256x256.png')
    const image = nativeImage.createFromPath(iconPath)
    // macOS 菜单栏按点数显示，256px 原图过大；Windows 保持原尺寸
    const trayImage =
      process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image
    tray = new Tray(trayImage)
    tray.setToolTip('API Key 测试工具')
    tray.on('click', showMainWindow)
    tray.on('right-click', refreshTrayMenu)
    refreshTrayMenu()
  } catch (error) {
    logError('Tray Init', error.message, null)
    tray = null
  }
}

function setAutoLaunch(enabled) {
  appSettings.autoLaunch = Boolean(enabled)
  saveAppSettings()
  // 开发模式下 execPath 是 Electron 本体，写入登录项会把 Electron 加到开机启动
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
  } catch {
    // 某些平台不支持
  }
  refreshTrayMenu()
}

function startRelayFromConfig() {
  const stored = readRelayConfig()
  if (!stored || !Array.isArray(stored.providers) || stored.providers.length === 0) {
    return Promise.resolve(false)
  }
  // apiKey 落盘时是 enc:<base64>，启动前先解密，否则上游会收到加密串
  const decrypted = handleSecureStore('decrypt', stored)
  const config = decrypted?.ok ? decrypted.data : stored
  return relay
    .start({
      port: config.port,
      providers: config.providers,
      apiKey: config.apiKey,
      clientKeys: config.clientKeys,
      sticky: config.sticky,
      cache: config.cache,
    })
    .then(() => {
      refreshTrayMenu()
      return true
    })
    .catch((error) => {
      logError('Relay Start', error.message, null)
      refreshTrayMenu()
      return false
    })
}

// 启动应用时按 relay.json 的配置自动拉起中转服务
function autoStartRelay() {
  const config = readRelayConfig()
  if (!config || config.autoStart === false) return
  if (!Array.isArray(config.providers) || config.providers.length === 0) return
  startRelayFromConfig()
}

function createWindow() {
  const state = loadWindowState()

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.maximized ? {} : { x: state.x, y: state.y }),
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: path.join(__dirname, '../ico/icon-256x256.png'),
    autoHideMenuBar: process.platform !== 'darwin',
  })

  // 页面渲染完成后再显示窗口，避免启动时出现长时间白屏
  mainWindow.once('ready-to-show', () => {
    if (state.maximized) {
      mainWindow.maximize()
    } else {
      mainWindow.show()
    }
  })

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logError('Renderer Process Gone', details.reason, null)
    // 渲染进程崩溃会让窗口停在白屏，自动重载一次恢复界面（中转服务在主进程，不受影响）
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload()
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    loadRetries = 0
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logError('Page Load Failed', `${errorCode}: ${errorDescription}`, null)
      // 加载失败时 ready-to-show 不会触发，需手动显示窗口避免一直空白
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show()
      }
      // 主框架加载失败（开发模式下 vite 还没就绪常见）时自动重试，最多两次
      if (
        isMainFrame &&
        errorCode !== -3 &&
        loadRetries < 2 &&
        mainWindow &&
        !mainWindow.isDestroyed()
      ) {
        loadRetries += 1
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
        }, 800)
      }
    },
  )

  mainWindow.on('close', (event) => {
    // 托盘常驻：关闭窗口只隐藏，中转服务与调用统计继续在后台跑
    if (!quitting && appSettings.tray) {
      event.preventDefault()
      saveWindowState()
      // 主窗口收进托盘时，独立的 DevTools 窗口也一起隐藏，避免只剩它浮在桌面上
      for (const win of BrowserWindow.getAllWindows()) {
        if (isDevToolsWindow(win)) win.hide()
      }
      mainWindow.hide()
    }
  })

  // F12 切换独立 DevTools（打开时不会置顶遮挡主窗口）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return
    event.preventDefault()
    if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools()
    else openDevToolsDetached()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('resize', debounce(saveWindowState, 300))
  mainWindow.on('move', debounce(saveWindowState, 300))
  mainWindow.on('maximize', saveWindowState)
  mainWindow.on('unmaximize', saveWindowState)

  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.loadURL('http://localhost:3000')
    // 启动时打开独立 DevTools，但会解除它的置顶并把焦点还给主窗口（F12 可开关）
    openDevToolsDetached()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function cleanupResources() {
  console.log('正在清理资源...')

  // 退出前同步落盘，保证最后一次统计/额度不丢
  relay.persistNow({ sync: true })
  relay.stop()
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
    tray = null
  }

  if (mainWindow) {
    if (!mainWindow.isDestroyed()) {
      saveWindowState()
      try {
        mainWindow.webContents.send('app-cleanup')
      } catch (e) {
        console.log('无法发送清理消息给渲染进程:', e.message)
      }
      mainWindow.destroy()
    }
    mainWindow = null
  }

  if (eventListeners.uncaughtException) {
    process.off('uncaughtException', eventListeners.uncaughtException)
    eventListeners.uncaughtException = null
  }

  if (eventListeners.unhandledRejection) {
    process.off('unhandledRejection', eventListeners.unhandledRejection)
    eventListeners.unhandledRejection = null
  }

  if (eventListeners.windowAllClosed) {
    app.removeListener('window-all-closed', eventListeners.windowAllClosed)
    eventListeners.windowAllClosed = null
  }

  if (eventListeners.activate) {
    app.removeListener('activate', eventListeners.activate)
    eventListeners.activate = null
  }

  if (eventListeners.beforeQuit) {
    app.removeListener('before-quit', eventListeners.beforeQuit)
    eventListeners.beforeQuit = null
  }

  if (eventListeners.willQuit) {
    app.removeListener('will-quit', eventListeners.willQuit)
    eventListeners.willQuit = null
  }

  ipcHandlers.forEach((handler) => {
    if (ipcMain.removeHandler) {
      ipcMain.removeHandler(handler)
    }
  })

  console.log('资源清理完成')
}

function registerAppLifecycle() {
  app.whenReady().then(() => {
    appSettings = loadAppSettings()
    // 恢复上次的调用日志与统计，并挂载持久化文件
    relay.attachStorage(path.join(USER_DATA_PATH, 'relay-usage.json'))
    try {
      if (app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: Boolean(appSettings.autoLaunch) })
      }
    } catch {
      // 某些平台不支持
    }
    // macOS 需要标准应用菜单（Cmd+Q / 隐藏 / 编辑快捷键），Windows/Linux 继续隐藏菜单栏
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      )
    }
    createWindow()
    createTray()
    autoStartRelay()
  })

  eventListeners.windowAllClosed = () => {
    if (quitting || !appSettings.tray) {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    }
  }
  app.on('window-all-closed', eventListeners.windowAllClosed)

  eventListeners.activate = () => {
    // macOS 点 Dock 图标：窗口可能只是隐藏到托盘，需要恢复而不是什么都不做
    showMainWindow()
  }
  app.on('activate', eventListeners.activate)

  eventListeners.beforeQuit = (_event) => {
    console.log('应用程序准备退出 (before-quit)')
  }
  app.on('before-quit', eventListeners.beforeQuit)

  eventListeners.willQuit = () => {
    console.log('应用程序即将退出 (will-quit)')
    cleanupResources()
  }
  app.on('will-quit', eventListeners.willQuit)
}

// 单实例：重复启动时聚焦已有窗口，避免两个进程同时读写 history.json。
// 冒烟/CI 用独立 userData 运行时不参与单实例锁，否则会和用户正在使用的实例互斥。
const ISOLATED_RUN = Boolean(process.env.APKEY_USER_DATA_DIR)

if (!ISOLATED_RUN && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })

  registerAppLifecycle()
}

ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData')
})

ipcMain.handle('read-file', async (event, filePath) => {
  if (!isPathSafe(filePath)) {
    return { success: false, error: 'Access denied' }
  }
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8')
    return { success: true, data }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('write-file', async (event, filePath, data) => {
  if (!isPathSafe(filePath)) {
    return { success: false, error: 'Access denied' }
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    // 先写临时文件再原子替换：进程崩溃/断电时不会留下半截 JSON
    await fs.promises.writeFile(tmpPath, data, 'utf-8')
    await fs.promises.rename(tmpPath, filePath)
    return { success: true }
  } catch (error) {
    try {
      await fs.promises.unlink(tmpPath)
    } catch {
      // 临时文件可能未创建或已被 rename
    }
    return { success: false, error: error.message }
  }
})

ipcMain.handle('exists-file', async (event, filePath) => {
  return { success: true, exists: isPathSafe(filePath) && fs.existsSync(filePath) }
})

ipcMain.handle('log-error', async (event, errorType, errorMessage, stackTrace) => {
  logError(errorType, errorMessage, stackTrace)
  return { success: true }
})

ipcMain.handle('http-request', async (event, payload) => {
  return handleHttpRequest(payload)
})

ipcMain.handle('http-stream', async (event, payload) => {
  return handleHttpStream(event.sender, payload)
})

ipcMain.handle('run-code', async (event, payload) => {
  return handleRunCode(payload)
})

// 只允许打开 GitHub 链接：避免把任意 URL 交给系统浏览器
const ALLOWED_EXTERNAL_HOSTS = new Set(['github.com', 'www.github.com'])

async function handleOpenExternal(url) {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
      return { success: false, error: '仅允许打开 GitHub 链接' }
    }
    await shell.openExternal(parsed.toString())
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

ipcMain.handle('open-external', async (event, url) => {
  return handleOpenExternal(url)
})

// ---------- 中转站（本地 OpenAI 兼容聚合端点） ----------
ipcMain.handle('relay-start', async (event, config) => {
  try {
    const info = await relay.start(config)
    refreshTrayMenu()
    return { ok: true, ...info, status: relay.getStatus() }
  } catch (error) {
    refreshTrayMenu()
    const hint = error.code === 'EADDRINUSE' ? `端口 ${config?.port} 已被占用` : error.message
    return { ok: false, error: hint }
  }
})

ipcMain.handle('relay-stop', async () => {
  relay.stop()
  refreshTrayMenu()
  return { ok: true, status: relay.getStatus() }
})

ipcMain.handle('relay-status', async () => ({ ok: true, status: relay.getStatus() }))

ipcMain.handle('relay-update', async (event, config) => ({
  ok: true,
  status: relay.update(config),
}))

ipcMain.handle('relay-logs', async () => ({ ok: true, logs: relay.getLogs() }))

ipcMain.handle('relay-clear-logs', async () => {
  relay.clearLogs()
  return { ok: true, logs: [] }
})

ipcMain.handle('relay-stats', async () => ({ ok: true, stats: relay.getStats() }))

ipcMain.handle('relay-stats-clear', async () => {
  relay.clearStats()
  return { ok: true, stats: [] }
})

ipcMain.handle('relay-models', async (event, payload) => {
  try {
    return { ok: true, models: await relay.fetchModels(payload) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('http-abort', async (event, requestId) => {
  const controller = activeHttpRequests.get(String(requestId))
  if (!controller) return { success: false }
  controller.abort()
  activeHttpRequests.delete(String(requestId))
  return { success: true }
})

ipcMain.handle('secure-store', async (event, op, data) => {
  try {
    return handleSecureStore(op, data)
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('secure-available', async () => {
  return { available: safeStorage.isEncryptionAvailable() }
})
