# A3 验证记录：流式容错（嗅探 / 归一 / 心跳）

日期：2026-11-12 · 阶段：P3（A3 + A6）

## 目标

借鉴 dsh-our-free-model 的流式容错：错误 Content-Type 仍可解析、
跨块中文不乱码、心跳可区分「慢」和「断」、三协议事件归一。

## 改动清单

### 新增模块

- `src/core/stream/sniff.js`：
  - `STREAM_FORMATS`：sse / ndjson / json / unknown；
  - `sniffByContentType`：Content-Type 初始猜测；
  - `sniffByFirstChunk`：按首块内容识别真实格式（SSE 事件字段行、
    心跳注释行 `: ping`、NDJSON 首行 JSON、JSON 数组/对象）；
  - `sniffStreamFormat`：首块优先，Content-Type 兜底。
- `src/core/stream/normalize.js`：
  - `normalizeStreamEvent(json, protocol)`：OpenAI / Anthropic / Gemini /
    Ollama / Responses 五协议事件归一为 `StreamEvent { type, text, usage, raw }`；
  - usage 提取与 `metrics/usage.js` 同口径（含 reasoningTokens）；
  - `isStreamDone`：识别 `[DONE]` / `DONE` 结束标记。

### 主进程接入（electron/main.cjs）

- `handleHttpStream`：
  - 流式期间每 15 秒发 `heartbeat` 事件（`type: 'heartbeat'`），
    前端可据此区分「慢」和「断」；流结束/异常时清理定时器；
  - 首块嗅探真实流格式，随 meta 返回 `streamFormat` 字段；
  - `sniffStreamFormatMain` 与 `src/core/stream/sniff.js` 同规则（CJS 内联版）。

### 既有基础（未改动，已满足验收项）

- `src/api/sse.js`：`createSseParser` 自带缓冲，`\r\n` 统一、跨块截断的
  `\r` 在下次拼接后还原（跨块中文/emoji 不乱码）；心跳注释行 `:` 开头被跳过，
  不产生空 delta。
- `src/api/http.js`：`TextDecoder(stream: true)` 逐块解码，多字节字符跨块安全。

## 验证证据

| 检查项                           | 结果                             |
| -------------------------------- | -------------------------------- |
| `npx vitest run src/core/stream` | 21 用例全过（嗅探 10 + 归一 11） |
| `npm test`                       | 67 文件 / 755 用例全过           |
| `npm run lint`                   | 通过                             |
| `npm run build`                  | verify:dist 18 项全过            |

## 已知边界

- `streamFormat` 目前只随 meta 返回，渲染层各协议适配器仍按自身协议解析；
  后续接入 `normalize.js` 后可按嗅探结果动态选择解析器（P4+）。
- 心跳事件渲染层尚未消费（无 UI 展示「慢」），事件通道已就绪。
- 假上游端到端截断测试（`stream_truncated` 分类）依赖 A6 的 retry policy，
  见 `A6-failure-policy.md`。
