# API Key 测试工具

大模型 API Key 连通性测试工具，支持多提供商、多API模式。

## 功能特性

- ✅ 自定义提供商名称和 Base URL
- ✅ 支持 OpenAI / OpenAI Responses / OpenAI-like / OpenAI 图片 / OpenAI 语音 / Anthropic / Azure OpenAI / Google Gemini / Ollama / Jev (TypeSafe) 多种API模式
- ✅ 选择已保存的提供商后自动填充 Base URL 和 API 模式（菜单包含历史记录中的提供商）
- ✅ 获取可用模型列表
- ✅ 指定某个模型单独进行连通测试（支持从检测结果选择或手动输入）
- ✅ 测试每个模型的响应速率（并发测试）
- ✅ 模型列表搜索、批量勾选后只测选中项
- ✅ 聊天测试支持流式输出（SSE / NDJSON），可中途停止并保留已输出内容
- ✅ 对话支持发图：点击或直接粘贴图片，自动压缩后按各协议的多模态格式发送
- ✅ 模型指纹匹配：23 个模型家族特征库（含版本自述探针），展示匹配度百分比
- ✅ 模型能力测评：38 道固定题 + 10 道随机模板题（每次运行数字不同，防背题库），7 维度按难度加权评分
- ✅ 稳定性采样：N 次连打统计成功率、P50/P95 延迟与 429 限流次数
- ✅ 一致性探测：同一问题重复采样，区分「多模型轮换」与「稳定降级」
- ✅ 代码题本地沙箱执行：直接跑测试用例判分，不靠关键词
- ✅ 一键渠道体检：连通→模型→测速→指纹→能力→稳定性→一致性，产出可复制的 Markdown 报告
- ✅ 体检结论写入历史记录，可对比同一渠道多次结果（显示分数变化 ↑↓ 与口径版本）
- ✅ 聊天测试与模型测评合并在同一卡片（选项卡切换），测试结果内嵌在配置卡片下方
- ✅ 多渠道管理：把配置存为渠道，在「渠道」页签一键切换、直接对该渠道跑体检、查看最近分数
- ✅ 渠道对比：一屏并排对比各渠道的综合分、能力、稳定性、一致性，标出最优/最低并可复制为 Markdown 表格
- ✅ 版本显示与更新提醒：配置卡片显示当前版本，检测到新版本时才出现更新按钮
- ✅ 中转站：本地起一个 OpenAI 兼容端点，把多个上游按模型名聚合转发（支持流式）
- ✅ 单实例运行（重复启动只聚焦已有窗口），错误日志超 1MB 自动归档
- ✅ 测试历史记录保存与查看
- ✅ 卡片图钉固定（锁定位置和尺寸）与主窗口等比例缩放
- ✅ Windows 桌面应用 (.exe)

## 技术栈

- Electron 45（主进程 `net.fetch` 代理所有 API 请求，含流式转发）
- Vue 3 + Pinia
- Vite
- TailwindCSS
- electron-builder 26

## 项目结构

```
apikey-test-tool/
├── package.json          # 项目配置
├── vite.config.js        # Vite配置
├── electron/
│   ├── main.cjs          # 主进程：HTTP/SSE 代理、密钥加密、错误日志、窗口状态
│   └── preload.cjs       # 预加载脚本（contextBridge 暴露 IPC）
├── index.html
├── src/
│   ├── main.js           # Vue入口
│   ├── App.vue           # 主组件（卡片式可拖拽布局）
│   ├── api/
│   │   ├── http.js       # 统一 HTTP 出口（IPC 代理 / 浏览器回退 axios / 流式）
│   │   ├── multimodal.js # 统一图片消息 → OpenAI/Responses/Anthropic/Gemini/Ollama 格式
│   │   ├── sse.js        # SSE 与 NDJSON 增量解析器
│   │   ├── modes.js      # API 模式适配器注册表
│   │   ├── openai.js / responses.js / anthropic.js / azure.js
│   │   ├── gemini.js / ollama.js / jev.js / openai-media.js
│   │   ├── evalApi.js    # 指纹匹配、能力测评、稳定性与一致性采样
│   │   ├── codeSandbox.js# 代码题静态检查与本地执行
│   │   └── checkup.js    # 一键体检编排（串联六步，产出报告）
│   ├── components/       # ConfigPanel / ResultPanel / HistoryPanel / ChannelPanel / EvalPanel / ChatPanel / Toast
│   ├── stores/           # Pinia：test / history / channel / chat / eval / toast
│   ├── data/             # 指纹库、题库
│   └── utils/
│       ├── storage.js    # JSON 持久化（串行写入 + 密钥加密）
│       ├── report.js     # 体检评分与 Markdown 报告生成
│       ├── comparison.js # 渠道横向对比（聚合 / 排序 / Markdown 表格）
│       └── update.js     # 版本比较与 Release 查询
└── README.md
```

## 使用说明

### 开发模式

```bash
npm install
npm run dev
```

### 打包发布

```bash
npm run build
```

