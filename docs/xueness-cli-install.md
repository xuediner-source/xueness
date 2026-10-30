# Windows CLI 一键安装

在 Windows x64 的 PowerShell 5.1 或更新版本运行：

```powershell
irm https://raw.githubusercontent.com/xuediner-source/xueness/main/install.ps1 | iex
```

安装包自带 Node.js，不需要预先安装 Node、npm、Git 或桌面版。安装器校验 ZIP 的 SHA256，在当前用户的 `%LOCALAPPDATA%\Programs\XuenessCLI` 保存版本，并把 `bin` 加入当前进程及用户 PATH；无需管理员权限，不更改系统 PATH 或 PowerShell 执行策略。已有终端宿主如果缓存了 PATH，请关闭后重新打开。

```powershell
xueness --version
xueness onboarding
xueness
```

`onboarding` 配置你自己的模型接口，密钥输入不回显。裸命令 `xueness` 在当前项目目录打开终端界面；其余 CLI 命令保持可用，例如 `xueness providers list`、`xueness doctor --json` 和 `xueness headless --help`。

会话、插件设置和模型配置默认保存到 `~/.xueness/state`，与程序版本目录分开；`XUENESS_STATE_DIR` 或全局 `--state` 参数可以指定已有目录。不会自动迁移桌面凭据。比如显式复用已有桌面配置：

```powershell
xueness --state "E:\models\apps\xueness-data\state" chat --tui
```

## 更新与分发

更新时重新执行安装命令。每个版本单独保存，下载、校验和启动检查通过后才切换启动器；旧进程可继续使用旧目录，模型配置与会话不被覆盖。当前同版本的完整副本会直接复用。源码安装的 `update check/apply` 不是独立 CLI 包的更新入口。

Windows ARM64、Linux 和 macOS 的独立 CLI 包尚未发布；这些平台继续使用[源码 CLI](xueness-terminal-chat.md)。本安装通道独立于桌面 Releases，不更改桌面更新源。

高级安装可在执行前设置 `XUENESS_INSTALL_DIR`。产品更新只写该目录；卸载时移除该目录及用户 PATH 中对应的 `bin` 条目即可，`~/.xueness/state` 默认保留。

开发分发使用 `npm --prefix ts run build`，然后 `node ts/scripts/package-cli.ts <新的输出目录>`。发布的 `cli/latest.json` 仅包含版本、下载地址、源提交和摘要；不加载清单中的代码。安装、启动器与分发契约归属 `desktop.cli_distribution`，测试和安装验收记录放私有验证库。
