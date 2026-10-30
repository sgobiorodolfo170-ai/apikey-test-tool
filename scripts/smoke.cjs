#!/usr/bin/env node
// 端到端冒烟测试：启动真实 Electron，通过 CDP 在渲染进程里调用 IPC 桥，
// 覆盖「HTTP 代理 / 流式分块 / 密钥加解密 / 路径越权」四条关键链路。
//
// 用法：npm run build && npm run smoke
// 说明：需要先有 dist/（脚本会检查）。失败时退出码为 1。

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = require('electron')

// 端口用动态分配：固定端口容易撞上上一次残留的进程，导致「等待页面超时」
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Windows 上 child.kill() 不会结束子进程树，必须用 taskkill /T
function killTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' })
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

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('[smoke] 未找到 dist/index.html，请先执行 npm run build')
  process.exit(1)
}

const WebSocketImpl = globalThis.WebSocket || require('ws')

// ---------- 本地靶站 ----------
function startServer(httpPort) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')

      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received: body, method: req.method }))
        return
      }

      if (req.url === '/fail') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"bad key"}}')
        return
      }

      if (req.url.startsWith('/bad')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"boom"}}')
        return
      }

      if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model' }] }))
        return
      }

      if (req.url === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-smoke',
            auth: req.headers.authorization || '',
            choices: [{ message: { role: 'assistant', content: 'relay-ok' } }],
          }),
        )
        return
      }

      if (req.url === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        let i = 0
        const timer = setInterval(() => {
          i += 1
          res.write(`data: {"n":${i}}\n\n`)
          if (i >= 3) {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }, 250)
        res.on('close', () => clearInterval(timer))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')
    })
  })

  return new Promise((resolve) => {
    server.listen(httpPort, '127.0.0.1', () => resolve(server))
  })
}

// ---------- CDP ----------
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('CDP 超时')))
  })
}

