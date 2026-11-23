# A4 验证记录：探测状态机接入测试流程

日期：2026-11-12 · 阶段：P2

## 目标

借鉴 dsh-our-free-model 的探测状态机：每次连接测试 / 单模型测试 / 批量测试
都产出明确的探测状态（available / rejected / rate_limited / quota_exhausted /
unknown / reachable）与证据（HTTP 状态、错误码、延迟），供 UI 与后续调度使用。

## 改动清单

### 新增模块

- `src/core/probe/state.js`：
  - `PROBE_STATES`：六态枚举；
  - `classifyProbeResult({ status, error, ms })`：按 HTTP 状态与错误归类；
  - `nextProbeState(current, result)`：状态转移（含冷却语义）；
  - `probeStateLabel(state)`：中文标签；
  - `probeInputFromConnection / probeInputFromTestResult`：把现有
    `testConnection / testSingleModel` 的返回归一成探测输入。
- `src/core/probe/runner.js`：`createProbeRunner`，并发探测 + `cooldownUntil` 冷却，
  避免对同一目标高频重试。

### 接入点

- `src/stores/testStore.js`：
  - `testConnection / testSingleModel / testSelectedModels / saveResult`
    的结果统一附加 `probeState` 与 `probeEvidence` 字段；
  - 现有返回结构不变（向后兼容），只做增量附加。

### 测试

- `src/core/probe/__tests__/state.test.js`：六态归类、状态转移、标签、输入归一。
- `src/core/probe/__tests__/runner.test.js`：并发探测、冷却窗口、结果聚合。
- `src/stores/__tests__/testStore.test.js`：新增 probeState / probeEvidence 断言。

## 验证证据

| 检查项          | 结果                         |
| --------------- | ---------------------------- |
| `npm test`      | 63 个文件 / 690 用例全部通过 |
| `npm run lint`  | 通过                         |
| `npm run build` | 通过（verify:dist 8 项全过） |

## 已知边界

- 探测状态目前只落在测试结果对象上，UI 尚未渲染状态徽标（属 P3 计划）。
- `cooldownUntil` 只在 runner 内部生效，testStore 直连调用不经过 runner。
