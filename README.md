# Xueness 0.2.1 source archive

2026-10-26 最新交接：[Windows 安装与全链路回归](HANDOVER-20261026-WINDOWS.md)。本版本含 35 个插件；原 17 项后端回归全部通过，全量 **2,328 通过、0 失败、62 项既有跳过**，正式桌面端 13 组 UI 交互与本地真实模型调用通过。

2026-10-24 历史交接入口：[完整项目交接](HANDOVER-20261024.md)、[最新 ZCode 差异审计](docs/audits/20261024/AUDIT.md)、[完整对齐任务清单（15 阶段 / 82 小轮次）](docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.md)。本机桌面端已安装 0.2.1，包含 33 个插件和 11 项内置技能；后续全面引擎对齐尚未实施。以下 Z1–Z8 资料保留为历史交付记录，当前基线与待办以新交接为准。

后端已完整迁移到 TypeScript（`ts/`），Python 后端在第 10 轮删除。使用入口、完整验收与迁移记录见
[ts/README.md](ts/README.md) 和 [ts/HANDOVER.md](ts/HANDOVER.md)。
最新阶段范围与状态见 [Z7 工作摘要](WORK-SUMMARY-20261023-Z7.md)、[Z7 app-server 与 headless 说明](docs/engine-z7.md)、[Z8 guarded、goal 与 memory dream 说明](ts/docs/z8-guarded-goal-memory.md)、[引擎路线图](ts/docs/engine-roadmap.md) 和 [PATCH-Z7.md](PATCH-Z7.md)。Z7 已交付范围为 Xueness 原生 JSON-RPC v1/v2 与单任务 headless，不宣称 ZCode V4 wire 兼容；source/built runtime、额外 shutdown drain、706 JS build 与搬迁 smoke 均有验收记录。Z8 完成 guarded 权限、会话目标与显式项目记忆整理；memory 的源码验收记录覆盖四个场景和五次 loopback provider 请求，详见 [z8-memory-source.json](验收资料/验证记录/z8-memory-source.json)。此前 [Z6](WORK-SUMMARY-20261023-Z6.md) 动态工作流、[Z5](docs/engine-z5.md) MCP/配置/hooks、[Z4](docs/engine-z4.md) 执行适配及 [Z3](docs/engine-z3.md) 事件、会话库与回退继续作为已交付能力记录。完整迁移与当前边界见 [HANDOVER §48](ts/HANDOVER.md)。
这是源码归档；`desktop/` 包含 Electron 宿主源码，不包含 Windows 安装包。运行后端需要 Node.js 24.11+，并在首次使用前执行 `npm --prefix ts ci`。

终端聊天入口见[终端聊天使用说明](docs/xueness-terminal-chat.md)。

Nothing in this archive publishes files, creates tags, or signs artifacts.
Release downloads and the complete repository are available at:

- https://github.com/xuediner-source/xueness
- https://github.com/xuediner-source/xueness/releases

The backend is the TypeScript workspace in `ts/` and needs Node.js 24.11 or
newer; Node strips the types at run time, so no build step is required. Install
its dependencies once with `npm --prefix ts ci`. The prebuilt browser interface
is included under `webapp/dist/`. Docker Compose is optional.

Start from this directory with `bin/xueness-web --port 8138` (or
`node ts/apps/server/src/main.ts --port 8138`), then open
`http://127.0.0.1:8138`. The default port without this option is
`http://127.0.0.1:8137`; `./install.sh` does the same with a private data
directory. Configure a real model endpoint in Settings before sending a task.
Local small models can use the lightweight profile described in
`docs/xueness-local-lightweight-mode.md`. Use `bin/xueness` for the Agent CLI.

Backend checks: `npm --prefix ts run check` (line limit, plugin gate,
typecheck and tests). To rebuild the web interface: `npm --prefix webapp ci`,
then `npm --prefix webapp run build`.

The Electron host source is in `desktop/`. Build an installer on its target
operating system and architecture; see `docs/xueness-desktop.md` for commands.

Locally built installers are not automatically signed or published.

Every product feature must be implemented by a trusted bundled plugin and
listed in Settings > Plugins, including each new feature. See `AGENTS.md`,
`CONTRIBUTING.md` and `docs/xueness-plugin-architecture.md`. Run
`npm --prefix ts run check:plugins` before handing off a change.

## Get the complete checkout

```sh
git clone https://github.com/xuediner-source/xueness.git
cd xueness
```

Use the desktop installer for your operating system and architecture if you
prefer an application with its Node.js runtime already bundled.

Model credentials and other online-service configuration must be supplied by
the operator at runtime. This archive contains no runtime state or credentials.
See `LICENSE` and `NOTICE.md` before use or
redistribution.
