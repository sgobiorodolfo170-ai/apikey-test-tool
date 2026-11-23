# A10 验证记录：网络细节与局域网安全

日期：2026-11-12 · 阶段：P4（A5 + A10）

## 目标

补齐网关的网络细节：启动错误可操作提示、局域网访问默认关闭且强制鉴权、
LAN 地址过滤虚拟网卡、`NO_PROXY` 绕过判定。

## 改动清单

### 新增模块（纯函数 + 单测）

- `electron/lib/net.cjs`：
  - `classifyListenError(error, port)`：
    - `EADDRINUSE` → `{ reason:'port_in_use', alternativePort: port+1（≥65535 时为 0）, message:'端口 X 已被占用，可改用 Y' }`；
    - `EACCES`/`EPERM` → `{ reason:'permission_denied', message 含「权限不足」「不建议以管理员权限运行」 }`；
    - `EADDRNOTAVAIL` → `address_unavailable`；其余 `unknown`。
  - `listLanAddresses(interfaces)`：默认读 `os.networkInterfaces()`；过滤虚拟网卡
    （vethernet/vmware/virtualbox/hyper-v/docker/wsl/tun/tap/bridge/bluetooth/teredo 等），
    跳过 internal/IPv6/127./169.254.；返回 `[{name,address,physical}]`，物理网卡优先排序。
  - `resolveProxyBypass(target, env)`：读 `NO_PROXY`/`no_proxy`；`*` 全绕过；
    主机名小写、去端口/尾点；规则匹配 `host===bare || host.endsWith('.'+bare)`。

### relay.cjs / main.cjs 接入

- `start()`：`lan.enabled` → 监听 `0.0.0.0`，否则 `127.0.0.1`；
  开启 LAN 但无访问 Key → 拒绝启动 `LAN_KEY_REQUIRED`；
  listen error 附 `error.listenError = classifyListenError(...)`。
- `identifyClient`/`isLoopbackRequest`：无 Key 时仅回环地址（`::1`/`::ffff:127.0.0.1`/`127.*`）放行，
  非回环拒绝（空地址 fail-closed）。
- `getStatus()`：新增 `listenHost`、`lan:{ enabled, active, addresses }`。
- `update()`：LAN 监听地址运行中不能热切换，改动记诊断「需重启生效」。
- `main.cjs` relay-start catch：回传 `listenError.message` 与 `alternativePort`。

### 配置 / store / UI

- `lan` 贯穿 `storage.js`（默认 `{enabled:false}`＋迁移）、`relayStore.js`、`relay.cjs`。
- `relayStore.setLanEnabled`：无访问 Key 时拒绝并提示；运行中改动提示需重启。
- `RelayPanel.vue`「局域网访问」开关＋风险提示＋过滤后的局域网端点列表（点击复制）；
  修复拒绝开启时勾选态与状态不同步的问题（handler 回填 `event.target.checked`）。

## 验证证据

环境：Windows 11 / Node v22.22.2 / Electron 45.0.0 / 基线提交 a5441a6（P4 改动尚未提交）。

| 检查项                                                  | 结果                         |
| ------------------------------------------------------- | ---------------------------- |
| `npx vitest run src/__tests__/net.test.js`              | 14 用例全过（纯函数）        |
| `npx vitest run src/__tests__/relayLan.test.js`         | 8 用例全过（鉴权/绑定/分类） |
| `npx vitest run src/stores/__tests__/relayStore.test.js`| 39 用例全过（含 LAN 守卫）   |
| `npx vitest run src/components/__tests__/RelayPanel.test.js` | 39 用例全过（含风险提示） |
| `npm run lint`                                          | 通过                         |
| `npm run format:check`                                  | 通过                         |
| `npm test`                                              | 72 文件 / 816 用例全过       |

`net.test.js` 覆盖：EADDRINUSE 替代端口、EACCES 文案、虚拟网卡过滤、物理网卡优先、
`NO_PROXY` 的 `*`/精确/后缀匹配。

`relayLan.test.js` 覆盖：`isLoopbackRequest` 判定、无 Key 非回环拒绝、LAN 默认关闭、
`LAN_KEY_REQUIRED` 拒绝、LAN+Key 绑定 `0.0.0.0`、EADDRINUSE 分类。

## 已知边界

- **`NO_PROXY` 未强制接管 Chromium 代理**：中转站上游用 Node `http`/`https` 直连，不经系统代理；
  测试页 `net.fetch` 走 Chromium/系统代理与其 bypass。`resolveProxyBypass` 已实现并有单测，
  用于直连链路绕过判定，未改写 `session.setProxy`（避免覆盖系统代理设置带来回归）。
- LAN 地址列表基于 `os.networkInterfaces()` 名称启发式过滤，极端命名（如自定义虚拟网卡名）可能漏判。
- 监听地址与端口一样需重启生效，运行中仅记诊断提示。

## 未验证项

- 真实跨设备局域网访问（另一台机器持 Key 调用）未手动联调；绑定 `0.0.0.0` 与鉴权由集成测试覆盖。
- `EACCES` 真实触发（低权限端口）未在真机复现，由 `classifyListenError` 单测覆盖文案与替代端口逻辑。
- 代理环境下 `NO_PROXY` 的端到端行为未验证（见已知边界）。