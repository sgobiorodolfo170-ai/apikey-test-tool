#!/usr/bin/env node
/**
 * 打包产物核查脚本：在打包前后自动发现「前端一片空白」这类遗漏。
 *
 * 用法：
 *   node scripts/verify-package.cjs --dist-only    # vite build 之后，只核查 dist
 *   node scripts/verify-package.cjs                 # 打包之后，核查 dist + app.asar + 安装包
 *   node scripts/verify-package.cjs --require-package  # 打包之后，缺失 asar/安装包直接失败
 *   node scripts/verify-package.cjs --app           # 额外启动解包目录里的 exe，确认页面真的渲染
 *   node scripts/verify-package.cjs --app-default   # 不带调试参数启动 exe，模拟用户直接双击
 *
 * 注意：--app 与用户双击的唯一差别是带了远程调试端口与 --disable-gpu；
 * 不带任何兼容参数（历史上曾注入 --no-sandbox，Electron 43 起已不再需要）。
 *
 * 退出码：0 通过；1 存在会阻止发布的遗漏。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
// 默认输出目录是 dist-app；打包目录被占用时可用 APKEY_DIST_APP_DIR 指向备用目录
const DIST_APP = process.env.APKEY_DIST_APP_DIR
  ? path.resolve(ROOT, process.env.APKEY_DIST_APP_DIR)
  : path.join(ROOT, 'dist-app')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// Node 20 没有全局 WebSocket；优先用全局，其次复用项目里已有的 ws（smoke 脚本同样处理）
const WebSocketImpl =
  globalThis.WebSocket ||
  (() => {
    try {
      return require('ws')
    } catch {
      return null
    }
  })()

const args = new Set(process.argv.slice(2))
const DIST_ONLY = args.has('--dist-only')
const REQUIRE_PACKAGE = args.has('--require-package')
const TEST_APP = args.has('--app')
const TEST_APP_DEFAULT = args.has('--app-default')

const failures = []
const warnings = []
const passes = []

function pass(message) {
  passes.push(message)
}

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

function isNonEmptyFile(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0
  } catch {
    return false
  }
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

function listFilesRecursive(dir, filter = () => true) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, filter))
    else if (filter(full)) out.push(full)
  }
  return out
}

// ---------- 1. dist 前端产物 ----------

function checkDist() {
  const indexPath = path.join(DIST, 'index.html')
  if (!isNonEmptyFile(indexPath)) {
    fail('dist/index.html 不存在或为空：vite build 没有成功产出前端文件')
    return null
  }

  const html = fs.readFileSync(indexPath, 'utf8')
  if (!/<div[^>]+id=["']app["']/.test(html)) {
    fail('dist/index.html 缺少 #app 挂载点')
  }
  if (html.trim().length < 200) {
    fail('dist/index.html 内容过短，疑似构建不完整')
  }

  // Electron 用 file:// 加载，任何以 / 开头的绝对路径都会指向磁盘根目录，页面直接空白
  const refs = []
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  const linkRe = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi
  let match
  while ((match = scriptRe.exec(html)))
    refs.push({ kind: 'script', value: match[1], tag: match[0] })
  while ((match = linkRe.exec(html))) refs.push({ kind: 'link', value: match[1], tag: match[0] })

  if (!refs.some((ref) => ref.kind === 'script')) {
    fail('dist/index.html 没有引用任何脚本，Vue 应用不会启动')
  }
  if (!refs.some((ref) => ref.kind === 'link' && /\.css(\?|$)/i.test(ref.value))) {
    warn('dist/index.html 没有引用样式文件，界面可能没有样式')
  }
  if (!refs.some((ref) => ref.kind === 'script' && /\btype=["']module["']/i.test(ref.tag))) {
    warn('dist/index.html 的入口脚本不是 type="module"，请确认构建输出')
  }
  if (!/Content-Security-Policy/i.test(html)) {
    warn('dist/index.html 缺少 CSP meta（不影响渲染，但建议保留）')
  }

  for (const ref of refs) {
    const value = ref.value
    if (/^(https?:)?\/\//i.test(value) || /^(data|blob):/i.test(value)) {
      fail(`dist/index.html 引用了外部资源 ${value}（打包后离线环境会加载失败）`)
      continue
    }
    if (value.startsWith('/')) {
      fail(
        `dist/index.html 使用绝对路径 ${value}；Electron 以 file:// 打开时会指向磁盘根目录导致白屏，` +
          '请保持 vite.config.js 中的 base 为 "./"',
      )
      continue
    }
    const target = path.resolve(DIST, value.split('?')[0])
    if (!target.startsWith(DIST + path.sep) && target !== DIST) {
      fail(`dist/index.html 引用了 dist 之外的路径 ${value}`)
    } else if (!isNonEmptyFile(target)) {
      fail(`dist/index.html 引用的资源缺失或为空：${value}`)
    } else {
      pass(`前端资源存在：${relative(target)}`)
    }
  }

  // 构建产物语法自检：坏掉的 JS 会让页面直接白屏，且控制台才看得到
  const jsFiles = listFilesRecursive(DIST, (file) => file.endsWith('.js'))
  for (const jsFile of jsFiles) {
    const tmp = path.join(os.tmpdir(), `apkey-verify-${process.pid}-${path.basename(jsFile)}.mjs`)
    try {
      fs.copyFileSync(jsFile, tmp)
      const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
      if (result.status !== 0) {
        fail(`构建产物 JS 语法错误：${relative(jsFile)}\n${(result.stderr || '').trim()}`)
      } else {
        pass(`构建产物 JS 语法正常：${relative(jsFile)}`)
      }
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 忽略临时文件清理失败 */
      }
    }
  }

  const cssFiles = listFilesRecursive(DIST, (file) => file.endsWith('.css'))
  for (const cssFile of cssFiles) {
    if (fs.statSync(cssFile).size < 1000)
      warn(`样式文件偏小，请确认 Tailwind 是否正常生成：${relative(cssFile)}`)
    else pass(`样式文件正常：${relative(cssFile)}`)
  }

  // 过期产物：源码比 dist 新，说明这次打包用的是旧前端
  const newestSource = listFilesRecursive(path.join(ROOT, 'src')).reduce((newest, file) => {
    const time = fs.statSync(file).mtimeMs
    return time > newest ? time : newest
  }, 0)
  const configTime = Math.max(
    fs.statSync(path.join(ROOT, 'package.json')).mtimeMs,
    fs.statSync(path.join(ROOT, 'vite.config.js')).mtimeMs,
    fs.statSync(path.join(ROOT, 'index.html')).mtimeMs,
  )
  const distTime = fs.statSync(indexPath).mtimeMs
  const newestInput = Math.max(newestSource, configTime)
  if (distTime + 1000 < newestInput) {
    fail(
      `dist 比源码旧（dist ${new Date(distTime).toLocaleString()} < 源码 ${new Date(
        newestInput,
      ).toLocaleString()}）：请重新执行 npm run build，不要直接打包旧 dist`,
    )
  } else {
    pass('dist 是当前源码的最新构建')
  }

  return html
}

