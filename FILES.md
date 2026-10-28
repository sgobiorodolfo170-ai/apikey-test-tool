# 项目文件清单

## 目录结构

```
apikey-test-tool/
├── package.json              # 依赖、脚本、electron-builder 配置
├── vite.config.js            # Vite 配置（dev 端口 3000，base './'）
├── vitest.config.js          # 单测配置（happy-dom）
├── tailwind.config.js        # TailwindCSS 主题（canvas/surface/accent 等色板）
├── postcss.config.js
├── eslint.config.js
├── .prettierrc
├── index.html                # 渲染进程入口（含 CSP）
├── README.md
├── FILES.md                  # 本文件
├── ERROR_LOG.md              # 运行时错误日志模板（实际写入 userData）
├── .github/workflows/ci.yml  # CI：lint → format:check → test
├── .husky/pre-commit         # 提交前 lint-staged
│
├── electron/
│   ├── main.cjs              # 主进程：窗口、HTTP 代理、safeStorage、错误日志、IPC
│   └── preload.cjs           # contextBridge 暴露 electronAPI
│
├── src/
│   ├── main.js               # Vue 入口（Pinia + style.css）
│   ├── App.vue               # 主组件：vue-grid-layout 卡片布局、图钉固定、等比缩放
│   ├── style.css             # 全局样式与组件类（card / input / btn-*）
│   │
│   ├── api/                  # 协议适配层
│   │   ├── multimodal.js     # 图片消息 → 各协议多模态格式
│   │   ├── http.js           # 统一 HTTP 出口：IPC 代理 / 浏览器回退 axios / 流式
│   │   ├── sse.js            # SSE 与 NDJSON 增量解析器（跨块缓冲）
│   │   ├── modes.js          # API 模式注册表（10 种模式 → 统一 adapter 接口）
│   │   ├── utils.js          # URL 拼接、错误归一、并发批处理、AbortController 注册表
│   │   ├── openai.js         # OpenAI / OpenAI-like（含 max_tokens 兼容重试、流式）
│   │   ├── responses.js      # OpenAI Responses API（流式）
│   │   ├── anthropic.js      # Anthropic Messages（流式）
│   │   ├── azure.js          # Azure OpenAI（deployment 作为模型名，流式）
│   │   ├── gemini.js         # Google Gemini（streamGenerateContent，流式）
│   │   ├── ollama.js         # 本地 Ollama（NDJSON 流式）
│   │   ├── jev.js            # Jev / TypeSafe System One
│   │   ├── openai-media.js   # 图片生成/理解、TTS/ASR（含 SD WebUI、Imagen、ElevenLabs、Azure TTS）
│   │   ├── evalApi.js        # 指纹匹配 + 能力测评 + 稳定性 + 一致性（重试/节流/兜底时限/加权判分）
│   │   ├── codeSandbox.js    # 代码题静态检查与本地执行校验
│   │   └── checkup.js        # 一键体检编排：连通→模型→测速→指纹→能力→稳定性→报告
│   │
│   ├── components/
│   │   ├── ConfigPanel.vue   # 配置：提供商、Base URL、API Key（遮蔽）、模型列表
│   │   ├── ResultPanel.vue   # 连接结果与模型速率
│   │   ├── HistoryPanel.vue  # 历史记录
│   │   ├── ChannelPanel.vue  # 渠道列表（切换 / 体检 / 删除）
│   │   ├── ChannelCompare.vue# 渠道对比浮层
│   │   ├── EvalPanel.vue     # 指纹匹配 / 能力测评
│   │   ├── ChatPanel.vue     # 聊天测试（流式渲染 + 停止）
│   │   └── Toast.vue         # 全局提示
│   │
│   ├── stores/               # Pinia
│   │   ├── testStore.js      # 连接测试、模型测试、结果保存
│   │   ├── historyStore.js   # 历史记录读写
│   │   ├── channelStore.js   # 渠道 CRUD 与「应用到配置」
│   │   ├── updateStore.js    # 启动时检查更新
│   │   ├── chatStore.js      # 聊天消息
│   │   ├── evalStore.js      # 测评状态与进度
│   │   └── toastStore.js     # 提示队列
│   │
│   ├── data/
│   │   ├── fingerprints.js   # 指纹库：7 个探针 × 23 个模型家族
│   │   └── questionBank.js   # 能力题库：38 固定题（含同义变体）+ 3 代码题 + 10 参数化模板
│   │
│   ├── utils/
│   │   ├── storage.js        # JSON 持久化：串行写入、apiKey 加密、版本化
│   │   ├── image.js          # 图片压缩（长边 1568 / JPEG 0.85）
│   │   ├── comparison.js     # 渠道横向对比聚合与 Markdown 表格
│   │   ├── update.js         # 版本比较与 GitHub Release 查询
│   │   └── report.js         # 体检评分（能力 60% + 稳定性 40%）与 Markdown 报告
│   │
│   └── __tests__/            # 测试 setup 与 electronAPI mock
│       └── setup.js
│
├── scripts/
│   └── smoke.cjs             # E2E 冒烟：真实 Electron + CDP 校验 IPC/流式/加密/路径
│
├── dist/                     # vite build 产物（前端）
└── dist-app/                 # electron-builder 产物（portable exe）
```