打包后的文件位于 `dist-app/` 目录（前端产物在 `dist/`，由 electron-builder 打入 exe）。

## 配置说明

| 参数 | 说明 |
|------|------|
| 提供商 | 自定义名称，如 "OpenAI"、"硅基流动" |
| Base URL | API地址，见下表 |
| API模式 | OpenAI / OpenAI Responses / OpenAI-like / OpenAI 图片 / OpenAI 语音 / Anthropic / Azure OpenAI / Google Gemini / Ollama / Jev (TypeSafe) |
| API Key | 您的API密钥（Ollama 本地模式可留空；输入框默认遮蔽，可点「显示」查看） |
| 并发数量 | 内置固定为 5（`runConcurrentBatch`），避免触发网关限流 |

### 各模式 Base URL 示例

| API模式 | Base URL 示例 |
|---------|---------------|
| OpenAI | `https://api.openai.com/v1` |
| OpenAI Responses | `https://api.openai.com/v1` |
| OpenAI-like | 任意兼容服务，如 `https://api.siliconflow.cn/v1` |
| OpenAI 图片 | `https://api.openai.com/v1`（文生图 `gpt-image-1`/`dall-e-3`，图像理解 `gpt-4o`/`gpt-4o-mini`） |
| OpenAI 语音 | `https://api.openai.com/v1`（TTS 合成 `tts-1`/`tts-1-hd`/`gpt-4o-mini-tts`，识别 `whisper-1`） |
| Anthropic | `https://api.anthropic.com` |
| Azure OpenAI | `https://{资源名}.openai.azure.com`（可附加 `?api-version=...`，默认 `2024-06-01`） |
| Google Gemini | `https://generativelanguage.googleapis.com` |
| Ollama | `http://localhost:11434`（无需 API Key） |
| Jev (TypeSafe) | `https://api.typesafe.ai`（System One 决策模型，端点 `/v1/systemone`，模型名如 `jev-latest`） |

选择已保存过的提供商名称时会自动带出其 Base URL、API 模式与 API Key；Azure 模式下"模型"即部署名称（deployment name）。Jev 为结构化决策模型（Noul/Choice/Score），聊天调用会把消息作为 state 返回判定结果。

## 测试Prompt

固定测试内容：`"这是大模型连通性测试"`

## 模型测评（新增面板）

在「模型测评」面板选择检测到的模型后：

- **指纹**：依次发送 7 个探测提示词（自述身份、开发方、版本、经典陷阱题、安全拒绝风格等），与 23 个模型家族的特征标记按权重比对，给出匹配度百分比与最佳匹配。新增的「版本」探针用于识别同家族内的降级替换（拿小模型冒充大模型）。
- **能力**：38 道固定题 + 3 道代码题 + 10 道参数化模板题（追及、工程、鸡兔同笼、钟面夹角、条件筛选求和等，数字每次随机），共 51 题，7 维度按难度加权。固定题还带同义改写池（同一知识点多种问法随机取一条），进一步打断「题干原文 → 答案」的死记硬背；同一种子可复现，便于跨渠道对比。判分支持数字容错（回复里出现正确数字即算对）、并列答案（任一命中）、全关键词、正则四种规则，并做了全角字符归一。
- **稳定**：固定短 prompt 连打 5 次，统计成功率、P50/P95/最慢延迟与 429 限流次数。
- **一致**：同一问题重复采样 4 次，输出一致率与正确率。一致率低说明答案前后矛盾（疑似多模型轮换/负载分流），正确率低但一致率高说明「稳定地答错」（疑似降级成小模型）。
- **代码题本地执行**：3 道代码题不看关键词，直接把模型返回的函数丢进本地沙箱跑测试用例。防护分三层：静态黑名单（require/process/eval/死循环等直接拒执行）→ 独立子进程（3 秒硬超时，不传任何密钥）→ vm 禁用代码生成（阻断 constructor 逃逸）。执行不可用时自动降级为「未执行」，且不计入评分分母。
- **体检**：一键串联连通、模型列表、抽样测速、指纹、能力、稳定性、一致性七步，给出 0-100 综合评分（口径 v2：能力 55% + 稳定性 30% + 一致性 15%）与风险提示，并生成 Markdown 报告，可复制或保存到 `userData/exports/`。

指纹库与题库分别维护在 `src/data/fingerprints.js`、`src/data/questionBank.js`，可直接扩展：加家族只需在 `FINGERPRINT_LIBRARY` 里补 `markers`，加模板题只需往 `QUESTION_TEMPLATES` 里加一个 `build(rng)`。

## 测试

```bash
npm test          # 单元/组件测试（39 文件 / 465 用例）
npm run smoke     # 端到端冒烟：真实 Electron，校验 HTTP 代理、SSE 分块、密钥加解密、代码沙箱、路径越权
npm run lint
npm run format:check
```

`npm run smoke` 需要先 `npm run build`（读取 `dist/`），退出码非 0 表示失败，可直接接入 CI。冒烟会使用临时 userData 与动态端口，因此可以在应用已经打开的情况下运行，也不会污染真实历史记录。