// ---------- 2. app.asar 内容 ----------

function findAsarFiles() {
  return listFilesRecursive(
    DIST_APP,
    (file) => path.basename(file) === 'app.asar' && !file.includes('.tmp'),
  )
}

function findArtifacts() {
  if (!fs.existsSync(DIST_APP)) return []
  return fs
    .readdirSync(DIST_APP, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(exe|dmg|zip|AppImage)$/i.test(entry.name))
    .map((entry) => path.join(DIST_APP, entry.name))
}

function checkAsar(distHtml) {
  const asarFiles = findAsarFiles()
  if (asarFiles.length === 0) {
    const message = 'dist-app 下没有找到 app.asar：打包未完成或产物被清理'
    REQUIRE_PACKAGE ? fail(message) : warn(message)
    return
  }

  let asar
  try {
    asar = require('@electron/asar')
  } catch {
    fail('缺少 @electron/asar，无法核查 asar 内容；请先 npm install')
    return
  }

  for (const asarPath of asarFiles) {
    const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/'))
    const entrySet = new Set(entries)
    const base = relative(asarPath)

    const required = [
      '/dist/index.html',
      '/electron/main.cjs',
      '/electron/preload.cjs',
      '/package.json',
    ]
    const mainEntry = `/${String(PKG.main || '')
      .replace(/^[./]+/, '')
      .replace(/\\/g, '/')}`
    if (mainEntry !== '/' && !required.includes(mainEntry)) required.push(mainEntry)

    for (const file of new Set(required)) {
      if (!entrySet.has(file)) fail(`${base} 缺少必要文件：${file}`)
      else pass(`${base} 包含 ${file}`)
    }

    if (!entrySet.has('/dist/index.html')) continue

    // 打包目录里的 index.html 必须与刚刚构建的 dist 完全一致
    const packedHtml = asar.extractFile(asarPath, 'dist/index.html').toString('utf8')
    if (distHtml && packedHtml !== distHtml) {
      fail(`${base} 里的 dist/index.html 与本次构建的 dist/index.html 不一致，产物是旧的`)
    } else {
      pass(`${base} 里的前端入口与 dist 一致`)
    }

    // 入口 HTML 引用的每个资源都要真的在 asar 里
    const refs = new Set()
    for (const re of [
      /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
      /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
    ]) {
      let match
      while ((match = re.exec(packedHtml))) refs.add(match[1])
    }
    for (const value of refs) {
      const file = `/${path.posix.normalize(`dist/${value.split('?')[0]}`)}`
      if (!entrySet.has(file)) {
        fail(`${base} 缺少前端入口引用的资源：${file}`)
      } else {
        pass(`${base} 包含 ${file}`)
      }
    }

    if (!entrySet.has('/electron/relay.cjs'))
      fail(`${base} 缺少 electron/relay.cjs（主进程中转站无法启动）`)
    if (!entries.some((entry) => /^\/electron\/lib\/.+\.cjs$/.test(entry))) {
      fail(`${base} 缺少 electron/lib/*.cjs（路径与数据目录工具）`)
    }
    // relay.cjs 顶层 require 的适配器：缺失时主进程启动即崩，必须核查
    if (!entries.some((entry) => /^\/electron\/gateway\/adapters\/.+\.cjs$/.test(entry))) {
      fail(`${base} 缺少 electron/gateway/adapters/*.cjs（Anthropic 协议适配，缺失则启动即崩）`)
    }
    if (!entrySet.has('/electron/generated/providers.cjs')) {
      fail(
        `${base} 缺少 electron/generated/providers.cjs（提供商注册表快照，先跑 npm run generate:registry）`,
      )
    }
    if (!entrySet.has('/ico/icon-256x256.png')) {
      warn(`${base} 缺少托盘图标 ico/icon-256x256.png，托盘可能不显示`)
    }
    if (!entries.some((entry) => entry.startsWith('/dist/assets/'))) {
      fail(`${base} 缺少 dist/assets 目录`)
    }

    // 应用版本必须与本次产出一致
    const packedPkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    if (packedPkg.version !== PKG.version) {
      fail(
        `${base} 内 package.json 版本 ${packedPkg.version} 与 package.json ${PKG.version} 不一致`,
      )
    } else {
      pass(`${base} 版本一致：${PKG.version}`)
    }
  }
}

