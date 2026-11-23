# 借鉴点落地计划（A1–A10 + B1/B2 + 渠道框架）

- 版本：2026-11-12
- 状态：P1、P2、P3、P4 已实施，P5 起待实施
- 关联验收清单：[2026-11-12-borrowing-acceptance.md](./2026-11-12-borrowing-acceptance.md)
- 关联文档：[README](../../README.md)、[RELAY](../RELAY.md)、[DEVELOPMENT](../DEVELOPMENT.md)、[PACKAGING](../PACKAGING.md)

## 1. 背景与范围

本计划把参考项目的 10 项工程能力（A1–A10）、2 项架构理念（B1/B2）落到本仓库，并补上本地网关与渠道适配器框架。

已确认前提：

1. “中转站”指**工具自身做本地网关**：Electron 主进程监听回环地址，暴露 OpenAI 兼容端点；不接外部中转服务。
2. 默认提供商可以直接进入本地网关：`/v1/models` 广播所有启用 provider，`defaultProviderId` 只决定默认路由，不内置凭据。
3. 免费上游与账号渠道做成**可插拔适配器**：核心提供契约、账号池、额度状态、调度与 UI；具体适配器由使用方提供或确认授权后加载。
4. 核心不内置公共凭据，不实现指纹伪造、官方提示词注入、第三方站点自动登录。渠道适配器可声明 `auth` 与 `quota.claimDaily` 能力，具体实现与条款确认由适配器作者负责。

本计划不改变现有用户数据格式的兼容性：所有新增字段均可选，旧配置读取后自动迁移。

## 2. 现状盘点

| 能力          | 现有基础                                                         | 主要缺口                                                         |
| ------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| A1 注册表     | `src/data/relayPresets.js`、`src/api/modes.js`、`providers.json` | 测试端与中转端两套注册；新增供应商仍要改代码                     |
| A2 状态机     | `electron/relay.cjs` 的 429 确认、锁定、半开恢复                 | 测试端无统一状态；5xx/超时口径未统一                             |
| A3 SSE        | `src/api/sse.js`、主进程 `http-stream`、relay 透传               | 无 Content-Type 嗅探、心跳、截断分类                             |
| A4 指标       | relay 日志/统计/token 图、`src/api/evalApi.js` 延迟              | 无 TTFT/TPS、reasoning 分项、请求/回合口径                       |
| A5 网关       | `electron/relay.cjs` 已监听 `127.0.0.1`，支持多客户端 Key        | 仅 OpenAI chat/embeddings；无 `/v1/messages`；无默认路由；无 LAN |
| A6 失败分类   | relay 429/5xx/网络分支、eval 3 次重试                            | 无统一四类分类与重试策略                                         |
| A7 升级完整性 | `src/utils/update.js` 只查 Release                               | 无 manifest、hash、staging、回滚                                 |
| A8 测试分层   | 大量 Vitest + `scripts/smoke.cjs`                                | 无假上游、变异测试、看门狗                                       |
| A9 发布清单   | `scripts/verify-package.cjs`                                     | 无发布 manifest `--check`、无逐文件 hash                         |
| A10 网络细节  | 端口 1024–65535、仅回环                                          | 端口错误无分类提示；无 LAN 地址排序、代理链处理                  |
| B1 降级       | 部分 fallback                                                    | 无能力矩阵，缺失能力仍可能阻断启动                               |
| B2 文档       | README/RELAY/DEVELOPMENT/PACKAGING                               | 无验证记录体系、无 PR 证据模板                                   |

## 3. 目标架构

