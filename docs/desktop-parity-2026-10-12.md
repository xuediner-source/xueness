> Historical reference from 2026-10-12, before the TypeScript/Z8 migration; current behavior is defined by [README.md](../README.md) and [ts/docs/z8-guarded-goal-memory.md](../ts/docs/z8-guarded-goal-memory.md).

# 0.1.6 Windows 与 macOS 统一

会话界面和插件运行机制使用同一份源码与预构建工作台。查找会话在 macOS 使用 Cmd+F，在 Windows 使用 Ctrl+F；当前轮引导、排队反向发送和快捷键标签沿用各平台的 Mod 键。macOS 原有原生菜单、Dock 窗口恢复、标题栏安全区和用户数据目录继续生效。

桌面构建分别使用 Windows x64、Mac Intel x64 和 Mac Apple Silicon arm64 的原生运行器。Python 后端冻结和 Electron 打包都核对宿主系统与处理器架构，拒绝误用另一平台或架构的运行时。Windows 不能生成可运行的 Mac 后端。

推送 main 后，Desktop installers 工作流默认采用快速构建：插件归属、必要平台检查、前端类型检查和构建、原生后端冻结、桌面打包、隔离数据的真实安装包界面启动检查，以及安装包校验值。产物保留 14 天。按用户要求，此路径不运行全量测试；手动选择 fast_build=false 仍可运行扩展发布检查。稳定版本的 stage 工作流仍要求扩展检查和 Windows 安装更新演练通过，快速构建不会冒充这类证据。

0.1.6 产物与已发布的 0.1.5 分开。源码和原生构建产物上传到现有 GitHub 仓库，既有客户端的会话、模型配置、工作区和插件状态不随打包改变。当前产物继续沿用仓库既有签名配置。
