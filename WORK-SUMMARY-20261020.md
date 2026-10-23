# Xueness 0.1.8 工作汇总（2026-10-20）

工作树：`Xueness-0.1.8-complete-project`。Python `xueness/` 冻结，只改 `ts/`。每个 `.ts` 文件不超过 400 行。`packages/providers/src/http.ts` 已是 400 行，不要改。验收命令在 `ts/` 下：

```
$env:XUENESS_PYTHON = "C:\Users\19404\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\python.exe"
npm run check
```

解压后先在 `ts/` 执行 `npm install`。压缩包不含 `ts/node_modules`（Windows 上是指向本机的目录联接）和 `__pycache__` / `*.pyc`。

## 已完成

ZCode 对齐第 7 步第 1 轮到第 5 轮已完成，见 `ts/HANDOVER.md` 第 24–28 节，路线图 `ts/docs/zcode-alignment-roadmap.md` 下一步仍指向第 6 轮。

第 5 轮（2026-10-20）把 usage、model_monitor、onboarding 的桌面标记、diagnostics、tools 的 call-budget、terminals、长度 3 的 updates，以及 desktop 的 status/tray/permissions/host-capability 交给 TS。不接管 `/api/workflows` 和 `/api/workspaces`。当时检查：718 个文件，25 个插件、286 个源文件，874 项测试，860 通过，14 跳过，0 失败。

## 第 6 轮：已停，未验收

范围：remote、subscriptions、bots、automation。Z.AI 账号不做。前门、`bundled-plugins.ts`、插件门禁（仍是 25）都没改。下面这些文件未接线，也没有跑过 `npm run check`。

已写：

- `ts/plugins/remote/`：`package.json`、`manifest.json`、`src/store.ts`、`handshake.ts`、`exec.ts`、`tool.ts`、`manager.ts`、`manager-ops.ts`、`connection-state.ts`、`summary.ts`、`test/store.test.ts`
- `ts/plugins/bots/`：`package.json`、`manifest.json`、`src/store.ts`
- `ts/plugins/automation/`：`src/offpeak.ts`、`offpeak-queue.ts`、`offpeak-settings.ts`、`offpeak-http.ts`、`tool.ts`

未写：

- remote：`index.ts`、`http.ts`、`client.ts`、`protocol.ts`、`replay.ts`、stdio app-server
- bots：Telegram 请求、inbox、HTTP、`index.ts`、测试
- automation：`package.json`、`manifest.json`、`index.ts`、cron、workflow bridge
- subscriptions：整个插件
- 前门 `round6-http.ts`，以及 composer 在 remote/subscriptions 生效时不再整请求转发给 Python

下次从这些半成品接着写，不要重头开，也不要把它写成 HANDOVER 第 29 节，直到 `npm run check` 通过并记下真实计数。