async function waitForPage(cdpPort, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${cdpPort}/json/list`)
      // 必须等到真正的应用页面（index.html）就绪，否则拿到的是导航前的空白页
      const page = targets.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html/i.test(t.url || ''),
      )
      if (page) return page
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待可调试页面超时')
}

// 页面导航会销毁执行上下文，这里对「上下文被销毁」做有限重试
async function evaluateWithRetry(cdp, expression, attempts = 4) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
      })
    } catch (error) {
      lastError = error
      if (!/context was destroyed|Cannot find context/i.test(error.message)) throw error
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  throw lastError
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url)
    const pending = new Map()
    let seq = 0

    const send = (method, params) =>
      new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params }))
      })

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })

    ws.addEventListener('open', () => resolve({ ws, send }))
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
  })
}

// ---------- 页面内断言 ----------
function buildExpression(httpPort) {
  return `(async () => {
    const api = window.electronAPI
    const out = { checks: [], electron: (navigator.userAgent.match(/Electron\\/([\\d.]+)/) || [])[1] || 'unknown' }
    const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail })

    // 页面刚加载时主线程仍在做首屏渲染，IPC 事件会被合并处理，先让渲染进程空闲下来
    await new Promise((r) => setTimeout(r, 1500))

    check('preload bridge', !!api && typeof api.request === 'function', typeof api)

    try {
      const r = await api.request({
        requestId: 'smoke-echo',
        url: 'http://127.0.0.1:${httpPort}/echo',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { hello: '世界' },
        timeout: 5000,
      })
      check('http proxy', r.ok && r.status === 200 && r.text.includes('世界'), r.status)
    } catch (e) {
      check('http proxy', false, String(e))
    }

    try {
      const chunks = []
      const started = performance.now()
      const r = await api.stream(
        {
          requestId: 'smoke-sse',
          url: 'http://127.0.0.1:${httpPort}/sse',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {},
          timeout: 8000,
        },
        (e) => { if (e.type === 'chunk') chunks.push({ at: performance.now() - started, text: e.text }) },
      )
      const span = chunks.length ? chunks[chunks.length - 1].at - chunks[0].at : 0
      check('sse streaming', r.status === 200 && chunks.length >= 2 && span >= 150, { chunks: chunks.length, span: Math.round(span) })
    } catch (e) {
      check('sse streaming', false, String(e))
    }

    try {
      const enc = await api.secureStore('encrypt', { config: { apiKey: 'sk-smoke' } })
      const dec = await api.secureStore('decrypt', enc.data)
      const cipher = String(enc.data?.config?.apiKey || '')
      const plain = dec.data?.config?.apiKey
      check('secure storage', enc.encrypted ? cipher.startsWith('enc:') && plain === 'sk-smoke' : plain === 'sk-smoke', { encrypted: enc.encrypted })
    } catch (e) {
      check('secure storage', false, String(e))
    }

    try {
      const started = await api.relay.start({
        port: 0,
        providers: [
          {
            id: 'smoke',
            name: 'smoke',
            baseUrl: 'http://127.0.0.1:${httpPort}',
            apiKey: 'sk-smoke',
            models: ['smoke-model'],
            enabled: true,
          },
        ],
      })
      check('relay start', started.ok === true && started.port > 0, started)

      const models = await (await fetch(started.baseUrl + '/models')).json()
      check('relay models', models.data?.[0]?.id === 'smoke-model', models)

      const completion = await (
        await fetch(started.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }),
        })
      ).json()
      check(
        'relay forward',
        completion.choices?.[0]?.message?.content === 'relay-ok' &&
          completion.auth === 'Bearer sk-smoke',
        completion,
      )

      await api.relay.stop()

      // 故障转移：第一个上游 500，应自动切到第二个
      const failover = await api.relay.start({
        port: 0,
        providers: [
          {
            id: 'bad',
            name: '坏上游',
            baseUrl: 'http://127.0.0.1:${httpPort}/bad',
            apiKey: 'sk-bad',
            models: ['smoke-model'],
            enabled: true,
          },
          {
            id: 'good',
            name: '好上游',
            baseUrl: 'http://127.0.0.1:${httpPort}',
            apiKey: 'sk-good',
            models: ['smoke-model'],
            enabled: true,
          },
        ],
      })

      const foResponse = await fetch(failover.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }),
      })
      const foBody = await foResponse.json()
      check(
        'relay failover',
        foResponse.status === 200 &&
          foBody.choices?.[0]?.message?.content === 'relay-ok' &&
          decodeURIComponent(foResponse.headers.get('x-relay-provider') || '') === '好上游',
        { status: foResponse.status, provider: foResponse.headers.get('x-relay-provider') },
      )

      // 限流：每分钟 1 次，第二次应被 429 拦下
      const limited = await api.relay.start({
        port: 0,
        providers: [
          {
            id: 'rl',
            name: '限速上游',
            baseUrl: 'http://127.0.0.1:${httpPort}',
            apiKey: 'sk-rl',
            models: ['smoke-model'],
            enabled: true,
            rpmLimit: 1,
          },
        ],
      })
      const req = () =>
        fetch(limited.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }),
        })
      const firstCall = await req()
      const secondCall = await req()
      check(
        'relay rate limit',
        firstCall.status === 200 && secondCall.status === 429,
        { first: firstCall.status, second: secondCall.status },
      )
      await api.relay.stop()

      const logs = await api.relay.logs()
      check(
        'relay logs',
        logs.ok === true && logs.logs.some((l) => l.provider === '坏上游' && l.status === 500),
        { total: logs.logs?.length },
      )

      await api.relay.stop()
    } catch (e) {
      check('relay start', false, String(e))
    }

    try {
      const exec = await api.runCode({
        language: 'js',
        code: 'function solve(n) { return n * 2 }',
        tests: [{ input: 2, expected: 4 }],
      })
      check('code sandbox run', exec.ok === true && exec.results?.[0]?.pass === true, exec)

      const blocked = await api.runCode({
        language: 'js',
        code: 'const p = process',
        tests: [{ input: 1, expected: 1 }],
      })
      check('code sandbox guard', blocked.ok === false && /受限/.test(blocked.error || ''), blocked)
    } catch (e) {
      check('code sandbox run', false, String(e))
    }

    try {
      const dir = await api.getUserDataPath()
      const outside = await api.writeFile('C:\\\\Users\\\\Public\\\\apikey-smoke.txt', 'x')
      const sibling = await api.writeFile(dir + '-evil/x.txt', 'x')
      check('path guard', outside.success === false && sibling.success === false, { outside, sibling })
    } catch (e) {
      check('path guard', false, String(e))
    }

    return out
  })()`
}

async function main() {
  const cdpPort = Number(process.env.SMOKE_CDP_PORT || (await getFreePort()))
  const httpPort = Number(process.env.SMOKE_HTTP_PORT || (await getFreePort()))
  const server = await startServer(httpPort)
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apikey-smoke-ud-'))
  const env = { ...process.env, APKEY_USER_DATA_DIR: userDataDir }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(
    ELECTRON,
    ['.', `--remote-debugging-port=${cdpPort}`, '--disable-gpu', '--no-sandbox'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let logs = ''
  child.stdout.on('data', (d) => (logs += d.toString()))
  child.stderr.on('data', (d) => (logs += d.toString()))

  let ws
  try {
    const page = await waitForPage(cdpPort)
    const cdp = await connectCdp(page.webSocketDebuggerUrl)
    ws = cdp.ws
    await cdp.send('Runtime.enable', {})
    const result = await evaluateWithRetry(cdp, buildExpression(httpPort))

    if (result.exceptionDetails) {
      throw new Error('页面内执行异常: ' + JSON.stringify(result.exceptionDetails))
    }

    const payload = result.result.value
    const failed = payload.checks.filter((c) => !c.ok)

    console.log(`[smoke] Electron ${payload.electron}`)
    for (const c of payload.checks) {
      console.log(
        `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`,
      )
    }

    if (failed.length > 0) {
      console.error(`[smoke] ${failed.length} 项失败`)
      process.exitCode = 1
    } else {
      console.log(`[smoke] 全部 ${payload.checks.length} 项通过`)
    }
  } catch (error) {
    console.error('[smoke] 执行失败:', error.message)
    if (logs.trim()) console.error(logs.trim().split('\n').slice(-20).join('\n'))
    process.exitCode = 1
  } finally {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    killTree(child)
    server.close()
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 清理失败忽略 */
    }
    setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
}

main()
