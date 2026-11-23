# A2 验证记录：relay TTFT / TPS 指标接入

日期：2026-11-12 · 阶段：P2（A2 + A4 面板展示）

## 目标

借鉴 dsh-our-free-model 的指标口径：TTFT（首 token 延迟）与 TPS（decode 速度）分离，
reasoning token 不计入可见输出速度；中转站每次上游尝试都记录这两个指标，
并在调用监控与按 Key 统计面板展示。

## 改动清单

### 指标计算（复用 P2 已建模块）

- `src/core/metrics/usage.js`：`computeUsageMetrics`（TTFT/TPS/reasoning/usageMissing）、
  `formatTtft`、`formatTps`。
- `electron/lib/metrics.cjs`：CJS 同步副本，主进程使用；契约测试比对两版口径一致。

### relay.cjs（主进程）

- 顶部引入 `./lib/metrics.cjs` 的 `computeUsageMetrics`。
- `normalizeUsage`：新增 `reasoningTokens` 字段（兼容
  `completion_tokens_details.reasoning_tokens` / `output_tokens_details.reasoning_tokens` /
  `reasoning_tokens` 三种命名）。
- `attempt()` 成功路径：
  - 流式响应在首个 data chunk 记录 `firstTokenAt`（非流式不记录，TTFT 为 null）；
  - 响应结束时用 `computeUsageMetrics` 计算 `ttftMs / tps / reasoningTokens / usageMissing`，
    写入尝试日志（`pushLog`）并传给 `recordStat`。
- `probeSingleKey()`：探测日志同样附带指标（非流式，TTFT 为 null，仅 usageMissing 有意义）。
- `recordStat()`：新增 `metrics` 参数；条目新增
  `ttftSamples / ttftTotalMs / avgTtftMs / lastTtftMs / lastTps / lastReasoningTokens / lastUsageMissing`。
- `recordKeyUsage()`：行与小时桶新增同样的 TTFT/TPS 字段；
  `keyWindowStats` 聚合时按样本数重算窗口均值。
- `attachStorage()`：恢复按 Key 统计时补齐新字段（旧文件缺字段按 0 / null 兜底）。
- `persistNow()`：`relay-usage.json` 写入 `version: 2`（旧文件无 version 字段，
  读取端按字段缺失兜底，无需显式迁移逻辑）。

### 面板

- `RelayStatsPanel.vue`（调用监控）：新增「TTFT / 速度」列，展示最终尝试的
  `ttftMs / tps`；悬停提示含 reasoning 剔除说明与 usageMissing 标记。
- `RelayUsagePanel.vue`（按 Key 统计）：新增「TTFT / 速度」列，展示当前窗口的
  平均 TTFT 与最近 TPS；窗口统计结构（`emptyWindowStat / normalizeWindowStat /
addLogToWindow / keyRows`）同步扩展字段。

## 口径说明

- TTFT 只对流式请求计算：`firstTokenAt - startedAt`；非流式响应首块即完整响应，不产生 TTFT。
- TPS = 可见输出 tokens /（结束时间 - 首 token 时间）；可见输出 = completion - reasoning。
- 缓存命中不参与 TTFT/TPS 统计（没有真实上游响应）。
- 上游未返回 usage 时 `usageMissing = true`，面板悬停可见。

## 验证证据

| 检查项                                      | 结果                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `node -e "require('./electron/relay.cjs')"` | 语法通过                                                              |
| `npm test`                                  | 63 个文件 / 690 用例全部通过（含 metrics 契约测试、probe 端到端测试） |
| `npm run lint`                              | 通过                                                                  |
| `npm run build` + verify:dist               | 8 项全部通过（1.7.0）                                                 |
| Prettier                                    | relay.cjs / 两个面板格式化后无 diff                                   |

## 已知边界

- 旧版 `relay-usage.json`（无 version 字段）恢复时 TTFT/TPS 字段为 0/null，
  随新请求逐步累计，无需一次性迁移。
- 非流式请求只有 `usageMissing` 标记，没有 TTFT/TPS（口径如此，不是缺陷）。
- 探测请求（probe）为非流式，同样只记录 usageMissing。