## 测试

```bash
npm test          # vitest run，34 个文件 / 409 个用例
npm run smoke     # 端到端冒烟（需先 npm run build）
npm run lint
npm run format:check
```

测试覆盖：9 个 API 适配器（含 6 种模式的流式）、HTTP 门面（IPC / axios / 流式三条路径）、
SSE 与 NDJSON 解析器、存储层（加密/并发/失败）、判分与稳定性统计、体检编排与报告生成、
5 个组件、5 个 store。

## 构建产物

| 产物 | 路径 | 说明 |
|------|------|------|
| 前端静态文件 | `dist/` | vite 输出，被 electron-builder 打入 exe |
| 便携版 exe | `dist-app/APIKey测试工具 1.0.0.exe` | Windows x64 portable，无需安装 |

## 功能清单

- [x] 自定义提供商名称 / Base URL / API Key
- [x] 10 种 API 模式（OpenAI、Responses、OpenAI-like、图片、语音、Anthropic、Azure、Gemini、Ollama、Jev）
- [x] 模型列表获取（多端点回退、多响应格式兼容）
- [x] 全量并发测速 + 单模型连通测试
- [x] 模型指纹匹配（23 家族 + 版本探针）、能力测评（38 固定 + 10 随机题）
- [x] 稳定性采样（成功率 / P50 / P95 / 429 计数）
- [x] 一致性探测（一致率 / 正确率 / 轮换与降级判定，计入评分 15%）
- [x] 题库同义变体轮换（防背原文）、评分口径版本号 v2、历史分数变化对比
- [x] 代码题本地沙箱执行（静态黑名单 + 子进程 + 3 秒超时）
- [x] 一键渠道体检 + Markdown 报告（可复制 / 保存到 userData/exports）
- [x] 体检结论写入历史，形成可对比的渠道档案
- [x] 多渠道管理（保存 / 切换 / 单渠道体检 / 删除）
- [x] 渠道横向对比（综合分/能力/稳定性/一致性并排、最优最低标记、复制 Markdown）
- [x] 版本显示与更新检查（仅在有新版本时显示更新按钮）
- [x] 对话发图（压缩 + 五种协议多模态适配 + 模式能力校验）
- [x] 模型列表搜索与批量测试
- [x] 聊天测试（6 种模式支持流式，可中途停止）
- [x] 历史记录保存 / 加载 / 删除 / 清空
- [x] 卡片拖拽、缩放、图钉固定、布局持久化
- [x] 主进程 HTTP / SSE 代理（绕开 CORS）
- [x] API Key 加密存储（safeStorage）
- [x] 单实例运行、错误日志 1MB 自动归档
- [x] 运行时错误日志（userData/ERROR_LOG.md）
- [x] E2E 冒烟（`npm run smoke`）

## 运行时

- Electron 45.0.0 / electron-builder 26.18.0 / Node 22
