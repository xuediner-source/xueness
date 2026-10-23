# Xueness 0.1.8 工作汇总（2026-10-22）

工作树：`Xueness-0.1.8-complete-project`。后端是 `ts/` 下的 TypeScript 工作区，前端在 `webapp/`。每个 `.ts` 文件不超过 400 行（`packages/providers/src/http.ts` 正好 400 行，不要改）。验收命令在 `ts/` 下：

```
npm run check
```

解压后后端仍需安装依赖：`npm --prefix ts ci`。`webapp/dist/`（166 个文件）是预构建界面，避免安装前端依赖或构建前端即可启动 Web；压缩包不含 `ts/node_modules`、`ts/dist`、`webapp/node_modules`。

## 本轮完成：剩余差异第 1 批

对应 `ts/HANDOVER.md` 第 35 节，处理路线图第 3 节列出的前五项差异。

1. **子代理后台任务**。`TaskCoordinator` 与 `/api/sessions/:id/tasks` 早就在，缺的是注册工具与接线。新增 `plugins/subagents/src/background-tools.ts`（`task_collect`、`task_resume`、`task_send_message`）；`task` 在有 coordinator 时走 `coordinator.dispatch` 后台派发，否则退回前台。`subagentsExtension` 的 `capabilities` 改成 getter（有 coordinator 才声明 `subagents.coordination`），远程会话连 `task` 一起摘掉。服务端在 `subagents` 启用且非远程时构造 coordinator 并绑定后台 runner。顺带修了 `coordinator.sync()`：它原本用 registry 行整体覆盖 `session.task_runs`，丢掉 `childSessionId` / `parentSessionId` / `rootSessionId` / `canResume` / `recoveryReason` / `childStatus` 和归一化的 `agent` id。

2. **PTY 终端**。原来的 broker 是 `child_process` 管道，注释明确写着「不是 ConPTY」。新增 `packages/engine-tools/src/pty.ts` 包装 `@lydell/node-pty`（预编译二进制，安装时不编译）；`plugins/terminal/src/broker.ts` 重写为 `kind: "pty" | "pipe"`，PTY 可用时走 PTY，否则退回管道，`resize` 真正下发。插件仍只依赖 `@xueness/*`，node-pty 装在 `@xueness/engine-tools` 里。

3. **图片与 PDF**。新增纯 TS 的 GIF89a 编码器（`image/gif-encode.ts`），超尺寸 GIF 保持 GIF 而不是掉到 JPEG 阶梯；`flatten()`（透明区刷白）换成 `dropAlpha()`（保留源里存的 RGB，与 jimp 的 JPEG 编码器一致）；PDF 现在也发给 OpenAI 兼容族与 Gemini（`{ type: "file", file: { filename, file_data } }`）。

4. **可视化组件的保存状态与自适应高度**。修两个真实缺陷：`GET /api/visualizations` 带 `sandbox allow-scripts`，页面是不透明源，自己的 `localStorage` 会抛错，所以 `setWidgetState` 从来存不下来；外壳量了高度却从不告诉嵌入方，`.xn-viz` 一直是 CSS 固定的 520px。现在外壳与 webapp 之间走 `xueness-visualization-*` 消息：状态读写先问宿主、失败才退回本地存储；高度只在片段自测之后上报。

5. **Windows job object**。`taskkill /T /F` 是杀的时候遍历进程树，重新挂到别处的孙进程会漏；宿主崩溃时退出钩子根本不执行。新增 `packages/engine-tools/src/windows-job.ts`：每宿主一个 job object，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，句柄从不显式关闭（避免提前杀掉故意活过父进程的后台孙进程）。

## 验证

在 Windows x64、Node v24.19.0 上实测：

- `npm run check`：832 项测试、249 个套件，**772 通过、0 失败、60 跳过**；`check:lines` 836 个文件（最大仍是 `packages/providers/src/http.ts` 400 行）；`check:plugins` 30 个插件 / 344 个源文件；typecheck 通过。
- `npm run build` + `npm run test:built` 通过（静态 UI、原生会话/历史、插件目录、健康检查、未拥有路由 404）。
- 构建产物内能启动真实 PTY（`BUILT-PTY-OK`），`@lydell/node-pty-win32-x64` 的 `conpty.node` / `conpty.dll` / `OpenConsole.exe` 随构建复制。
- webapp：`typecheck` 通过，`npm test` **1713 项全过**，`build` 成功，`dist` 166 个文件。
- `complete-project-manifest.json` 1965 项（不含清单自身；第 13 轮更正原记录的 1964），复核 `changed 0`。

## 已知差异与遗留

- **60 项跳过**是 Python 对照测试（`*-python.test.ts`、`test-support/python-oracle.ts`），本机没有 CPython 3.11 后端。完整对照需要将 `XUENESS_PROJECT_ROOT` 指向仍包含 `xueness/` 的第 9 轮检查点，并将 `XUENESS_PYTHON` 指向 CPython 3.11+。`HANDOVER` 第 34 节记录的「853 项 / 800 通过 / 53 跳过」在这台机器上复现不出来，本轮按实测数字记录，第 34 节作为历史记录未改。
- **PTY 只在 Windows 上实测**。Linux 的 `pty.node` 确认在包里但没有在这里跑；macOS 完全未验证，需打包后在目标系统上确认。
- **webapp 构建在 Windows 上有坑**：`vite build` 会先清空 `webapp/dist`，再因 esbuild 无法删除系统临时目录而失败。规避方式是构建到项目内临时 `outDir` 再替换（本轮即如此）。问题本身属于 esbuild/vite 的 Windows 行为，没有修改。
- 观察到 `plugins/mcp/test/mcp-stdio.test.ts` 与 `plugins/browser/test/browser-worker.test.ts` 各有一次偶发失败，单独重跑 3 次与全量重跑均通过，与本轮改动无关，未改动它们。
- **未做**：全屏 TUI（路线图第 6 项，ZCode 约 1.4 万行，需按 400 行上限拆分，预计 3–5 轮）；安装包、Docker 镜像与 CI（第 7 项，需要在各目标系统 / 用户自己的 GitHub 上跑工作流）。`ts/scripts/stage-desktop-release.ts` 仍只用假 `gh` 测过。
- 其余差异见 `ts/docs/zcode-alignment-roadmap.md` 第 3 节状态：actor 工具范围、worker 里解析不了订阅模型、CLI 无全屏 TUI、Office 预览无 `fullDocument`、`doctor` 的 `version.python` 沿用旧名、不读视频等。

## 下一步

1. 全屏 TUI（第 6 项）：单独开轮，先拆分再接线。
2. 安装包 / Docker / CI（第 7 项）：需在 macOS、Windows 各自的机器上构建安装包，并在真实 GitHub 仓库上跑工作流。
3. 在 Linux 与 macOS 上各跑一次 `npm --prefix ts run check` 与 PTY 用例，补上这两个平台的实测记录。
