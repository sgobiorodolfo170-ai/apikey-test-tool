# API Key 测试工具

个人使用的桌面工具：测试大模型 API Key / 渠道的连通性、速度、模型能力与稳定性，并可将多个上游聚合成一个本地 OpenAI 兼容端点。

- 当前发布：Windows x64 便携版；macOS（Intel / Apple Silicon）dmg / zip
- macOS 包需在 macOS 上构建，未做代码签名与公证
- 无后端、无账号体系，所有数据保存在本机 `userData`

## 能做什么

- 支持 10 种 API 模式：OpenAI、OpenAI Responses、OpenAI-like、OpenAI 图片、OpenAI 语音、Anthropic、Azure OpenAI、Google Gemini、Ollama、Jev (TypeSafe)
- 连通测试、模型列表获取、单模型测试、批量测速
- 模型指纹匹配（23 个家族）、能力测评、稳定性采样、一致性探测
- 一键渠道体检，产出 0–100 综合分与可复制的 Markdown 报告
- 多渠道保存、切换、横向对比，历史记录保留最近 100 条
- 聊天测试：流式输出、中途停止、图片输入（按各协议转换）
- 本地中转站：多上游聚合、多 Key 轮询、故障转移、限流、额度窗口、调用日志与统计
- 卡片拖拽/缩放/图钉固定，布局持久化

## 安装与启动

**Windows**：发布页提供目录版 zip，解压后运行 `APIKey测试工具.exe`；本地执行 `npm run build:win` 生成单文件 portable exe。未做代码签名，首次运行可能出现 SmartScreen 提示，选择“更多信息 → 仍要运行”。

**macOS**：打开 dmg，把应用拖入 `Applications`。未签名/未公证时首次打开需右键选择“打开”；如被隔离，可执行：

```bash
xattr -dr com.apple.quarantine "/Applications/APIKey测试工具.app"
```

构建说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；macOS 包必须在 macOS 上执行 `npm run build:mac`。

**开发模式**：

```bash
npm install
npm run electron:dev   # Vite + Electron
npm run dev            # 仅浏览器（不持久化、无 IPC 代理）
```

## 5 分钟上手

1. 在“配置”里填写提供商名称、Base URL、API 模式、API Key（Ollama 可留空）。
2. 点“测试连接”，确认连通并获取模型列表；连接测试会对前 20 个模型抽样测速，避免中转站模型过多时等待过久。
3. 在模型列表中选一个模型，点“测试”做单模型验证；或勾选多个后“测试选中”。
4. 切到“模型测评”，先跑“指纹”，再跑“能力 / 稳定 / 一致”，或直接“一键体检”。
5. 体检完成后复制 Markdown 报告，或在历史记录里对比同一渠道的历次分数。

## API 模式与 Base URL

| 模式             | Base URL 示例                                              |
| ---------------- | ---------------------------------------------------------- |
| OpenAI           | `https://api.openai.com/v1`                                |
| OpenAI Responses | `https://api.openai.com/v1`                                |
| OpenAI-like      | 任意兼容服务，如 `https://api.siliconflow.cn/v1`           |
| OpenAI 图片      | `https://api.openai.com/v1`（`gpt-image-1` / `dall-e-3`）  |
| OpenAI 语音      | `https://api.openai.com/v1`（TTS / Whisper）               |
| Anthropic        | `https://api.anthropic.com`                                |
| Azure OpenAI     | `https://{资源名}.openai.azure.com`（模型名即 deployment） |
| Google Gemini    | `https://generativelanguage.googleapis.com`                |
| Ollama           | `http://localhost:11434`（无需 Key）                       |
| Jev (TypeSafe)   | `https://api.typesafe.ai`                                  |

Base URL 写错时，优先检查是否需要带 `/v1`；工具会尝试 `/chat/completions` 与 `/v1/chat/completions` 两个端点。

## 结果怎么读

