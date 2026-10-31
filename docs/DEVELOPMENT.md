# 开发说明

面向维护者的工程说明：架构、IPC、存储、测试与打包。用户使用说明见 [README](../README.md)，中转站细节见 [RELAY.md](RELAY.md)。

## 技术栈

- Electron 45（主进程 `net.fetch` 代理 HTTP/SSE）
- Vue 3 + Pinia + Vite
- TailwindCSS
- electron-builder 26
- Vitest + happy-dom（单元/组件）

## 目录与职责

```text
electron/
  main.cjs      窗口/托盘/生命周期、HTTP/SSE 代理、文件 IPC、safeStorage、代码执行
  preload.cjs   contextBridge 暴露 electronAPI（白名单 IPC）
  relay.cjs     本地中转站：路由、故障转移、限流、额度、缓存、日志/统计
src/
  api/          协议适配器、统一 HTTP 出口、SSE/NDJSON 解析、体检/测评编排
  components/   配置、历史、渠道、中转站、调用监控、统计、聊天、测评、结果
  stores/       Pinia：test / history / channel / relay / chat / eval / toast / update
  data/         指纹库、题库、中转站预设
  utils/        持久化、报告、对比、图片压缩、版本比较
  __tests__/    relay 集成测试与测试 setup
scripts/
  smoke.cjs     真实 Electron + CDP 冒烟
docs/           RELAY.md、DEVELOPMENT.md
```

## 数据流

1. 组件 → Pinia store → `src/api/*` 适配器。
2. 适配器统一走 `src/api/http.js`：Electron 内走 `electronAPI.request/stream`，纯浏览器回退 axios / fetch。
3. 主进程 `main.cjs` 用 `net.fetch` 发出请求，流式响应按 `requestId` 推送回渲染进程。
4. 持久化统一走 `src/utils/storage.js` → `electronAPI.readFile/writeFile`，主进程限制在 `userData` 内。
5. 中转站完全在主进程 `relay.cjs` 中运行，渲染进程只做配置与展示。

## 适配器契约

`src/api/modes.js` 注册 10 种模式（9 组适配器，`openai-like` 复用 OpenAI）：

```js
{
  testConnection(config) -> { connected, connectTime, usedEndpoint?, error?, warning?, status? }
  listModels(config) -> { success, models: [{ id, ... }], error?, status? }
  testModelLatency(config, model) -> { model, latency, status, error? }
  testModels(config, models, concurrency) -> 上述结果数组
  chat(config, { model, messages, maxTokens, timeout }) -> string
  chatStream?(config, { model, messages, maxTokens, timeout, signal }, onDelta) -> string
}
```

未知 `apiMode` 现在会直接抛错，不再静默回退到 OpenAI；新增模式时同时更新 `API_MODES`、`ADAPTERS` 与测试。

## IPC 清单

主进程注册 21 个 channel（`electron/main.cjs`）：

- 文件/系统：`get-user-data-path`、`read-file`、`write-file`、`exists-file`、`log-error`
- HTTP：`http-request`、`http-stream`、`http-abort`
- 代码执行：`run-code`
- 外部链接：`open-external`（仅 GitHub https）
- 中转站：`relay-start`、`relay-stop`、`relay-status`、`relay-update`、`relay-models`、`relay-logs`、`relay-clear-logs`、`relay-stats`、`relay-stats-clear`
- 密钥：`secure-store`、`secure-available`

`preload.cjs` 只暴露上述方法；事件订阅仅允许 `app-cleanup`。

## 存储结构

文件均为 `{ version: 1, data: ... }`：

| 文件 | data 形状 |
|---|---|
| `history.json` | 数组，最多 100 条 |
| `providers.json` | `{ [name]: { baseUrl, apiMode, updatedAt } }` |
| `channels.json` | 数组，含 `id/name/baseUrl/apiMode/apiKey` |
| `relay.json` | `{ port, providers, apiKey, clientKeys, sticky, autoStart, cache }` |
| `relay-usage.json` | `{ logs, stats, quota }`，由主进程维护 |

- 同一文件的读-改-写通过 `withFileLock` 串行化。
- `apiKey`/`api_key` 字段在落盘前递归替换为 `enc:<base64>`；读取时解密。
- 读取时校验 data 形状；JSON 损坏或形状不符会另存为 `<name>.corrupt-<时间戳>.json` 并返回默认值。
- 写入走主进程“临时文件 + rename”原子替换，文件 IPC 已改为异步；错误日志使用追加写。
- `relay-usage.json` 由主进程异步串行原子写，避免日志/额度较大时阻塞主进程。

## 测评与评分

- `src/api/evalApi.js`：指纹 7 探针、能力 51 题（38 固定 + 3 代码 + 10 模板）、稳定性 N 次、一致性 3 题 × N 次。
- `src/api/checkup.js`：连通 → 模型 → 抽样测速 → 指纹 → 能力 → 稳定 → 一致 → 报告，任一步失败不中断。
- `src/utils/report.js`：`SCORE_VERSION = 2`，权重 `55/30/15`；指纹不计分。
- 代码题在 `electron/main.cjs` 的子进程中执行，超时 3s。

## 命令

```bash
npm run dev             # Vite（浏览器调试，无持久化）
npm run electron:dev    # Vite + Electron
npm test                # Vitest
npm run test:watch
npm run lint
npm run format:check
npm run build           # vite build + electron-builder（当前平台）
npm run smoke           # 需先 build；真实 Electron + CDP
```

## 环境变量

应用不读取 `.env`（没有 dotenv，也不使用 `import.meta.env`）。可用的进程环境变量：

| 变量 | 用途 |
|---|---|
| `APKEY_USER_DATA_DIR` | 覆盖 userData 目录；同时跳过单实例锁（冒烟用） |
| `NODE_ENV=development` 或 `--dev` | 加载 `http://localhost:3000` 并打开 DevTools |
| `SMOKE_CDP_PORT` / `SMOKE_HTTP_PORT` | 冒烟固定端口（默认动态分配） |

## 测试

- `src/api/__tests__`：适配器、HTTP、SSE、测评、沙箱
- `src/components/__tests__`：主要面板交互
- `src/stores/__tests__`：store 状态流转
- `src/utils/__tests__`：存储、报告、对比、图片、更新
- `src/__tests__`：relay 集成测试、路径安全、setup/electronAPI mock

用例数量以 `npm test` 输出为准，不在文档里写死。`npm run smoke` 覆盖 HTTP 代理、SSE 分块、密钥加解密、路径越权、中转站启停/聚合/转发/故障转移/限流/日志。

## 打包

当前 `package.json` 只配置 Windows：

- `win.target: portable`、`arch: x64`
- 产物：`dist-app/APIKey测试工具-<版本>-portable.exe`
- 图标：`ico/icon-256x256.png`（macOS 需要 512/1024 或 `.icns`，后续补）

macOS 打包与平台行为（Dock、托盘、窗口恢复、登录项）在路线图最后处理。未做代码签名与公证。

## 约定

- `src` 使用 ESM；`electron` 使用 CJS。
- Prettier：无分号、单引号、行宽 100；ESLint flat config。
- 注释解释“为什么”，不重复代码字面意思。
- 文档只保留三份：README（用户）、RELAY（中转站）、DEVELOPMENT（维护者）；不新增 `FILES.md` 之类的目录清单。