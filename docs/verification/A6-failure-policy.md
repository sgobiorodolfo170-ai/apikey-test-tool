# A6 验证记录：失败分类与重试策略

日期：2026-11-12 · 阶段：P3（A3 + A6）

## 目标

借鉴 dsh-our-free-model 的失败分类：request / account / provider / transient
四类，决定「不切 / 切 Key / 切上游 / 退避重试」；429 不自动重试；
已输出内容后不重试（避免重复计费）。

## 改动清单

### 新增模块（双实现 + 契约测试）

- `src/core/failures/classify.js`（ESM，渲染层/测试用）：
  - `FAILURE_CLASSES`：request / account / provider / transient；
  - `classifyFailure(input)`：输入 `{ status, code, message, body, headers, timeout, aborted }`，
    输出 `{ class, retryable, switchKey, switchProvider, cooldownMs, evidence }`；
  - `isQuotaSignal`：429 响应体识别额度耗尽（quota_exhausted / insufficient_quota /
    billing / exceeded your current quota）；
  - `parseRetryAfterMs`：秒数或 HTTP 日期 → 毫秒。
- `electron/lib/failures.cjs`（CJS，主进程用）：同规则副本。
- `src/core/retry/policy.js`：
  - `RETRY_ACTIONS`：retry_same / switch_key / switch_provider / abort；
  - `decideRetryAction`：由 failure + attempt + hasOutput 决定下一步；
    - `hasOutput=true` → abort（stream_truncated，绝不重试）；
    - request → abort（原样透传）；
    - 429 transient → retry_same + Retry-After 冷却（不自动立即重试）；
    - account → switch_key（额度耗尽时也可 switch_provider）；
    - provider → switch_provider；
    - 408/425 → 指数退避；
    - 超过 maxAttempts → abort。
  - `shouldRetry`：便捷封装。

### relay.cjs 接入

- `forwardWithFailover` catch 分支：先 `classifyFailure` 归类，
  日志新增 `failureClass` 字段；
- request 类错误（400/404/422 等参数问题）：不切 Key、不切上游，
  记日志后直接透传（未写响应头时返回 502 保持旧行为）；
- 其余类别沿用既有冷却/切 Key/切上游逻辑，行为不变但归类可观测。

## 分类语义表

| 输入           | class                | retryable        | switchKey | switchProvider |
| -------------- | -------------------- | ---------------- | --------- | -------------- |
| 400/404/422    | request              | 否               | 否        | 否             |
| 401/403        | account              | 否               | 是        | 否             |
| 429 + 额度信号 | account              | 否               | 是        | 是             |
| 429 瞬时限流   | transient            | 否（冷却后重试） | 是        | 否             |
| 408/425        | transient            | 是               | 否        | 否             |
| 5xx            | provider             | 是               | 否        | 是             |
| 网络错误/超时  | provider             | 是               | 否        | 是             |
| 取消           | request（cancelled） | 否               | 否        | 否             |

## 验证证据

| 检查项                             | 结果                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `npx vitest run src/core/failures` | 31 用例全过（含 22 组 ESM/CJS 契约比对）              |
| `npx vitest run src/core/retry`    | 13 用例全过                                           |
| `npm test`                         | 67 文件 / 755 用例全过（含既有 relayFailover 端到端） |
| `npm run lint`                     | 通过                                                  |
| `npm run build`                    | verify:dist 18 项全过                                 |

## 已知边界

- evalApi 的重试（`ask()` 的 transient 判定）暂未切换到 policy 驱动，
  现有逻辑与 policy 语义一致（429/5xx/网络可重试、401 不可重试），
  切换留待后续以降低回归风险。
- `stream_truncated` 的端到端验证需要假上游（P6 A8 计划项），
  当前由单测覆盖 policy 决策逻辑。
- relay 的 request 类透传在「未写响应头」时返回 502 而非上游原始状态码，
  与旧行为一致；后续 P4 网关拆分时改为真实透传。
