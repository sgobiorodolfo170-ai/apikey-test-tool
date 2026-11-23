# B1 可选能力降级验证记录

- 日期：2026-11-12
- 环境：Windows 11 / Node 22 / Electron 45 / 提交工作区（P1 实施中）
- 结果：通过（自动化），真实 Electron 手工验收待补
- 关联计划：[../plans/2026-11-12-borrowing-plan.md](../plans/2026-11-12-borrowing-plan.md)

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/core/__tests__/capabilities.test.js` | 4 个用例通过 |
| `npm test` | 60 个文件、674 个用例通过 |
| `npm run lint` | 通过，无 error |
| `npx vite build` | 130 个模块，构建成功 |

## 覆盖内容

- `src/core/capabilities.js` 定义 6 项能力：`gateway`、`lan`、`updater`、`tray`、`notifications`、`channels`。
- 无桌面桥接时：`gateway` 为 `unavailable`，`lan`/`channels`/`tray` 为 `degraded`，并显示降级文案。
- 有 `relay.start` 与 `channel.list` 桥接时：`gateway`、`channels` 为 `available`。
- `logCapabilitySnapshot()` 在 `App.vue` 挂载时输出一行能力快照；测试输出可见：
  `[capabilities] 本地网关:不可用 · 局域网访问:未启用 · 在线更新:可用 · 系统托盘:未启用 · 系统通知:未启用 · 外部渠道适配器:未启用`
- 设置对话框新增“能力状态”区块，显示可用/未启用/不可用。

## 已知边界

- 当前是声明式能力矩阵，不替代真实功能探测；`lan` 与 `channels` 在 P4/P7 前固定为未启用。
- `tray` 以桌面桥接是否存在判断，未直接查询主进程托盘状态。
- 未关闭真实 Electron 的托盘/更新模块做手工降级演练。

## 未验证项

- 真实 Electron 窗口中关闭单项能力后的 UI 表现。
- 无网络环境下的更新检查降级路径。