# 借鉴点落地验收清单

- 版本：2026-11-12
- 实施状态：P1、P2、P3、P4 已实施（2026-11-12），P5 起待实施
- 对应计划：[2026-11-12-borrowing-plan.md](./2026-11-12-borrowing-plan.md)
- 使用方式：每完成一项，勾选并在 `docs/verification/` 对应文件记录命令、环境、结果与已知边界。

## 0. 通用门禁

每个阶段合并前必须全部通过：

- [x] `npm run lint`
- [x] `npm run format:check`
- [x] `npm test`
- [x] 新增/修改的纯函数有单测，且不依赖网络
- [x] 新增配置字段有默认值与迁移逻辑
- [x] 涉及 UI 的改动有组件测试或手动验收记录
- [x] 不引入新的硬依赖；可选能力缺失时可降级
- [x] 文档与实现一致，未把“计划”写成“已完成”

## 1. P1 A1 + B1：注册表与能力降级

### A1 统一注册表

- [x] `src/data/providers.json` 覆盖现有 7 个中转预设与 10 种 apiMode
- [x] `src/core/providers/registry.js` 提供 `getProvider` / `listProviders` / `buildAdapters` / `validateDescriptor`
- [x] `src/api/modes.js` 的 `API_MODES`、`ADAPTERS`、`getApiAdapter` 行为与改造前一致
- [x] `src/data/relayPresets.js` 的 `RELAY_PRESETS`、`findPreset`、`createProviderFromPreset` 行为一致
- [x] `electron/generated/providers.cjs` 由脚本生成，`npm run generate:registry` 可重复执行
- [ ] 只改 JSON 新增一个 OpenAI-like 供应商后：
  - [ ] 配置页供应商下拉出现
  - [ ] 中转站预设出现
  - [ ] `/v1/models` 返回该供应商模型（启用且有模型时）
- [x] 未知 `apiMode` 仍抛错，不静默回退 OpenAI

### B1 能力降级

- [x] `src/core/capabilities.js` 覆盖 `gateway` / `lan` / `updater` / `tray` / `notifications` / `channels`
- [ ] 关闭 `lan` 后应用启动、配置页、测试流程不受影响
- [ ] 关闭 `updater` 后更新入口显示“未启用”，不报错
- [ ] 缺失能力在 UI 中有明确文案，不出现空白或禁用无解释
- [x] 启动日志记录能力矩阵快照

### 证据

- [x] `docs/verification/A1-provider-registry.md`
- [x] `docs/verification/B1-capability-degradation.md`

## 2. P2 A2 + A4：探测状态机与指标

### A2 状态机

- [x] `ProbeState` 枚举与迁移表实现一致
- [x] 2xx → `reachable`
- [x] 401/403 → `rejected`，不自动重试
- [x] 429 + `rate_limit` → `rate_limited`，按 `Retry-After` 冷却
- [x] 429 + `quota_exhausted`/`insufficient_quota` → `quota_exhausted`
- [x] 连续 5 次 500 后仍为 `unknown`，不显示“Key 无效”
- [x] 超时/网络错误不改变上一次 `reachable`
- [x] 探测结果包含 `checkedAt`、`latencyMs`、`errorClass`、`evidence`
- [ ] 测试端与中转端对同一响应判定一致（契约测试）

### A4 指标

- [x] `metrics/usage.js` 输出 `ttftMs` / `streamMs` / `tps` / `inputTokens` / `outputTokens` / `reasoningTokens` / `usageMissing`
- [x] TTFT 与 decode 速度分离，不使用总耗时冒充速度
- [x] reasoning token 不计入输出速度
- [x] `usage` 缺失时标记 `usageMissing: true`，不伪造 0
- [ ] 物理请求数与逻辑回合数分开统计
- [x] `relay-usage.json` 从 v1 无损迁移到 v2
- [x] 统计页/用量页显示 TTFT、TPS，reasoning 单列
- [x] 历史记录读取不报错

### 证据

- [x] `docs/verification/A4-probe-state.md`（A2 状态机 + testStore 接入）
- [x] `docs/verification/A2-relay-ttft-tps.md`（A4 relay 指标 + 面板展示）

## 3. P3 A3 + A6：流式与失败策略

### A3 SSE

- [x] `sniff.js` 在 `Content-Type: text/plain` 下仍识别 SSE
- [x] 跨 chunk 的中文、emoji、`\r\n` 不乱码（既有 sse.js 缓冲 + TextDecoder stream 模式）
- [x] 心跳注释行（`: ping`）不产生空 delta（既有 sse.js 跳过 `:` 开头行）
- [x] 流式响应带 `stream-heartbeat` 事件，前端可区分“慢”和“断”（主进程每 15s 发 `heartbeat`）
- [ ] 上游在输出 3 个 delta 后断开 → `stream_truncated`
- [x] 截断请求不重试、不重复计费（policy `hasOutput → abort`）
- [ ] 未输出任何 delta 即断开 → 可按策略重试
- [x] OpenAI / Anthropic / Gemini 事件归一到同一 `StreamEvent`（含 Ollama / Responses）