```text
src/core/                     # 纯 ESM，可单测，不依赖 Electron
  providers/registry.js      # 统一 ProviderDescriptor
  probe/state.js             # 探测状态机纯函数
  probe/runner.js            # 探测编排
  stream/sniff.js            # Content-Type 嗅探
  stream/normalize.js        # OpenAI/Anthropic/Gemini 事件归一
  metrics/usage.js           # TTFT/TPS/reasoning/token 口径
  failures/classify.js       # request/account/provider/transient
  retry/policy.js            # 重试与切换策略
  channels/contract.js       # ChannelAdapter 契约
  capabilities.js            # 可选能力矩阵
src/data/providers.json      # 唯一供应商注册表
electron/gateway/            # relay.cjs 的渐进拆分
  router.cjs  auth.cjs  forward.cjs  metrics.cjs
  adapters/anthropic.cjs  adapters/responses.cjs
electron/channels/           # 渠道适配器宿主（子进程隔离）
  loader.cjs  host.cjs
electron/lib/                # 现有 lib 扩展
  failures.cjs  net.cjs  manifest.cjs
electron/updater.cjs         # 下载、校验、staging、回滚
scripts/
  fake-upstream.cjs          # 离线假上游
  verify-manifest.cjs        # 发布清单校验
  test-watchdog.cjs          # 测试看门狗
  mutate.cjs                 # 轻量变异测试
docs/verification/           # 每个能力一份证据
  TEMPLATE.md  A1-...md ... B2-...md
```

### 3.1 核心契约

```js
// ProviderDescriptor
{
  id, name, apiMode, baseUrl, models,
  auth: { type: 'bearer' | 'header' | 'oauth' | 'none', keyOptional },
  capabilities: ['chat', 'stream', 'embeddings', 'messages', 'responses', 'quota', 'dailyClaim'],
  preset: { quota, autoProbe, maxConcurrency, rpmLimit }
}

// ProbeState: unknown | reachable | rejected | rate_limited | quota_exhausted
// ProbeResult: { providerId, model, state, statusCode, errorClass, latencyMs, checkedAt, evidence }

// RequestFailure: { class: 'request' | 'account' | 'provider' | 'transient',
//                   retryable, switchKey, switchProvider, cooldownMs, evidence }

// Account
{ id, providerId, label, credentialRef, group, status,
  cooldownUntil, quota: { level, resetAt }, dailyClaim: { lastAt, result } }

// ChannelAdapter（外部适配器实现，核心只调用契约）
{
  meta: { id, name, authType, capabilities },
  auth: { begin?, complete?, refresh? },        // 官方 OAuth / 设备码
  credentials: { list, import, validate },
  quota: { fetch?, claimDaily? },               // 可选，仅官方公开接口
  models: { list },
  chat: { send, stream }
}
```

### 3.2 状态与失败判定

| 输入                                           | ProbeState              | 是否可重试                | 是否切 Key/上游         |
| ---------------------------------------------- | ----------------------- | ------------------------- | ----------------------- |
| 2xx                                            | reachable               | —                         | —                       |
| 401/403                                        | rejected                | 否                        | 切 Key                  |
| 429 + `rate_limit`                             | rate_limited            | 否（按 Retry-After 冷却） | 切 Key                  |
| 429 + `quota_exhausted` / `insufficient_quota` | quota_exhausted         | 否                        | 切 Key/上游             |
| 5xx                                            | unknown（保留上次可达） | 是                        | 切上游                  |
| 超时/网络错误                                  | unknown                 | 是                        | 切上游                  |
| 流已输出后断开                                 | 不重试                  | 否                        | 记录 `stream_truncated` |
| 4xx 请求错误（400/404/422）                    | rejected（request）     | 否                        | 原样透传                |

## 4. A1–A10、B1/B2 落地映射

