# A5 验证记录：本地网关协议扩展

日期：2026-11-12 · 阶段：P4（A5 + A10）

## 目标

在既有 OpenAI 兼容网关上扩展：

- Anthropic `/v1/messages` 协议适配（请求/响应/SSE 双向转换），复用同一套路由与故障转移；
- `/v1/responses` 作为可选能力，未启用时返回明确 501；
- 默认上游路由 `defaultProviderId`：模型未命中时回退，禁用/无 Key 时明确 503，不静默切到未授权上游。

## 改动清单

### 新增模块（纯函数 + 单测）

- `electron/gateway/adapters/anthropic.cjs`：
  - `anthropicToOpenAI(body)`：system（字符串/文本块数组）→ system 消息；user/assistant 消息；
    `normalizeContent` 把文本块拼成字符串、图片块转 OpenAI `image_url`（data: URL）；
    `max_tokens`/`temperature`/`top_p`/`stop_sequences→stop` 映射；保留 `stream`。
  - `openAIToAnthropic(json, model)`：→ `{ id, type:'message', role:'assistant', model, content:[{type:'text',text}], stop_reason, stop_sequence:null, usage:{input_tokens,output_tokens} }`。
  - `mapStopReason`：stop/content_filter/default→end_turn，length→max_tokens，tool_calls→tool_use。
  - `createAnthropicSseTransform(model)`：有状态转换器，把上游 OpenAI SSE 逐块转为
    Anthropic 事件序列（message_start → content_block_start → ping → content_block_delta…
    → content_block_stop → message_delta → message_stop）；跨 chunk 缓冲、`\r\n` 归一。
  - `aggregateOpenAIStream(text)`：非流式兜底，把 SSE 文本折叠成单个伪 OpenAI JSON。

### relay.cjs 接入

- `resolveRoute(model, payload)`：常规模型解析（精确→通配→单上游）+ 默认路由兜底，
  返回 `{ candidates, routedBy }` 或 `{ error, status, type }`，chat 与 messages 共用。
- `resolveDefaultCandidates`：默认上游被禁用/无 Base URL/无可用 Key → 503
  `default_provider_unavailable`；命中则 `routedBy:'default'`。
- `attempt()` 新增隔离分支 `context.adapter && status < 400`：流式走 SSE 转换器，
  非流式 `JSON.parse→openAIToAnthropic`（失败兜底 `aggregateOpenAIStream`）；
  **既有 OpenAI 透传路径逐字节未改**，错误（≥400）仍走原透传。
- `handleAnthropicMessages`：读体→`resolveRoute`→候选 `forwardBody` 转 OpenAI→
  `forwardWithFailover(..., { adapter:{kind:'anthropic',model,streaming}, path:'/v1/messages' })`。
- 路由：`POST /v1/messages|/messages`→适配；`POST /v1/responses|/responses`→501 `not_implemented`。
- 成功/失败日志新增 `routedBy` 字段。

### 配置 / store / UI

- `defaultProviderId` 贯穿 `storage.js`（默认空＋迁移）、`relayStore.js`（load/persist/start/update）、
  `relay.cjs`（start/update/getStatus）。
- `RelayPanel.vue`「默认上游」下拉：只写 `defaultProviderId`，不碰凭据；禁用项标注「已禁用」。

## 验证证据

环境：Windows 11 / Node v22.22.2 / Electron 45.0.0 / 基线提交 a5441a6（P4 改动尚未提交）。

| 检查项                                              | 结果                          |
| --------------------------------------------------- | ----------------------------- |
| `npx vitest run src/__tests__/anthropicAdapter.test.js` | 13 用例全过（纯函数转换）   |
| `npx vitest run src/__tests__/relayAnthropic.test.js`   | 5 用例全过（假上游端到端）  |
| `npx vitest run src/__tests__/relayDefaultRoute.test.js`| 7 用例全过（默认路由/503）  |
| `npx vitest run src/stores/__tests__/relayStore.test.js`| 39 用例全过（含 9 项新增）  |
| `npx vitest run src/components/__tests__/RelayPanel.test.js` | 39 用例全过（含 5 项新增） |
| `npm run lint`                                      | 通过                          |
| `npm run format:check`                              | 通过                          |
| `npm test`                                          | 72 文件 / 816 用例全过        |

`relayAnthropic.test.js` 覆盖：非流式转换并断言上游收到 OpenAI 请求体、日志 `path:'/v1/messages'`；
流式 SSE 事件序列与 delta 拼接（`你好，世界`）；模型未命中 404；`/v1/responses` 501；`/v1/models` 广播。

`relayDefaultRoute.test.js` 覆盖：未设默认 404；设默认 200 + `x-relay-provider` + `routedBy:'default'`；
命中具体模型不走默认；默认禁用 503；默认无 Key 503；`/v1/models` 仍广播全部；getStatus/update 携带 defaultProviderId。

## 已知边界

- **工具调用未支持**：`tool_use`/`tool_result` 块本增量不做完整还原；上游返回工具调用时文本部分仍转发，
  但工具结构不还原。需要完整工具链请直接用 OpenAI 兼容端点。
- **默认路由是兜底**：仅在常规模型解析（含「单上游透明代理」「无模型列表上游兜底」）返回空时才启用；
  命中具体模型/别名时默认上游不参与。
- 上游错误（≥400）按原状态透传，不做 Anthropic 包装。

## 未验证项

- Claude Code / OpenAI SDK 的**真实**端到端对话未跑（假上游集成测试已覆盖协议转换与路由）；
  真实 SDK 联调留待手动验收。
- 图片块转换有单测，但未对真实多模态上游做端到端验证。