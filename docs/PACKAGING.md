# 打包核查清单

> 每次发版 / 出安装包前必须完整执行一遍。目标：**不让“前端打开一片空白”的包流出去**。
>
> 相关命令：`npm run verify:dist`、`npm run verify:package`、`npm run verify:app`

## 1. 为什么打包后会出现白屏

Electron 生产环境用 `file://` 加载 `dist/index.html`。只要下面任意一环出问题，窗口就会是纯白（渲染进程没报错弹窗，只能开 DevTools 才看得到）：

| 现象                                                    | 根因                                                 | 对应检查                                  |
| ------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| 窗口全白，控制台报 `Not allowed to load local resource` | `dist/index.html` 里写的是 `/assets/xxx.js` 绝对路径 | `vite.config.js` 的 `base` 必须是 `'./'`  |
| 窗口全白，控制台 404 `index-xxxx.js`                    | `dist/assets` 没被带进 `app.asar`                    | 检查 `build.files` 是否包含 `dist/**/*`   |
| 窗口全白                                                | `vite build` 失败后 `dist` 已被清空，仍继续打包      | 构建失败必须中止，不能复用旧 `dist-app`   |
| 窗口全白                                                | 打包时旧程序还在运行，`app.asar` 写入不完整          | 打包前退出所有已安装/解包/便携版实例      |
| 窗口全白                                                | `dist` 是上一次构建的旧文件，与本次源码不匹配        | 重新 `npm run build`，禁止手动拼装 `dist` |
| 界面有 DOM 但看不到内容                                 | CSS 没打包或 Tailwind 未生成                         | 检查 `dist/assets/*.css` 体积与引用       |
| 窗口一直不出现                                          | `ready-to-show` 未触发                               | 主进程 10 秒兜底显示 + 错误页             |
| 打开后报错页                                            | 入口 `dist/index.html` 缺失或加载失败                | 主进程新增错误页，日志写入 `ERROR_LOG.md` |

> 结论：**白屏不是“Electron 的玄学”，基本都是产物缺失/路径错误/旧产物被复用。** 下面的清单逐项覆盖这些原因。

## 2. 标准打包流程

```bash
# 0. 退出所有正在运行的旧版本（托盘里的也要退）
#    任务管理器确认没有 APIKeyTester.exe / electron.exe

# 1. 安装依赖（首次或 package-lock.json 变更后）
npm ci

# 2. 单元测试 + 代码检查（失败就不要打包）
npm test
npm run lint

# 3. 构建 + 打包 + 自动核查（推荐，一条命令）
npm run build:win     # Windows：portable + nsis
# npm run build:mac   # macOS：dmg + zip，必须在 macOS 上执行
```

`build:win` 实际执行：

```text
node scripts/generate-providers-cjs.cjs           # 生成主进程 providers 快照
  → vite build
  → node scripts/verify-package.cjs --dist-only   # 前端产物不对，立即失败
  → electron-builder --win
  → node scripts/verify-package.cjs --require-package  # asar/安装包不对，立即失败
```

任何一步失败都会以非 0 退出码结束，**不会生成“看起来成功、打开是白屏”的包**。

> 输出目录被占用（杀毒扫描 / IDE 索引正在读新建的 `app.asar`）时，`electron-builder`
> 会在重命名 `win-unpacked` 时以 `EPERM / EBUSY` 失败。可把产物输出到别处再校验：
>
> ```bash
> npx electron-builder --win -c.directories.output="G:/path/apkey-build-output"
> APKEY_DIST_APP_DIR="G:/path/apkey-build-output" node scripts/verify-package.cjs --require-package
> ```
>
> `APKEY_DIST_APP_DIR` 只影响核查脚本读取哪个输出目录，不影响默认的 `dist-app`。

## 3. 发布前强制核查清单

### A. 构建前

- [ ] 已退出所有旧版本（安装版、免安装版、`dist-app/win-unpacked` 里的 exe、托盘常驻进程）
- [ ] `node_modules` 与 `package-lock.json` 匹配（必要时 `npm ci`）
- [ ] `package.json` 的 `version` 是本次要发布的版本
- [ ] `CHANGELOG.md` 已补充本次改动
- [ ] `npm test` 全绿、`npm run lint` 无错误
- [ ] 没有把调试代码/本地地址（`localhost:3000`、测试 Key）带进源码

### B. 前端产物（`npm run verify:dist`）

- [ ] `dist/index.html` 存在且非空
- [ ] 入口 HTML 使用相对路径（`./assets/...`），没有 `/assets/...`
- [ ] 入口引用的 JS / CSS 都真实存在且非空
- [ ] JS 通过语法检查（构建损坏会直接白屏）
- [ ] CSS 体积正常（Tailwind 未生成时会明显偏小）
- [ ] `dist` 比 `src/`、`vite.config.js`、`index.html`、`package.json` 新（不是旧产物）

