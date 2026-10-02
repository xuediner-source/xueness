# Xueness 桌面端

桌面端使用独立实现的 Electron 外壳，复用 Xueness 工作台与插件运行时。安装包内置平台原生的 Python 后端和预构建 Web 资产，用户不需要安装 Python、Node.js 或开发依赖。

## 平台与产物

- Windows 10/11 x64：NSIS 安装程序（可选安装目录、开始菜单/桌面快捷方式、系统卸载入口），以及完整便携 ZIP。便携版解压整个目录后运行 `Xueness.exe`。
- macOS Apple Silicon：arm64 DMG 与应用 ZIP。
- macOS Intel：x64 DMG 与应用 ZIP。两个 Mac 版本分别构建，不能混用内置后端架构。

打开 DMG 后将 Xueness 拖到 Applications。当前构建没有开发者证书签名或 Apple 公证，首次运行需按系统安全提示批准；Windows 也可能显示未验证发布者。构建不关闭系统安全设置。

首次启动在模型设置中填写自己的模型连接，可选择本地轻量档位。Git、SSH、ffmpeg 等外部工具仍按所用插件安装。浏览器插件内置 Playwright 驱动，并复用 Electron 的 Node 运行时；无需另装 Node/Playwright。浏览器自动化使用已安装的 Chrome/Edge，Windows 自动检测常见安装路径；也可通过 `XUENESS_BROWSER_EXECUTABLE` 指定 Chromium 浏览器。“内置运行时”不表示打包了每种外部开发工具。

## 数据与升级

默认使用 Electron 的 Xueness 用户数据目录：Mac 在 `~/Library/Application Support/Xueness`，Windows 在 `%APPDATA%/Xueness`。会话与模型配置在其中的 `state/`，运行工作区在 `runs/`，默认项目在 `workspace/`。更新应用文件不会删除这些数据，Windows 卸载也保留应用数据。

可在启动前用 `XUENESS_DESKTOP_DATA` 指向独立数据目录。CLI 如需与桌面共享数据，使用 `python -m xueness --state /absolute/path/to/Xueness/state ...`。本项目原有 `.state` 不会被自动复制或更改，也不会打进安装包。

## 插件归属与进程生命周期

桌面集成属于第 27 个 `desktop` 插件，插件面板可看到原生目录选择、桌面状态及宿主相关能力。窗口、私有后端通道和插件恢复入口作为运行宿主基础设施保持可访问；禁用 desktop 后原生选择和桌面状态 API 停止工作，其它插件按各自开关运行。settings/sessions 的工作区授权和开关仍优先。

主进程创建随机 loopback 端口及独立宿主凭据。凭据通过进程环境传入后立即从后端环境移除，渲染进程没有 Node.js 或任意 Electron IPC 权限。目录选择通过私有父子进程通道交给窗口所属的系统对话框，只有系统返回的目录经后端校验后进入授权范围。

Windows 窗口按钮区使用工作台标题栏的背景与文字颜色，跟随浅色、深色及系统主题切换。隔离 preload 仅读取主题 CSS token 并发送固定颜色消息，不向页面暴露 Electron API；主进程校验窗口、主 frame、私有后端 origin 和颜色格式，窗口关闭后移除监听。窗口配色属于 `desktop.window_chrome` 的宿主恢复基础设施，关闭业务插件后仍与工作台保持一致。

应用单实例运行，重复打开聚焦现有窗口。关闭窗口/退出应用停止后端与所属子进程；Windows 通过 Job Object 保证宿主结束时清理继承任务，超时还会终止所拥有的进程树。POSIX 工作流跟踪宿主所属 worker，并在父进程丢失后取消命令；同一状态目录中由 CLI 启动的 worker 不属于桌面清理范围。POSIX 终端保持真实 PTY，Windows 使用真实 ConPTY 和固定 PowerShell/CMD 配置；插件关闭后服务清理沿用现有生命周期门禁。

跨平台文件锁是已有 lease/写锁基础设施的适配。终端、后台命令管道与机器资源检测的 Windows 实现分别归 terminal、workflows、diagnostics，未堆入 Agent 内核。

## 从源码构建

需要目标系统、Node.js 24 和 Python 3.12+。PyInstaller 不能从 Mac 交叉生成 Windows Python 后端，因此 Windows 安装包必须在 Windows 构建；Intel Mac 与 Apple Silicon 也使用各自架构运行时。

```sh
npm --prefix webapp ci
npm --prefix desktop ci
node desktop/node_modules/electron/install.js
python -m pip install -r desktop/requirements-build.txt
npm --prefix webapp run build
python desktop/scripts/build_backend.py
python desktop/scripts/check_backend.py
python desktop/scripts/check_backend.py --force-exit
npm --prefix desktop test
# Mac：选择当前机器架构
npm --prefix desktop run dist:mac -- --arm64
# Intel Mac 使用 --x64
# Windows：
npm --prefix desktop run dist:win -- --x64
python desktop/scripts/check_app.py
python desktop/scripts/checksums.py
```

本机开发建议使用独立 Python 虚拟环境。构建产物在 `desktop/release/`，原生后端载荷在 `desktop/runtime/backend/`，均不提交到源码。后端分发包含 Python 许可证、PyInstaller bootloader 分发例外及适用依赖声明。安装包内置 IANA 时区数据，自动化计划不依赖 Windows 系统提供时区数据库；打包检查在关闭系统时区搜索路径后验证上海时区的定时计划。

`.github/workflows/desktop-build.yml` 提供手动触发的 Windows x64、Intel Mac x64 与 Apple Silicon arm64 构建、冻结后端真实检查、打包应用检查和校验和产物。源码上传和 CI 构建不自动创建 GitHub Release 或部署服务。

打包应用检查会使用隔离数据打开完整工作台，并启动真实的浏览器 worker 验证驱动与内置 Node；构建机器需要预装 Chrome/Edge。不会发送模型请求。

## 参考来源

审查 [DeepSeek Harness 官方桌面源码](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop)，其中 [运行时宿主](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/host-process.ts) 和 [原生目录选择](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/directory-picker.ts) 提供了独立进程、窗口所属对话框和复用插件运行时的设计参照。

Xueness 没有复制上游桌面源码、品牌或图标，也没有加入上游账户、遥测、强制更新或云分发。宿主边界遵循 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)，后端打包方式见 [PyInstaller 运行模式](https://pyinstaller.org/en/stable/operating-mode.html)。

## 客户端更新

左下角侧栏底部提供小型更新图标，点击打开更新设置。可下载或待安装时显示提示点，检查与下载时显示转动图标，失败时显示低干扰提示点；详细状态及错误只在更新设置中展开。入口和轮询仅在 updates 与 desktop 插件同时生效时启用，关闭后停止请求。

0.1.1 加入 updates 插件的应用内更新入口。稳定更新源固定为本仓库 GitHub Releases，支持自动检查、自动下载开关、手动下载及取消，安装前检查活动任务。Windows 安装版提供「重启并更新」；便携版不能原地更新。当前无签名 Mac 版本在客户端校验并下载对应架构 DMG，打开后仍需在 Finder 中替换。0.1.0 未内置更新器，首次迁移需要手动升级一次。完整行为和边界见[客户端更新说明](xueness-reliability-and-updates.md#桌面更新)。版本源码与客户端发布状态分别以仓库和 Releases 为准。
