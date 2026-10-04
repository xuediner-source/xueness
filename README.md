# Xueness

<div align="center">
  <img src="docs/images/xueness-banner.svg" alt="Xueness — 本地 Agent 工作台" width="100%">
  <p>Agent CLI、本地 Web 工作台与自包含桌面应用，共用一套可开关的功能插件。</p>
  <p>
    <a href="README.en.md">English</a> ·
    <a href="https://github.com/xuediner-source/xueness/releases/latest">下载桌面版</a> ·
    <a href="docs/xueness-desktop.md">桌面文档</a> ·
    <a href="docs/xueness-local-lightweight-mode.md">本地轻量模式</a> ·
    <a href="docs/xueness-plugin-architecture.md">插件目录</a>
  </p>
  <p>
    <a href="https://github.com/xuediner-source/xueness/actions/workflows/desktop-build.yml"><img src="https://github.com/xuediner-source/xueness/actions/workflows/desktop-build.yml/badge.svg?branch=main" alt="Desktop build"></a>
    <a href="https://github.com/xuediner-source/xueness/blob/main/LICENSE"><img src="https://img.shields.io/github/license/xuediner-source/xueness?label=license" alt="Apache 2.0 license"></a>
    <a href="https://github.com/xuediner-source/xueness/releases/latest"><img src="https://img.shields.io/github/v/release/xuediner-source/xueness?label=release" alt="Latest release"></a>
    <img src="https://img.shields.io/badge/plugins-27%20%7C%20104-4263eb" alt="27 plugins and 104 features">
  </p>
</div>

<p align="center">
  <img src="docs/images/workbench.png" alt="Xueness 对话与本地工作台" width="100%">
</p>
<p align="center">
  <img src="docs/images/lightweight-settings.png" alt="本地轻量高级配置：预算、工具与恢复" width="49%">
  <img src="docs/images/plugins.png" alt="完整功能插件目录" width="49%">
</p>
<p align="center"><sub>实际构建界面，使用隔离工作区与示例配置；不含用户会话或模型性能结果。</sub></p>

Xueness 面向个人本地开发，提供可从终端、浏览器或 Windows/macOS 桌面使用的 Agent 工作区。重点放在本地模型的细粒度运行配置、可见的主机与请求状态，以及能按领域启用或停用的产品功能。

## 下载