| 项            | 落点                                                           | 完成标准                                                      |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| A1 注册表     | `src/data/providers.json` + `src/core/providers/registry.js`   | 只改 JSON 即可新增供应商，配置页/中转预设/`/v1/models` 全出现 |
| A2 状态机     | `src/core/probe/state.js`、`src/core/probe/runner.js`          | 5xx/超时不误判“Key 无效”；状态持久化；拒因可导出              |
| A3 SSE        | `src/core/stream/sniff.js`、`normalize.js`、主进程心跳         | 错误 Content-Type 仍可解析；跨块中文正确；截断可分类          |
| A4 指标       | `src/core/metrics/usage.js`、`electron/gateway/metrics.cjs`    | TTFT 与 decode 分离；reasoning 单列；usage 缺失标注           |
| A5 网关       | `electron/gateway/router.cjs`、`auth.cjs`、`forward.cjs`       | OpenAI + Anthropic；默认路由；回环/LAN；Key 鉴权              |
| A6 失败分类   | `src/core/failures/classify.js`、`electron/lib/failures.cjs`   | 四类分类；429 不自动重试；已输出不重试                        |
| A7 升级完整性 | `electron/lib/manifest.cjs`、`electron/updater.cjs`            | manifest 校验、staging、原子替换、失败回滚                    |
| A8 测试分层   | `scripts/fake-upstream.cjs`、`test-watchdog.cjs`、`mutate.cjs` | 离线套件全绿；变异至少 3 处变红；无超时                       |
| A9 发布清单   | `scripts/verify-manifest.cjs`、`scripts/verify-package.cjs`    | 清单与 dist 逐文件 size/hash 一致；CI 独立 job                |
| A10 网络细节  | `electron/lib/net.cjs`                                         | EACCES/EADDRINUSE 分类；LAN 地址排序；代理链遵守 NO_PROXY     |
| B1 降级       | `src/core/capabilities.js`                                     | 缺失网关/更新/LAN/通知时正常启动并显示“未启用”                |
| B2 证据文档   | `docs/verification/*.md`、PR 模板                              | 每个能力一份命令/环境/结果/边界记录                           |

## 5. 文件级改动

### P1 A1 + B1：统一注册表与能力降级（4 天）

**新增**

- `src/data/providers.json`：现有 7 个预设 + 10 种 apiMode 元数据。
- `src/core/providers/registry.js`：`getProvider`、`listProviders`、`buildAdapters`、`validateDescriptor`。
- `src/core/capabilities.js`：`gateway`、`lan`、`updater`、`tray`、`notifications`、`channels` 的 `probe()` 与 `fallback`。
- `scripts/generate-providers-cjs.cjs`：由 JSON 生成 `electron/generated/providers.cjs`。

**修改**

- `src/api/modes.js`：`API_MODES` / `ADAPTERS` 改为 registry 构建，保留原导出签名。
- `src/data/relayPresets.js`：`RELAY_PRESETS` 从 registry 派生，保留 `findPreset` / `createProviderFromPreset`。
- 组件无需改动：`ConfigPanel.vue` 的 `API_MODES` 与 `RelayPanel.vue` 的 `RELAY_PRESETS` 已由 registry 数据源驱动。
- `electron/relay.cjs`：当前不读取预设，无需改动；生成的 CJS 快照供后续主进程模块使用。
- `.prettierignore` 与 `eslint.config.js`：忽略自动生成的 `electron/generated/`。
- `package.json`：新增 `generate:registry`，在 `dev` / `build` / `test` 前执行。

**验收**

- 只改 `providers.json` 新增一个 OpenAI-like 供应商，配置页、中转预设、`/v1/models` 全部出现。
- 关闭 `capabilities.lan` / `updater` 后应用正常启动，UI 显示“未启用”。

### P2 A2 + A4：探测状态机与指标口径（5 天）

**新增**

- `src/core/probe/state.js`：纯状态迁移。
- `src/core/probe/runner.js`：并发、去重、冷却、证据记录。
- `src/core/metrics/usage.js`：`compute({ startedAt, firstTokenAt, endedAt, usage, reasoningTokens })`。
- `src/components/RelayMetricsPanel.vue`。

**修改**