### A6 失败分类与重试

- [x] `classify.js` 与 `electron/lib/failures.cjs` 对同一输入分类一致（契约测试）
- [x] `request` 错误不切 Key、不切上游
- [x] `account` 错误切同上游下一把 Key
- [x] `provider` 错误切下一个上游
- [x] `transient` 错误按退避重试
- [x] 429 不自动重试，按 `Retry-After` 冷却
- [x] 已输出内容后不重试
- [x] 重试链路保留 `x-relay-provider` 与尝试次数日志（既有行为未变）
- [x] eval 失败题轮转逻辑不变（未改动）

### 证据

- [x] `docs/verification/A3-streaming.md`
- [x] `docs/verification/A6-failure-policy.md`

## 4. P4 A5 + A10：网关与网络

### A5 本地网关

- [x] `/health` 始终开放
- [x] `/v1/models` 广播所有启用 provider 的模型与别名
- [x] `/v1/chat/completions` 支持流式与非流式
- [x] `/v1/messages` 支持 Anthropic 请求/响应与 SSE
- [x] `/v1/responses` 作为可选能力，未启用时返回明确 404/501
- [x] `/v1/embeddings` 行为不变
- [x] 设置访问 Key 后，除 `/health`/`OPTIONS` 外必须鉴权
- [x] 多客户端 Key 能正确归因到日志“客户端”
- [x] 未设 `defaultProviderId` 且模型未命中 → 404 `model_not_found`（行为不变）
- [x] 设 `defaultProviderId` 后模型未命中 → 走默认，响应头 `x-relay-provider`，日志 `routedBy: default`
- [x] 默认 provider 被禁用/无可用 Key → 明确 503，不静默切到未授权上游
- [ ] Claude Code / OpenAI SDK 各完成一轮真实或假上游对话（假上游集成测试已覆盖；真实 SDK 端到端未验证）

### A10 网络细节

- [x] `EADDRINUSE` 提示端口占用并给出可用替代端口
- [x] `EACCES` 提示权限不足，不建议改用管理员权限
- [x] LAN 默认关闭
- [x] 开启 LAN 必须设置访问 Key，UI 有风险提示
- [x] 非回环请求无 Key 被拒绝
- [x] LAN 地址列表过滤虚拟网卡，物理网卡优先
- [ ] 代理环境遵守 `NO_PROXY` / `no_proxy`（`resolveProxyBypass` 已实现并有单测；上游直连不经代理，Chromium 系统代理 bypass 未强制接管）
- [x] 端口变更需先停止服务，行为与现有文档一致

### 证据

- [x] `docs/verification/A5-gateway.md`
- [x] `docs/verification/A10-network.md`

## 5. P5 A7 + A9：升级与发布

### A7 升级完整性

- [ ] `release-manifest.json` 含 `version`、`files[]`（path/size/sha256）、`signature`
- [ ] 下载写入 staging，不直接覆盖运行目录
- [ ] 逐文件 size/hash 校验
- [ ] 校验失败拒绝安装并保留原目录
- [ ] 替换中断后下次启动可回滚
- [ ] 升级日志不包含明文凭据
- [ ] `updateStore` 显示校验/回滚结果

### A9 发布清单

- [ ] `node scripts/verify-manifest.cjs --write` 生成清单
- [ ] `node scripts/verify-manifest.cjs --check` 通过
- [ ] 篡改 `dist/assets/*.js` 一个字节后 `--check` 失败
- [ ] `verify-package.cjs` 复用 manifest hash，不产生第二套口径
- [ ] `build:*` 末尾自动生成并校验 manifest
- [ ] CI 中清单校验为独立 job，失败不发布

### 证据

- [ ] `docs/verification/A7-updater.md`
- [ ] `docs/verification/A9-release-manifest.md`

## 6. P6 A8 + B2：测试与证据

### A8 测试分层

- [ ] `unit`：纯函数，无网络、无 Electron
- [ ] `contract`：适配器/状态机/失败分类双实现一致
- [ ] `integration`：`fake-upstream.cjs` 覆盖 200/401/429/5xx/SSE 分块/截断/慢首包
- [ ] `smoke`：真实 Electron + CDP，保持现有覆盖
- [ ] `npm run test:watchdog` 无套件超时
- [ ] `npm run test:mutate` 至少 3 个关键断言变红
- [ ] 恢复变异后全绿
- [ ] 测试失败信息包含可复现命令

### B2 证据式文档