### C. 应用包（`npm run verify:package`）

- [ ] `dist-app/<平台>-unpacked/resources/app.asar` 存在
- [ ] asar 内包含 `/dist/index.html`、`/dist/assets/*`、`/electron/main.cjs`、`/electron/preload.cjs`、`/electron/relay.cjs`、`/electron/lib/*.cjs`、`/package.json`、`/ico/icon-256x256.png`
- [ ] asar 内的 `dist/index.html` 与本次构建的 `dist/index.html` 完全一致（不是上一次的）
- [ ] asar 内 `package.json` 版本与项目版本一致
- [ ] 安装包（`.exe` / `.dmg` / `.zip`）存在，体积正常（Windows 版一般 > 80 MB）
- [ ] `latest.yml` 版本与 `package.json` 一致

### D. 真实运行验证（`npm run verify:app`，或手动）

- [ ] 启动 `dist-app/win-unpacked/APIKeyTester.exe`，窗口在 10 秒内出现
- [ ] 能看到“配置 / 历史 / 渠道 / 中转站 / 统计”等界面，不是白屏
- [ ] F12 打开 DevTools，Console 没有红色报错
- [ ] 顶部版本号与 `package.json` 一致
- [ ] 关闭窗口后能从托盘恢复；托盘图标正常
- [ ] 安装版与便携版各启动一次（两者都要验证）

### E. 发布

- [ ] `dist-app` 里的安装包时间戳是本次构建时间
- [ ] 上传的安装包文件名/版本与 `latest.yml` 对应
- [ ] 保留本次的核查输出（`verify:package` 日志）便于回溯

## 4. 自动化核查说明

### `npm run verify:dist`

只检查前端产物，在 `vite build` 之后立刻执行：

- `dist/index.html` 是否存在、是否包含 `#app`
- 资源引用是否为相对路径、引用文件是否存在
- JS 语法是否有效、CSS 体积是否正常
- `dist` 是否比源码新

### `npm run verify:package`

在 `electron-builder` 之后执行，额外检查：

- `app.asar` 是否包含页面、静态资源、主进程/预加载脚本、图标、`package.json`
- asar 里的 `dist/index.html` 是否与本次 `dist` 完全一致
- 安装包是否存在、体积是否异常、`latest.yml` 版本是否一致

### `npm run verify:app`

在静态检查之外，**真的启动解包目录里的 exe**，通过 CDP 检查：

- `#app` 是否渲染出内容（`innerHTML` 长度 > 500）
- `window.electronAPI` 是否存在
- 渲染进程是否有未捕获异常 / 控制台错误

这一条是“白屏”的最终防线，发版前必须跑一次。

## 5. 白屏现场排查（给已发出的问题包定位）

1. 启动应用后按 `F12`（或 `Ctrl+Shift+I`）打开 DevTools。
2. 看 Console：
   - `Not allowed to load local resource` → 绝对路径问题
   - `Failed to load resource: net::ERR_FILE_NOT_FOUND` → asar 缺资源
   - 某个模块 `SyntaxError` → 构建产物损坏
3. 查看数据目录下的 `ERROR_LOG.md`（Windows：`%APPDATA%\APIKey测试工具\ERROR_LOG.md`），本次已补充：
   - `Page Load Failed`：加载失败的错误码与 URL
   - `Renderer Console`：渲染进程控制台错误
   - `Preload Error`：preload 加载失败
   - `Packaging`：入口文件缺失
4. 检查包内文件是否齐全：

```bash
# 列出 asar 里的前端文件（需要 @electron/asar，随 electron-builder 安装）
npx asar list "dist-app/win-unpacked/resources/app.asar" | grep -i "dist"
```

5. 如果入口 HTML 或 `dist/assets` 缺失，直接重新打包，不要手工往 asar 里补文件。

## 6. 本次修复记录（防回归）

- `vite.config.js` 保持 `base: './'`：Electron `file://` 下必须使用相对路径。
- `package.json` 的 `build.files` 固定包含 `dist/**/*`、`electron/**/*`、`ico/**/*`、`package.json`。
- 构建脚本改为“构建 → 校验 dist → 打包 → 校验 asar/安装包”，任一环节失败即中止。
- 新增 `scripts/verify-package.cjs`：静态核查 + 可选真实启动渲染验证。
- 主进程新增加载失败兜底：入口缺失 / 重试仍失败时显示可读错误页，而不是纯白窗口。
- 主进程新增 `ready-to-show` 超时兜底、渲染进程错误日志、preload 错误日志。
- 打包前务必关闭旧实例，避免 `app.asar` 被占用导致写入不完整。