- `src/stores/testStore.js`：测试结果写统一 `ProbeResult`，保留旧字段。
- `src/api/evalApi.js`：测速记录首 token 时间，调用 `metrics/usage`。
- `electron/relay.cjs`：`recordStat`、`recordKeyUsage` 增加 TTFT/TPS/reasoning；`relay-usage.json` 升 v2 并迁移。
- `src/utils/tokenChart.js`、`src/components/RelayStatsPanel.vue`、`src/components/RelayUsagePanel.vue`：展示新指标。

**验收**

- 假上游分块返回 reasoning 与正文，TTFT 与 decode 速度分离。
- 连续 5 次 500 后仍为 `unknown`，不显示“Key 无效”。
- 历史 `relay-usage.json` 无损迁移。

### P3 A3 + A6：流式容错与失败分类（5 天）

**新增**

- `src/core/stream/sniff.js`：按首块识别 SSE / NDJSON / JSON。
- `src/core/stream/normalize.js`：三协议事件归一为 `StreamEvent`。
- `src/core/failures/classify.js` 与 `electron/lib/failures.cjs`：同规则双实现，契约测试比对。
- `src/core/retry/policy.js`：429 不重试、已输出不重试、按失败类切换。

**修改**

- `src/api/http.js`、`electron/main.cjs` 的 `http-stream`：接入 sniff 与 `stream-heartbeat`。
- `electron/relay.cjs` 的 `forwardWithFailover`：改用 failures/retry，保留响应头。
- `src/api/evalApi.js`：重试改 policy 驱动，失败题轮转逻辑不变。

**验收**

- `Content-Type: text/plain` 的 SSE 仍可解析；跨 chunk 中文不乱码。
- 输出 3 个 delta 后断开：标记 `stream_truncated`，不重试、不重复计费。
- 429 不自动重试；401 切 Key；5xx 切上游。

### P4 A5 + A10：网关协议扩展与网络细节（6 天）

**新增**

- `electron/gateway/router.cjs`：路由表、默认 provider、路径白名单。
- `electron/gateway/auth.cjs`：回环判定、访问 Key、多客户端 Key、LAN Key。
- `electron/gateway/forward.cjs`：从 `relay.cjs` 抽出的转发与故障转移。
- `electron/gateway/adapters/anthropic.cjs`：`/v1/messages` 与上游 messages/chat 转换，含 SSE。
- `electron/gateway/adapters/responses.cjs`：`/v1/responses`（可选能力）。
- `electron/gateway/metrics.cjs`：TTFT/usage 采集。
- `electron/lib/net.cjs`：`classifyListenError`、`listLanAddresses`、`resolveProxyBypass`。
- `src/components/RelayGatewayPanel.vue`。

**修改**

- `electron/relay.cjs`：`handle` 委托 gateway router；`start` 使用 net 分类错误；`getStatus` 返回 `lan`、`defaultProviderId`。
- `electron/main.cjs`、`electron/preload.cjs`：新增 `relay-default-provider`、`relay-lan-*`、`relay-metrics` IPC。
- `src/stores/relayStore.js`：`defaultProviderId`、`lan`、`listenHost`；`baseUrl` 按 host 生成。
- `src/components/RelayPanel.vue`：新增“网关 / 账号 / 指标”Tab。
- `docs/RELAY.md`：补 `/v1/messages`、默认路由、LAN 安全说明。

**验收**

- Claude Code 指向 `http://127.0.0.1:8787` 可完成一轮对话；`/v1/models` 同时列出两类模型。
- 未设默认 provider 且模型未命中仍 404；设默认后走默认并带 `x-relay-provider`。
- LAN 默认关闭；开启必须设 Key；非回环无 Key 直接拒绝。
- 端口占用提示“端口 8787 已被占用，可改用 8788”；EACCES 提示权限不足。

### P5 A7 + A9：升级完整性与发布清单（3 天）

**新增**

- `electron/lib/manifest.cjs`：生成/校验 `{ version, files:[{path,size,sha256}], signature }`。
- `electron/updater.cjs`：下载到 staging、逐文件校验、原子替换、失败回滚。
- `scripts/verify-manifest.cjs`：`--write` / `--check`。