- 综合分：能力 55% + 稳定性 30% + 一致性 15%；指纹只作身份参考，不计入质量分。
- 能力：38 道固定题（含同义变体）+ 3 道代码题 + 10 道参数化模板题，按难度加权。
- 稳定性：连续采样成功率、P50/P95 延迟与 429 次数。
- 一致性：同一问题多次采样，区分“前后矛盾”（疑似轮换）与“稳定答错”（疑似降级）。
- 代码题在本地子进程执行，环境不支持时标记“未执行”且不计入分母。
- 评分口径带版本号（`SCORE_VERSION`），跨版本分数不建议直接比较。
- 能力/稳定性缺失时标记“数据不足”，不会把剩余维度归一化成满分；一致性全部失败时标记“无法判定”。

## 数据与隐私

数据目录：

- Windows：`%APPDATA%\APIKey测试工具`
- macOS：`~/Library/Application Support/APIKey测试工具`

| 文件                | 内容                                      |
| ------------------- | ----------------------------------------- |
| `history.json`      | 测试/体检历史，最多 100 条                |
| `providers.json`    | 提供商名称 → Base URL / 模式（不含 Key）  |
| `channels.json`     | 渠道完整配置（含加密后的 Key）            |
| `relay.json`        | 中转站配置（含加密后的上游 Key）          |
| `relay-usage.json`  | 中转站日志、统计、额度事件（含 Key 尾号） |
| `app-settings.json` | 托盘/开机自启                             |
| `window-state.json` | 窗口位置与大小                            |
| `ERROR_LOG.md`      | 运行时错误日志，超过 1MB 归档为 `.1.md`   |
| `exports/`          | 手动导出的体检报告                        |

**Key 保护**：落盘前经主进程 `safeStorage` 加密（Windows DPAPI / macOS Keychain）。若系统不支持或加密失败，会退回明文并在控制台告警；换机/换用户后密文无法解密，需要重新输入。历史记录中包含加密后的 Key，对外分享 `history.json` 前请自行确认。

**本机边界**：所有 API 请求由主进程 `net.fetch` 发出；渲染进程开启 `contextIsolation` + `sandbox`，禁用 `nodeIntegration`；IPC 文件读写限制在 `userData` 目录内。

## 中转站

在历史卡片的“中转站”选项卡里启动，默认监听 `http://127.0.0.1:8787/v1`：

- 客户端把 Base URL 指过来，按模型名路由到对应上游；支持 SSE 流式透传
- 一个上游可配多把 Key，401/403/429 或网络错误时自动切换
- 支持模型别名、`/v1/embeddings`、精确缓存（仅非流式）
- 每个上游可设并发上限（默认 4）、RPM、排队超时
- 可选访问 Key 与多客户端 Key；默认本机免鉴权
- 额度窗口（5 小时 / 7 天）按 Key 分别记账，持久化到 `relay-usage.json`
- 调用监控与统计每 5 秒刷新（页面隐藏时暂停），最多保留 200 条日志 / 200 组统计
- 关闭窗口会隐藏到托盘，中转服务继续运行；托盘菜单可启停、开机自启、退出

完整说明（路由规则、429 撞墙判定、限额、缓存、故障排查）见 [docs/RELAY.md](docs/RELAY.md)。

## 开发与测试

```bash
npm test            # Vitest 单元/组件测试
npm run lint        # ESLint
npm run format:check
npm run build       # vite build + electron-builder
npm run smoke       # 真实 Electron 冒烟（需先 build）
```

架构、IPC 清单、存储结构、环境变量与打包说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 已知限制

- Windows 便携版无自动更新，升级需手动替换；macOS 包未签名/未公证，首次打开需右键“打开”。
- 代码题目前只执行 JavaScript；本地沙箱仅用于诊断，不是严格安全边界。
- 指纹匹配可被系统提示词欺骗，只作参考，不单独作为“假模型”判据。
- 中转站只监听本机，不做公网暴露；运行中修改端口需先停止服务。
- 历史记录上限 100 条；更多记录需要迁移存储（暂未做）。