- [ ] `docs/verification/TEMPLATE.md` 含命令、环境、结果、边界、时间
- [ ] A1–A10、B1、B2 各有记录
- [ ] 记录区分“已验证”和“未验证”
- [ ] PR 模板包含“验证证据”必填项
- [ ] README/RELAY/DEVELOPMENT 不写死测试数量
- [ ] 每个能力至少一条可复制命令

### 证据

- [ ] `docs/verification/A8-testing.md`
- [ ] `docs/verification/B2-evidence-docs.md`

## 7. P7 渠道适配器与账号池

### 契约与宿主

- [ ] `src/core/channels/contract.js` 校验 `meta` / `credentials` / `quota` / `models` / `chat`
- [ ] `electron/channels/loader.cjs` 只加载带 manifest 的适配器
- [ ] `electron/channels/host.cjs` 子进程隔离，超时/崩溃只影响单渠道
- [ ] 适配器日志脱敏，不出现明文 Key
- [ ] 未签名/未声明权限的适配器默认不加载

### 账号池

- [ ] `apiKeys` 首次读取迁移为 `accounts`，旧字段只读兼容
- [ ] 账号可命名、分组、启用/禁用
- [ ] 429 锁定、冷却、半开恢复按 account id 隔离
- [ ] 共享组只绑定当前 provider，不同 provider 同名组合并不合并
- [ ] Key 尾号与账号标签在日志中可对应
- [ ] 日志与导出 JSON 不含明文凭据

### 额度与领取

- [ ] `quota.fetch` 仅对声明能力的适配器显示
- [ ] `quota.claimDaily` 仅对声明能力的适配器显示
- [ ] 未声明能力时不显示按钮，不后台调用
- [ ] 领取结果记录 `lastAt` / `result`，失败不伪装成功
- [ ] 定时任务可关闭，应用退出时清理
- [ ] 核心不内置任何公共凭据或第三方站点自动登录实现

### 默认 provider

- [ ] UI“设为默认”只写 `defaultProviderId`，不写凭据
- [ ] 默认 provider 禁用时回退为 404/503 明确错误，不静默路由
- [ ] `/v1/models` 仍广播所有启用 provider，不只默认
- [ ] 文档说明默认路由与鉴权关系

### 证据

- [ ] `docs/verification/P7-channels.md`
- [ ] `docs/CHANNELS.md`

## 8. 发布前总清单

- [ ] `npm run generate:registry`
- [ ] `npm test`
- [ ] `npm run test:contract`
- [ ] `npm run test:integration`
- [ ] `npm run test:watchdog`
- [ ] `npm run test:mutate`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run verify:dist`
- [ ] `npm run verify:manifest -- --check`
- [ ] `npm run build:win`
- [ ] `npm run smoke`
- [ ] Windows 便携版启动无白屏
- [ ] 安装版覆盖安装后旧配置可读
- [ ] macOS 构建按 `PACKAGING.md` 在真机验证（未验证需标注）
- [ ] `docs/verification/` 所有记录已更新
- [ ] `CHANGELOG.md` 记录行为变化与迁移说明

## 9. 手动验收矩阵

| 场景              | 操作                          | 预期                            |
| ----------------- | ----------------------------- | ------------------------------- |
| 无 Key 访问网关   | `curl /v1/models`             | 未设访问 Key 时成功；设了则 401 |
| 错误 Key          | `Authorization: Bearer wrong` | 401 `invalid_api_key`           |
| 模型未命中        | 请求不存在的模型              | 未设默认 404；设默认走默认      |
| 429 限流          | 假上游返回 `rate_limit`       | 短冷却，不锁额度                |
| 额度耗尽          | 假上游返回 `quota_exhausted`  | 锁定，切 Key/上游               |
| 流式截断          | 假上游输出 3 个 delta 后断开  | `stream_truncated`，不重试      |
| 错误 Content-Type | 假上游返回 `text/plain` SSE   | 仍能解析                        |
| 端口占用          | 占用 8787 后启动              | 可操作提示，不崩溃              |
| LAN 无 Key        | 局域网 IP 访问                | 拒绝                            |
| 升级篡改          | 修改 dist 文件后校验          | 校验失败，拒绝安装              |
| 适配器崩溃        | 外部适配器抛错                | 仅该渠道失败，网关继续          |

## 10. 证据记录格式

每份 `docs/verification/<id>.md` 至少包含：

```markdown
# <能力编号> 验证记录

- 日期：
- 环境：Windows 11 / Node 22 / Electron 45 / 提交 <sha>
- 命令：
- 结果：通过 / 失败 / 部分通过
- 证据：日志片段、截图路径、导出 JSON（脱敏）
- 已知边界：
- 未验证项：
```

禁止只写“已验证”而无命令与结果。
