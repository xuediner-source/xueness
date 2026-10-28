# Windows 已安装版本：Xueness 0.2.1

截至 2026-10-24，本机 Windows 安装目录 `E:/models/apps/Xueness` 已更新至 0.2.1。`current-release/local-desktop-update.json` 记录资源哈希核验成功、桌面宿主未变，以及 388 个用户状态文件保持不变。随后完成本机 Windows Medium integrity 修复：处理成功，未发现仍为 Low integrity 的项目，临时目录写入探测通过。这是本机 Windows 运行完整性修复记录。

## 插件与技能

安装版核验显示插件目录共有 33 个插件，内置 11 项技能：原有的 `docx`、`pdf`、`pptx`、`visualize`、`xlsx`，以及用户选择的六项 Seagull 技能。安装核验确认这些技能来自 bundled 目录，并出现在插件目录和技能选择入口中。

`native_ops` 与 `batch_calls` 为初始插件并默认启用。WorkBuddy、订阅中心和模型监测为可选插件，新状态默认未安装。启用 WorkBuddy 后，设置页提供号池状态、账号添加或更新、逐账号删除功能。

本机证据位于 `E:/models/apps/_stage-z8/current-release/`：`installed-skills-verification.json`、`installed-integrity-fix.json`、`local-desktop-update.json`。这些记录覆盖安装资源校验、用户状态保留、Medium integrity 修复，以及插件和技能的安装与加载；不代表 328 项功能均已逐项实测。

## Windows 安装包

本机完整二进制及校验值见 `E:/models/apps/_stage-z8/current-release/SHA256SUMS.txt`：

- `Xueness-0.2.1-windows-x64-portable.zip`：`aa5d12ec7b94b0aaf057a9b7d6dbf9e9e24865478269e5a2e7857b218d8b9097`
- `Xueness-0.2.1-windows-x64-setup.exe`：`6bdce08e7e0660c9b7175696104f4c988b40eff56232d68b093dc05302846122`

## GitHub 与完整对齐路线

用户已授权将当前源码同步到既有 GitHub 仓库，本次源码快照以对应交付提交为准。Windows 0.2.1 二进制 Release 仍为草稿；旧版本清理尚未执行。

后续完整 ZCode 对齐以 [`docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.md`](https://github.com/xuediner-source/xueness-private-tests/blob/main/archive/project/docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.md) 为入口。新阶段尚未实现；已有 Z8 工作不代表完整 ZCode 对齐已经完成。