**修改**

- `src/utils/update.js`：Release 资产增加 manifest URL；校验失败拒绝安装。
- `src/stores/updateStore.js`：展示校验状态与回滚结果。
- `package.json`：`verify:manifest`；`build:*` 末尾追加 manifest 生成与校验。
- `scripts/verify-package.cjs`：复用 manifest 的 hash 结果。

**验收**

- 篡改 `dist/assets/*.js` 一个字节，`--check` 失败并拒绝升级。
- 模拟替换中断，staging 保留、原目录不变；下次启动回滚成功。

### P6 A8 + B2：测试分层与证据文档（4 天）

**新增**

- `scripts/fake-upstream.cjs`：编排 200/401/429/5xx/SSE 分块/截断/慢首包。
- `scripts/test-watchdog.cjs`：每个套件 60s 超时。
- `scripts/mutate.cjs`：对 3 个关键断言做变异。
- `docs/verification/TEMPLATE.md` 与 A1–A10、B1、B2 记录。
- `.github/pull_request_template.md`：增加“验证证据”必填。

**修改**

- `vitest.config.js`：`unit` / `contract` / `integration` 三个项目。
- `package.json`：`test:contract`、`test:integration`、`test:watchdog`、`test:mutate`。
- `docs/DEVELOPMENT.md`：测试分层与环境变量。

**验收**

- 离线 `npm test` 全绿；`npm run test:watchdog` 无超时。
- 变异脚本至少 3 个关键测试变红，恢复后全绿。
- 每份 verification 文档含命令、环境、结果、已知边界。

### P7 渠道适配器与账号池（5 天）

**新增**

- `src/core/channels/contract.js`：ChannelAdapter 契约与校验。
- `electron/channels/loader.cjs`：从 `userData/channels/` 加载外部适配器，校验 manifest 与权限声明。
- `electron/channels/host.cjs`：子进程隔离、超时、日志脱敏、结果归一。
- `src/components/RelayAccountsPanel.vue`：账号卡、分组、额度、冷却、上次领取。
- `docs/CHANNELS.md`：适配器开发指南与能力声明。

**修改**

- `src/stores/relayStore.js`：`provider.apiKeys: string[]` 迁移为 `provider.accounts: Account[]`，保留 `apiKeys` 兼容读写。
- `electron/relay.cjs`：调度、429 锁定、冷却改为 account id 维度；保留 `apiKeysOf` 兼容层。
- `electron/main.cjs`、`electron/preload.cjs`：`channel-list`、`channel-enable`、`channel-quota`、`channel-claim-daily`。
- `src/data/providers.json`：现有预设补 `capabilities`，不含 `dailyClaim`。

**默认 provider 进入网关**

- `relay.json` 增加 `defaultProviderId`、`routes`。
- `/v1/models` 广播所有启用 provider；模型未命中时，设默认则走默认，否则维持 404。
- UI“设为默认”只写配置，不写入任何凭据。

**验收**

- 外部适配器放入 `userData/channels/demo/` 后出现在列表，禁用后不影响启动。
- 适配器崩溃/超时只标记该渠道失败，网关继续服务其他 provider。
- 账号池可分组、查看额度、冷却与上次领取；日志不出现明文 Key。
- `claimDaily` 仅对声明该能力的适配器显示。

## 6. 数据模型与迁移

### 6.1 `relay.json`