// ---------- 3. 安装包 / 更新清单 ----------

function checkArtifacts() {
  const artifacts = findArtifacts()
  if (artifacts.length === 0) {
    const message = 'dist-app 下没有 exe/dmg/zip 安装包：打包未完成'
    REQUIRE_PACKAGE ? fail(message) : warn(message)
    return
  }

  for (const artifact of artifacts) {
    if (fs.statSync(artifact).size < 10 * 1024 * 1024) {
      fail(`安装包体积异常偏小（${relative(artifact)}），可能是打包中断的残留`)
    } else {
      pass(`安装包存在：${relative(artifact)}`)
    }
    if (!artifact.includes(PKG.version)) {
      warn(`安装包文件名不含当前版本 ${PKG.version}：${relative(artifact)}`)
    }
  }

  const latestYml = path.join(DIST_APP, 'latest.yml')
  if (fs.existsSync(latestYml)) {
    const text = fs.readFileSync(latestYml, 'utf8')
    const version = (text.match(/^version:\s*(.+)$/m) || [])[1]
    if (version && version.trim() !== PKG.version) {
      fail(`latest.yml 版本 ${version.trim()} 与 package.json ${PKG.version} 不一致`)
    } else {
      pass(`latest.yml 版本一致：${PKG.version}`)
    }
  }

  // 沙箱兼容注入已于 Electron 降级到 43.8.10 后移除：Windows 更新导致的
  // 44/45 沙箱初始化崩溃（0x80000003）不再适用于 43，直接双击即可启动。
  // 若未来升级 Electron 后再次出现「双击无反应」，先确认上游 issue
  // electron/electron#54614 是否已修复，再考虑重新引入启动入口注入。
}

// ---------- 4. 启动真实安装包，确认页面不是白屏 ----------

function findPackagedExe() {
  const asarFiles = findAsarFiles()
  for (const asarPath of asarFiles) {
    const dir = path.dirname(path.dirname(asarPath)) // resources/app.asar -> win-unpacked
    try {
      const candidates = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.exe'))
        .map((name) => path.join(dir, name))
      if (candidates.length > 0) return candidates[0]
    } catch {
      continue
    }
  }
  return null
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}

function killTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      /* 已退出 */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
}

