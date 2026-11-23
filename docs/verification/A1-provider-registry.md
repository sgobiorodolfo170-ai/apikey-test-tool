# A1 供应商注册表验证记录

- 日期：2026-11-12
- 环境：Windows 11 / Node 22 / Electron 45 / 提交工作区（P1 实施中）
- 结果：通过（自动化），UI 手工验收待补
- 关联计划：[../plans/2026-11-12-borrowing-plan.md](../plans/2026-11-12-borrowing-plan.md)

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run generate:registry` | 生成 `electron/generated/providers.cjs`：7 个供应商，10 种模式 |
| `npx vitest run src/core/__tests__ src/api/__tests__/modes.test.js` | 3 个文件、18 个用例通过 |
| `npm test` | 60 个文件、674 个用例通过 |
| `npm run lint` | 通过，无 error |
| `npx vite build` | 130 个模块，构建成功 |
| `npm run verify:dist` | 5 项全部通过 |

## 证据

- `src/data/providers.json`：唯一注册表，含 7 个供应商与 10 种 apiMode。
- `src/core/providers/registry.js`：`validateRegistry` 在模块加载时校验；`getProvider` / `listProviders` 返回深拷贝。
- `src/core/__tests__/registry.test.js`：模式顺序、描述符校验、重复 id、深拷贝、适配器完整性、预设派生、CJS 快照一致性。
- `electron/generated/providers.cjs`：由脚本生成，不手工编辑。

## 已知边界

- `electron/relay.cjs` 当前不读取预设，未改为消费 CJS 快照；快照供后续主进程模块使用。
- “只改 JSON 新增一个供应商后，配置页/中转预设/`/v1/models` 全链路出现”尚未做临时供应商手工验收；当前由注册表、预设派生和构建测试覆盖数据链路。
- 全量 `npm run format:check` 仍会报告 `src/components/ConfigPanel.vue`；该文件在本次改动前已是修改状态，非 P1 引入。
- 未在真实 Electron 窗口中逐项点击验收。

## 未验证项

- 新增供应商后的真实 UI 下拉与 `/v1/models` 广播。
- macOS 构建。