```jsonc
{
  "port": 8787,
  "listenHost": "127.0.0.1", // 新增；默认回环
  "lan": { "enabled": false, "apiKey": "" }, // 新增；开启必须设置
  "defaultProviderId": "", // 新增；空表示不启用默认路由
  "providers": [
    {
      "id": "p_xxx",
      "name": "商汤日日新",
      "presetId": "sensenova",
      "enabled": true,
      "apiKeys": ["sk-..."], // 兼容保留
      "accounts": [
        // 新增；首次读取由 apiKeys 迁移
        {
          "id": "a_xxx",
          "label": "Key 1",
          "credentialRef": "relay:provider:p_xxx:a_xxx",
          "group": "",
          "status": "unknown",
          "cooldownUntil": 0,
          "quota": { "level": "none", "resetAt": 0 },
          "dailyClaim": { "lastAt": 0, "result": "" },
        },
      ],
    },
  ],
}
```

迁移规则：

- 无 `accounts` 且有 `apiKeys`：为每把 Key 生成 `account`，`credentialRef` 指向加密存储；`apiKeys` 保留只读兼容。
- 无 `listenHost`：默认 `127.0.0.1`。
- 无 `lan`：默认关闭。
- 无 `defaultProviderId`：空，不改变现有 404 行为。

### 6.2 `relay-usage.json` v2

新增字段均可选：

- `stats[].ttftMs`、`stats[].streamMs`、`stats[].tps`、`stats[].reasoningTokens`、`stats[].usageMissing`
- `logs[].ttftMs`、`logs[].tps`
- `accounts[]` 额度与领取状态

迁移：读取时若 `version < 2`，补齐默认值并写回；旧字段保留。

## 7. 分阶段与工期

| 阶段 | 内容        | 工期 | 出口标准                        |
| ---- | ----------- | ---- | ------------------------------- |
| P1   | A1 + B1     | 4d   | 注册表驱动、能力降级            |
| P2   | A2 + A4     | 5d   | 状态不误判、指标可信            |
| P3   | A3 + A6     | 5d   | 流式稳定、重试不重复计费        |
| P4   | A5 + A10    | 6d   | 双协议网关、默认路由、LAN       |
| P5   | A7 + A9     | 3d   | 升级可校验可回滚、manifest 一致 |
| P6   | A8 + B2     | 4d   | 离线测试、变异、证据文档        |
| P7   | 渠道/账号池 | 5d   | 外部适配器可插拔                |

MVP：P1–P4（约 20 天）。P5–P7 跟进。

## 8. 测试与验收命令

```bash
npm run generate:registry
npm test
npm run test:contract
npm run test:integration
npm run test:watchdog
npm run test:mutate
npm run lint
npm run format:check
npm run verify:dist
npm run verify:manifest -- --check
npm run smoke
```

手动：

```bash
curl http://127.0.0.1:8787/v1/models
curl -X POST http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d '...'
curl -X POST http://127.0.0.1:8787/v1/messages -H "Content-Type: application/json" -d '...'
```

完整勾选项见[验收清单](./2026-11-12-borrowing-acceptance.md)。

## 9. 风险与边界

| 风险                     | 处理                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `relay.cjs` 拆分回归     | 先加行为快照测试，再迁移；`relay.cjs` 保留兼容入口                             |
| 指标 schema 变更         | v2 + 启动迁移，旧字段保留只读                                                  |
| LAN 暴露                 | 默认关闭；开启强制访问 Key；UI 明确提示局域网可访问                            |
| 外部适配器执行第三方代码 | 子进程隔离、超时、权限声明、日志脱敏；默认不加载未签名适配器                   |
| 上游条款与凭据           | 适配器作者自行确认；核心不内置公共凭据，不提供指纹伪造/提示词注入/自动登录实现 |
| 默认路由误用             | 未配置默认 provider 时行为不变；日志标注 `routedBy: default`                   |

## 10. 变更控制

- 不在本计划内做：服务器部署、公网中转、多用户/RBAC、云端同步。
- 不在本计划内改：评分口径 `SCORE_VERSION`、指纹库权重、现有 10 种协议适配器的公开签名。
- 任何新增可选能力必须能在缺失时降级，不得阻断应用启动。
- 每个阶段完成时更新 `docs/verification/` 对应记录，并在验收清单勾选。