async function checkRender() {
  const exe = findPackagedExe()
  if (!exe) {
    fail('没有找到可启动的已打包 exe，无法验证页面渲染')
    return
  }

  const port = await getFreePort()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'apkey-verify-ud-'))
  if (!WebSocketImpl) {
    fail('当前 Node 不支持 WebSocket（需要 Node 22+ 或安装 ws），无法验证页面渲染')
    return
  }
  const env = { ...process.env, APKEY_USER_DATA_DIR: userData }
  delete env.ELECTRON_RUN_AS_NODE

  // 不带 --no-sandbox，与用户直接双击的默认入口完全一致：Electron 43 下
  // 沙箱初始化正常，无需任何兼容参数。
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--disable-gpu'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => (logs += chunk.toString()))
  child.stderr.on('data', (chunk) => (logs += chunk.toString()))

  try {
    let page = null
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      try {
        const targets = await getJson(`http://127.0.0.1:${port}/json/list`)
        page = targets.find(
          (target) => target.type === 'page' && /index\.html/i.test(target.url || ''),
        )
        if (page) break
      } catch {
        /* 还没有启动完成 */
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!page) throw new Error('等待应用窗口超时')

    const ws = new WebSocketImpl(page.webSocketDebuggerUrl)
    let seq = 0
    const pending = new Map()
    const events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
      } else if (message.method) {
        events.push(message)
      }
    })
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
        once: true,
      })
    })

    await send('Runtime.enable')
    await send('Log.enable')
    await send('Page.enable')
    await send('Page.reload')
    await new Promise((resolve) => setTimeout(resolve, 4000))

    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        htmlLength: (document.querySelector('#app')?.innerHTML || '').length,
        text: (document.body.innerText || '').slice(0, 300),
        bridge: typeof window.electronAPI === 'object' && window.electronAPI !== null
      })`,
      returnByValue: true,
    })
    const dom = JSON.parse(result.result.value)
    ws.close()

    if (dom.htmlLength < 500) {
      fail(`页面渲染为空（#app innerHTML 长度 ${dom.htmlLength}），即用户看到的白屏`)
    } else {
      pass(`页面渲染正常（#app innerHTML 长度 ${dom.htmlLength}）`)
    }
    if (!dom.bridge) fail('渲染进程没有拿到 preload 暴露的 electronAPI')

    const errors = events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map(
        (event) =>
          event.params.exceptionDetails?.exception?.description ||
          event.params.exceptionDetails?.text,
      )
    const logErrors = events
      .filter(
        (event) =>
          event.method === 'Log.entryAdded' &&
          event.params.entry.level === 'error' &&
          !/Autofill|DevTools|Electron Security Warning/i.test(event.params.entry.text || ''),
      )
      .map((event) => event.params.entry.text)
    if (errors.length > 0) fail(`渲染进程存在未捕获异常：${errors.slice(0, 3).join(' | ')}`)
    if (logErrors.length > 0) fail(`渲染进程控制台存在错误：${logErrors.slice(0, 3).join(' | ')}`)
  } catch (error) {
    fail(`启动已打包应用失败：${error.message}`)
    const tail = logs.trim().split('\n').slice(-10).join('\n')
    if (tail) console.error(tail)
  } finally {
    killTree(child)
    try {
      fs.rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

// ---------- 5. 默认参数启动（模拟用户直接双击 exe） ----------
// 与 --app 的区别：这里不注入任何兼容参数，能真实暴露“双击后进程秒退、窗口不出现”。
// 沙箱正常时应当 PASS；沙箱故障的环境应当只走安装快捷方式 / 便携版入口。

async function checkDefaultLaunch() {
  const exe = findPackagedExe()
  if (!exe) {
    fail('没有找到可启动的已打包 exe，无法验证默认启动')
    return
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'apkey-verify-default-'))
  const env = { ...process.env, APKEY_USER_DATA_DIR: userData }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_DISABLE_SANDBOX

  const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (chunk) => (logs += chunk.toString()))
  child.stderr.on('data', (chunk) => (logs += chunk.toString()))

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 8000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  try {
    if (exitCode === undefined) {
      pass('默认参数启动存活（直接双击 exe 可用）')
    } else {
      warn(
        `默认参数启动在 8 秒内退出（退出码 ${exitCode}）：Windows 11 26200/26300 的 Chromium 沙箱故障，` +
          '请通过安装快捷方式、便携版 exe 或 start-compat.bat 启动',
      )
      const tail = logs.trim().split('\n').slice(-5).join('\n')
      if (tail) console.error(tail)
    }
  } finally {
    killTree(child)
    try {
      fs.rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

// ---------- 主流程 ----------

;(async () => {
  console.log(`[verify] 版本 ${PKG.version}，目录 ${ROOT}`)
  const distHtml = checkDist()
  if (!DIST_ONLY) {
    checkAsar(distHtml)
    checkArtifacts()
    if (TEST_APP) await checkRender()
    if (TEST_APP_DEFAULT) await checkDefaultLaunch()
  }

  for (const message of passes) console.log(`  PASS  ${message}`)
  for (const message of warnings) console.log(`  WARN  ${message}`)
  for (const message of failures) console.error(`  FAIL  ${message}`)

  if (failures.length > 0) {
    console.error(`\n[verify] ${failures.length} 项失败，禁止发布`)
    process.exit(1)
  }
  console.log(`\n[verify] 全部通过（${passes.length} 项），可以发布`)
})()
