# Xueness

自用的 Agent CLI 与本地 Web 工作台，面向本地小模型提供详细的轻量化配置、机器资源监测和模型输出状态展示。

功能设计参考开源 [ZCode](https://github.com/zai-org/ZCode)，采用 Xueness 自有运行时、协议和界面。现有产品能力由 **26 个可信功能插件、84 项子功能**提供，CLI、模型工具和 Web 共用插件开关与依赖检查。轻量模式参考 [Pi](https://github.com/badlogic/pi-mono) 的按需工具和预算思路；插件组织参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，不承诺上游插件 ABI 兼容。

## 获取项目

仓库：[xuediner-source/xueness](https://github.com/xuediner-source/xueness)。当前默认按私有仓库上传，需要仓库访问权限。

```sh
gh repo clone xuediner-source/xueness
cd xueness
```

仓库包含 Python 后端、全部功能插件、React 前端源码、预构建的 `webapp/dist`、测试、文档、安装入口和第三方声明。无需 Node.js 即可运行已构建界面；首次使用需配置自己的真实模型。

## 快速开始

需要 Python 3.10+，后端仅使用标准库。可选工具（Git、SSH、ffmpeg、浏览器等）按对应插件的实际使用需求安装。

```sh
# Web 工作台
python3 -m xueness.web --port 8138
# 访问 http://127.0.0.1:8138

# Agent CLI
./bin/xueness
# 为指定工作区开始对话
./bin/xueness chat --root /absolute/path/to/project
# 恢复最近会话
./bin/xueness chat --continue --root /absolute/path/to/project
```

在 Web「设置 → 模型配置」添加模型端点、模型 ID 和密钥；也可设置 `XUENESS_API_BASE`、`XUENESS_MODEL`、`XUENESS_API_KEY`。密钥保存在运行主机，不能提交到仓库。正式入口仅使用真实模型，不提供离线演示回答。

在「设置 → 工作区」选择项目目录；macOS 本机连接支持系统文件夹选择框。也可在启动时重复传入 `--workspace-root /absolute/path/to/project` 声明目录范围。端口已被本项目占用时直接打开现有页面，或选择其它端口。

CLI 支持会话选择、归档、恢复、模型切换、多行输入、附件、任务进度与中断恢复。使用 `./bin/xueness --help` 和聊天中的 `/help` 查看命令。默认状态在项目 `.state` 中，可在入口前通过 `--state DIR` 指定私有状态目录。

## 轻量模式

在模型配置中选择「本地轻量」档位，再按本机和模型情况调整提示、工具、上下文、输出预算、采样和协议兼容选项。监测界面显示实时 CPU、内存、可用的设备信息以及请求阶段、文本/思考输出和工具状态；缺失的 Token 或显存数据不会伪造。

完整配置与数据边界见 [轻量模式说明](docs/xueness-local-lightweight-mode.md)；功能取舍见 [DeepSeek Harness / Pi 源码对照](docs/xueness-harness-feature-audit-2026-10-01.md)。

## 功能插件

包括会话、文件、Shell、规划、模型、记忆、设置、用量、Git、工作流、终端、Office、命令、技能、Hooks、MCP、子代理、网络、自动化、扩展、诊断、浏览器、远程、渠道、引导和更新。

Web「设置 → 插件」显示全部 26 个插件及子功能，包含禁用和依赖阻塞状态。即使其它功能全关，也可通过账户菜单的「插件管理」恢复。CLI 使用：

```sh
python3 -m xueness plugins list
python3 -m xueness plugins disable browser
python3 -m xueness plugins enable browser
```

启用插件不代表批准文件修改、命令执行或外部操作。插件实现、依赖与实际范围见 [插件架构说明](docs/xueness-plugin-architecture.md)。

**今后每一项新增产品功能都必须由插件提供，并能在插件面板中找到。** 开发遵循 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)，不能将业务直接堆进宿主 CLI、Web 服务器、Agent 内核或工作台容器。

## 开发与验证

修改前端需要 Node.js 20.19+ 或 22.12+：

```sh
npm --prefix webapp ci
npm --prefix webapp test
npm --prefix webapp run typecheck
npm --prefix webapp run build

python3 tools/check_plugin_architecture.py
python3 -m unittest tests.test_plugin_architecture -q
python3 -m unittest discover -s tests -q
node webapp/run-validate-events.mjs
node tools/check-parity-hygiene.mjs
python3 tools/generate_web_notices.py --check
```

部分真实 MCP 互操作测试需要额外的官方 SDK 或测试服务器；缺少相应环境时明确跳过。测试 fixture 不会作为正式对话入口。前端构建和源码打包均执行插件结构门禁。

源码归属：`xueness/bundled_plugins/<id>/` 为后端功能插件，`webapp/src/plugins/<id>/` 为前端功能实现，`manifest.json` 声明模块、依赖、工具、命令、面板和双语子功能。

## One-command local deploy

```sh
./install.sh
# 默认访问 http://127.0.0.1:8137
# 自定义端口和私有状态目录
PORT=9000 DATA_DIR=/absolute/path/to/private-data ./install.sh

# 可选：Docker Compose
# 需要能够拉取 Python 基础镜像
docker compose up --build -d
```

本地安装入口不会进行系统级安装。Compose 将主机端口绑定到 `127.0.0.1:8137`，持久数据保存在 `xueness-data` 卷。详见 [部署说明](docs/deploy.md)。

这是单人本地工具，Web 没有多用户认证、TLS 或操作系统沙箱。保留默认 loopback 绑定；文件写入、命令执行等受权限、批准、插件开关及工作区检查约束。公开暴露服务需要单独设计认证与 TLS。

源码上传不等于版本发布：尚未建立发行标签、签名或容器镜像。需要稳定版本时，选择并记录经验证的提交 SHA，不将开发分支宣称为不可变发行版。源码打包见 [发布准备说明](docs/release-preparation.md)，GitHub 上传范围见 [仓库上传说明](docs/github-publishing.md)。

## 文档与归属

- [设置和工作区](docs/xueness-settings-workspaces.md)
- [对话开始界面](docs/xueness-start-interface.md)
- [CLI、工具、工作流和 Web 使用说明](docs/xueness-four-workstreams.md)
- [项目选择与会话历史](docs/xueness-project-history-2026-10-01.md)
- [插件贡献流程](CONTRIBUTING.md)

历史审查位于 `docs/` 和 `reviews/`，其中阶段记录描述当时版本，当前范围以插件架构说明为准。历史验收截图属于本机 QA 产物，不随源码上传。

许可证与上游归属见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 和随界面分发的第三方声明。原版机壳及 vendor 源码已移除，Xueness 不是官方 ZCode 产品。
