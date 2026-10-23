# Xueness 0.1.8 工作汇总：第 15 轮（收尾，2026-10-22）

ZCode 对齐路线图全部完成：TS 是唯一后端，Web、桌面和命令行（含全屏 TUI）只靠 Node 运行。本轮在 Linux 上补跑全套测试并定稿，详见 [ts/HANDOVER.md 第 38 节](ts/HANDOVER.md)。

## 使用

- 安装依赖：`npm --prefix ts ci`（Node 24.11 以上）。
- Web：`bin/xueness-web`（默认端口 8137）。
- 命令行：`bin/xueness`；全屏聊天：`node ts/apps/server/src/cli/main.ts chat --root . --tui`，说明见 `docs/xueness-terminal-chat.md`。
- 桌面：见 `docs/xueness-desktop.md`。
- 验收：在 `ts/` 下运行 `npm run check`。

## 本轮

- 修复：POSIX 上 `npm run build` 找不到 Node 的 `LICENSE`（macOS 桌面工作流也会因此失败）；纸感外观的会话面板去掉红色边框。
- 验证（Linux x64，Node v24.14.1）：`npm run check` 878 项测试、0 项失败；构建与 `test:built` 通过；desktop 119 项、0 项失败；webapp 1714 项全部通过；TUI 的四个验收流程在 Linux 真实伪终端上通过。
- 文档：路线图补上第 12–15 轮；新增引擎深化路线图 `ts/docs/engine-roadmap.md`。

## 历程

- 第 7 步第 1–10 轮：逐组迁走 Python 的处理方，第 10 轮删除 Python 后端（HANDOVER 第 24–33 节）。
- 第 11 轮：清理 Python 遗留（第 34 节）。
- 第 12 轮：子代理后台任务、PTY、图片与 PDF、可视化组件、Windows job object（第 35 节）。
- 第 13–14 轮：全屏 TUI，并与 ZCode 交互对齐（第 36–37 节）。
- 第 15 轮：收尾验证与定稿（第 38 节）。

## 还没做的

- 安装包、Docker 镜像和 CI 没有实际构建，需要在自己的 GitHub 仓库上跑工作流。
- macOS 终端和各平台真实剪贴板没有实机验证。
- 下一阶段：引擎深化（`ts/docs/engine-roadmap.md`），先做评测基线。