## 数据存储

测试历史保存在 `userData/history.json`，提供商配置保存在 `userData/providers.json`（`userData` 即 `%APPDATA%\APIKey测试工具`）。

- **API Key 加密**：落盘前经主进程 `safeStorage`（Windows DPAPI / macOS Keychain）加密为 `enc:<base64>`；读取时自动解密。旧版本明文数据仍可读，并在下次保存时自动转为密文。
- **换机/换用户**：DPAPI 绑定当前 Windows 用户，复制 `history.json` 到其他机器后 Key 无法解密，会显示为空，需重新输入。
- **写入串行化**：同一文件的读-改-写加锁，避免并发保存互相覆盖；写入失败会通过 toast 明确提示，不再静默丢失。
- **渠道**：`userData/channels.json` 保存多条完整配置（名称 / Base URL / 模式 / 加密后的 Key）。与 `providers.json` 的区别是后者只记「名字→地址/模式」，渠道是可直接切换使用的完整配置。

## 安全说明

- 所有 API 请求由主进程 `net.fetch` 发出（渲染进程只通过 IPC 传参），因此不受 CORS 限制，官方 OpenAI / Anthropic 端点可直连。
- 流式响应同样走主进程：主进程逐块读取 `response.body` 并推给渲染进程，渲染进程按 `requestId` 分发；中途停止会 abort 主进程请求，已收到的内容保留。
- 渲染进程开启 `contextIsolation` + `sandbox`，禁用 `nodeIntegration`；IPC 文件读写限制在 `userData` 目录内（`path.relative` 校验，杜绝同前缀兄弟目录绕过）。
- `index.html` 内置 CSP，禁止加载远程脚本。
- 注意：历史记录仍包含 Base URL 与模型列表等元数据；对外分享 `history.json` 前请确认无敏感信息。

## 中转站

「中转站」卡片在本机起一个 OpenAI 兼容端点（默认 `http://127.0.0.1:8787/v1`），把多个上游聚合成一个入口：

- 客户端（OpenAI SDK、Chatbox、Cherry Studio 等）把 Base URL 指过来，Key 随便填，按模型名路由到对应上游
- 上游响应（含 SSE 流）原样透传，不缓冲不改写
- 内置模板：商汤日日新、书生·端砚、Agnes AI、OpenAI、DeepSeek、阿里通义、智谱 GLM；也可完全自定义
- 支持「拉取模型」直接读上游 `/v1/models`，不用手抄模型名
- 只监听 `127.0.0.1`，不对外暴露；应用退出自动关闭

**路由与故障转移**：模型名精确命中 → 路由过去；同一模型可配多个上游，按列表顺序优先，前面的返回 429/5xx 或网络错误会自动切到下一个；4xx（除 429）不重试、原样透传；全部不可达才返回 502。响应头 `x-relay-provider` 标明实际服务的上游。

**限流与并发**：每个上游可设并发上限（默认 4）与每分钟请求数（默认不限）。并发满了会排队等槽位（默认 10s 超时），RPM 用尽或排队超时算「可重试」，自动切下一个上游；全部被限流时返回 429 并带 `Retry-After`。卡片上实时显示 `1/4 并发 · 60 RPM`。

**请求日志**：卡片内置日志面板，记录时间 / 模型 / 实际上游 / 状态码 / 耗时，最多 200 条，失败标红——能直接看出"谁挂了、切到了谁"。

## 图片输入（多模态）

对话面板支持附加图片（点击 🖼 选择，或直接把截图粘贴进输入框），最多 4 张：

- 发送前统一压缩到长边 1568px 以内（视觉模型的有效分辨率上限），PNG 保留透明通道，其余转 JPEG；压缩失败会退回原图，不会卡住发送
- 各协议自动转成自己的结构：OpenAI/Azure 用 `image_url` 数组、Responses 用 `input_image`、Anthropic 用 base64 `image` block、Gemini 用 `inline_data`、Ollama 用独立的 `images` 数组
- 仅对支持视觉的模式开放（OpenAI / OpenAI-like / Responses / Anthropic / Azure / Gemini / Ollama）；图片生成、语音、Jev 模式会提示不支持并阻止发送
- 注意：模式支持 ≠ 模型支持。选中的模型本身不支持图片时，服务端会返回错误，界面上会显示原始错误信息

## 流式支持范围

| API 模式 | 流式 | 协议 |
|---------|------|------|
| OpenAI / OpenAI-like | ✅ | SSE `choices[0].delta.content` |
| OpenAI Responses | ✅ | SSE `response.output_text.delta` |
| Anthropic | ✅ | SSE `content_block_delta` |
| Azure OpenAI | ✅ | SSE（同 OpenAI） |
| Google Gemini | ✅ | SSE `:streamGenerateContent?alt=sse` |
| Ollama | ✅ | NDJSON `/api/chat` |
| Jev / 图片 / 语音 | — | 结构化或二进制响应，无需流式 |

流式不可用时（如自建中转不支持）会自动走原非流式接口，面板逻辑一致。