[打开 GitHub Releases](https://github.com/xuediner-source/xueness/releases/latest)，选择与系统和处理器架构匹配的安装包。版本页面会列出桌面产物及 `SHA256SUMS.txt` 校验文件。

| 系统 | 安装程序 / 磁盘映像 | 便携版 / 应用 ZIP |
| --- | --- | --- |
| Windows 10/11 · x64 | [安装程序 `.exe`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/Xueness-0.1.2-windows-x64-setup.exe) | [便携版 `.zip`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/Xueness-0.1.2-windows-x64-portable.zip) |
| macOS · Apple Silicon | [arm64 `.dmg`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/Xueness-0.1.2-macos-arm64.dmg) | [arm64 应用 `.zip`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/Xueness-0.1.2-macos-arm64.zip) |
| macOS · Intel | [x64 `.dmg`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/Xueness-0.1.2-macos-x64.dmg) | [x64 应用 `.zip`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/Xueness-0.1.2-macos-x64.zip) |

此版本所有平台的 SHA-256 校验值见 [`SHA256SUMS.txt`](https://github.com/xuediner-source/xueness/releases/download/v0.1.2/SHA256SUMS.txt)。桌面包内含 Electron 外壳、冻结 Python 后端、预构建工作台和浏览器驱动；不要求另外安装 Python 或 Node.js。Git、SSH、ffmpeg 等外部程序仍由使用到它们的插件按需调用；浏览器自动化需要本机 Chrome 或 Edge。当前产物未进行代码签名或 macOS 公证，首次启动可能出现系统信任提示，详情见[桌面端说明](docs/xueness-desktop.md)。

## 功能概览

- **本地小模型配置。** 选择「本地轻量」运行档，细调提示、工具集合、上下文与输出预算、采样和协议选项。资源面板报告运行 Xueness 的机器 CPU、内存及进程状态；模型输出面板展示请求阶段、工具调用和服务实际返回的用量。缺少的 Token 或显存数据会标为不可用，不会估算成真实测量值。
- **27 个可信插件，115 项登记功能。** 会话、工作区文件、模型、Shell、Git、终端、工作流、记忆、Hooks、MCP、浏览器、远程连接、渠道、自动化、诊断、Office 预览等能力都有明确归属。插件管理页显示完整目录与依赖状态，CLI 也可查看和更改插件开关。会话支持运行中排队追加消息，桌面端支持确认导入 Chrome 资料到独立浏览器目录。
- **给会话设一条持续目标。** 开始新任务时在 Composer 的「+」菜单选择「添加为目标」，或用 CLI `--target` 设定；目标跨轮生效并每轮以短提示注入模型，会话标题下方一行徽标可查看或清除。运行结束时主机核对回答是否明确声明达成，未声明则进入需要复核状态。核对是确定性的规则判断，不额外调用模型，也不替用户证明目标真的完成。该能力归属规划插件，关闭后入口、注入与核对一并停止。
- **三种入口，共用运行时。** 使用 Agent CLI 运行会话，通过 loopback Web 工作台查看和管理任务，或安装 Windows/macOS 桌面应用。桌面包自带运行时，跨平台差异留在对应插件适配中。

轻量设置用于控制运行行为，不会下载模型、调整模型权重或自动改变推理服务的显存分配。Office 预览支持部分文档页面、图像、图表和缓存单元格数据；它不是 Microsoft Office 的完整排版或兼容实现。

## 快速开始

### Web 工作台与 CLI

源码运行需要 Python 3.10+；后端仅依赖 Python 标准库，仓库附有预构建的 Web 界面，日常运行不需要 Node.js。

```sh
git clone https://github.com/xuediner-source/xueness.git
cd xueness

# 启动仅监听本机的 Web 工作台
python3 -m xueness.web --port 8138
# 浏览器打开 http://127.0.0.1:8138

# 通过 Agent CLI 开始会话
./bin/xueness chat --root /absolute/path/to/project
# 继续该工作区最近一次会话
./bin/xueness chat --continue --root /absolute/path/to/project
# 指定独立私有状态目录（全局参数放在子命令之前）
./bin/xueness --state /absolute/path/to/private-state chat --root /absolute/path/to/project
# 为会话设置跨轮持续生效的目标（已有目标时需加 --target-replace 才会覆盖）
./bin/xueness run --root /absolute/path/to/project --prompt "补齐导出命令的测试" --target "让导出命令具备完整测试与使用说明"
# 查看、替换或清除某个会话的目标
./bin/xueness goal --session <会话ID> show
./bin/xueness goal --session <会话ID> replace "新的目标文本"
./bin/xueness goal --session <会话ID> clear
./bin/xueness --help
```

首次使用时，在「设置 → 模型配置」填写自己已运行的模型服务地址、模型 ID 和密钥。也可以将 `XUENESS_API_BASE`、`XUENESS_MODEL`、`XUENESS_API_KEY` 配置在本机环境中。Xueness 不提供伪造的离线对话入口。

Web 设置可以选择和授权工作区。CLI 默认在项目的 `.state/` 保存会话与配置；使用 `--state /absolute/path/to/private-state` 指定独立状态目录。状态中可能包含任务文本、工具输出和模型凭据，应留在私有目录，不要提交到公共仓库。桌面数据路径和桌面与 CLI 的共享方式见[桌面文档](docs/xueness-desktop.md)。

### 本机一键运行

在已克隆的仓库根目录执行：

```sh
./install.sh
# 默认地址：http://127.0.0.1:8137

# 可指定端口和独立的数据目录
PORT=9000 DATA_DIR=/absolute/path/to/private-data ./install.sh
```

此入口不做系统级安装，Web 默认只绑定 loopback。Docker Compose 也是可选的本地运行方式，详见[部署说明](docs/deploy.md)。

## 插件与安全边界

每项产品功能由可信内置插件提供。Web「设置 → 插件」列出完整的后端 catalog、依赖和子功能；禁用项也保留在目录中。所有者要求今后的功能继续遵守这条插件归属规则，实施步骤见 [AGENTS.md](AGENTS.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。插件注册表由构建时 allowlist 决定；扩展市场的清单是数据，不会在运行时加载任意代码。

启用插件不等于批准执行。文件修改和命令仍受 Gate、逐项审批、工作区范围与宿主请求边界控制。Web 面向单人本地使用，默认仅监听 loopback；它没有多用户认证、TLS 或操作系统级沙箱，不要直接暴露到局域网或公网。模型密钥由本机后端持有，不应写入工作区或提交到 Git。

## 开发

后端开发使用 Python 3.10+；编辑和构建前端需要 Node.js 20.19+ 或 22.12+。功能实现和开关行为必须遵守插件归属、权限及生命周期约束。最短结构验证入口：

```sh
python3 tools/check_plugin_architecture.py
python3 -m unittest tests.test_plugin_architecture -q
```

更完整的测试命令、依赖和贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。桌面构建需要目标平台原生环境、Node.js 24 和 Python 3.12+；PyInstaller 后端需在目标 OS 和架构上构建，细节见[桌面构建说明](docs/xueness-desktop.md)。

## 文档

- [桌面版、数据位置与平台支持](docs/xueness-desktop.md)
- [网络搜索配置与 FakeIP DNS 诊断](docs/xueness-network-tools.md)
- [本地小模型轻量模式](docs/xueness-local-lightweight-mode.md)
- [插件架构与逐项归属清单](docs/xueness-plugin-architecture.md)
- [CLI、工作流和工作台使用说明](docs/xueness-four-workstreams.md)
- [部署与网络边界](docs/deploy.md)
- [贡献指南](CONTRIBUTING.md)

## 许可与来源

本仓库使用 [Apache License 2.0](LICENSE)。Web 界面包含经适配的 [ZCode](https://github.com/zai-org/ZCode) 界面素材，相关版权和改动说明见 [NOTICE.md](NOTICE.md)；Xueness 使用自己的 Agent 运行时、插件接口和 Electron 桌面外壳，并非 Z.AI、ZCode 或 DeepSeek 的官方产品。插件接口是 Xueness 自有实现；本项目不宣称与上游插件 ABI 兼容，也不声称完整复刻上游功能。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 仅作为架构与桌面设计参考，没有随本项目分发其桌面代码、商标或图标。Web 及桌面依赖的许可说明随源代码和产物提供，另见 [第三方声明](webapp/public/third-party-notices.txt)。
