# Xueness 桌面端

子代理的启用、并发派发、主代理继续工作及合理暂停条件见[子代理协作说明](xueness-subagent-coordination.md)。该能力属于 `subagents` 插件；安装包需要包含对应版本的后端与 Web 构建，源码变更不会自动改写已安装客户端。

桌面端使用独立实现的 Electron 外壳，复用 Xueness 工作台与插件运行时。安装包内置平台原生的 Python 后端和预构建 Web 资产，用户不需要安装 Python、Node.js 或开发依赖。

## 平台与产物

- Windows 10/11 x64：NSIS 安装程序（可选安装目录、开始菜单/桌面快捷方式、系统卸载入口），以及完整便携 ZIP。便携版解压整个目录后运行 `Xueness.exe`。
- macOS Apple Silicon：arm64 DMG 与应用 ZIP。
- macOS Intel：x64 DMG 与应用 ZIP。两个 Mac 版本分别构建，不能混用内置后端架构。

打开 DMG 后将 Xueness 拖到 Applications。当前构建没有开发者证书签名或 Apple 公证，首次运行需按系统安全提示批准；Windows 也可能显示未验证发布者。构建不关闭系统安全设置。

首次启动在模型设置中填写自己的模型连接，可选择本地轻量档位。Git、SSH、ffmpeg 等外部工具仍按所用插件安装。浏览器插件内置 Playwright 驱动，并复用 Electron 的 Node 运行时；无需另装 Node/Playwright。浏览器自动化使用已安装的 Chrome/Edge，Windows 自动检测常见安装路径；也可通过 `XUENESS_BROWSER_EXECUTABLE` 指定 Chromium 浏览器。“内置运行时”不表示打包了每种外部开发工具。

浏览器配置统一从「设置 → 浏览器」进入，开始界面不显示浏览器设置或启用按钮；新任务沿用设置中的默认开关，已有会话可在输入框工具栏调整本次任务的浏览器开关。浏览器设置显示实际环境检测结果；开关紧邻标题。桌面端可以选择并确认导入本机 Chrome 资料，复制到独立、跨启动保留的目录。导入要求浏览器与桌面插件启用，并先退出 Chrome；加密登录状态可能需要重新登录。使用与数据范围见[桌面浏览器资料](xueness-browser-profiles.md)。

## 数据与升级

会话工具栏独占一行，不遮挡交付检查或消息。运行结束记录显示静态结果；工具证据未通过验证与模型 JSON 工具协议错误分别提示，不表示仍在运行。轻量会话的本机资源面板默认收起，点击标题可展开/收起；展开后开始采样，收起、页面隐藏或禁用所属插件时停止采样并取消未完成请求。面板上的运行阶段来自会话数据，资源采样不会启动模型。

默认使用 Electron 的 Xueness 用户数据目录：Mac 在 `~/Library/Application Support/Xueness`，Windows 在 `%APPDATA%/Xueness`。会话与模型配置在其中的 `state/`，运行工作区在 `runs/`，默认项目在 `workspace/`。更新应用文件不会删除这些数据，Windows 卸载也保留应用数据。

可在启动前用 `XUENESS_DESKTOP_DATA` 指向独立数据目录。CLI 如需与桌面共享数据，使用 `python -m xueness --state /absolute/path/to/Xueness/state ...`。本项目原有 `.state` 不会被自动复制或更改，也不会打进安装包。

## 插件归属与进程生命周期

桌面集成属于第 27 个 `desktop` 插件，插件面板可看到原生目录选择、桌面状态及宿主相关能力。窗口、私有后端通道和插件恢复入口作为运行宿主基础设施保持可访问；禁用 desktop 后原生选择和桌面状态 API 停止工作，其它插件按各自开关运行。settings/sessions 的工作区授权和开关仍优先。

主进程创建随机 loopback 端口及独立宿主凭据。凭据通过进程环境传入后立即从后端环境移除，渲染进程没有 Node.js 或任意 Electron IPC 权限。目录选择通过私有父子进程通道交给窗口所属的系统对话框，只有系统返回的目录经后端校验后进入授权范围。

Windows 窗口按钮区使用工作台标题栏的背景与文字颜色，跟随浅色、深色及系统主题切换。隔离 preload 仅读取主题 CSS token 并发送固定颜色消息，不向页面暴露 Electron API；主进程校验窗口、主 frame、私有后端 origin 和颜色格式，窗口关闭后移除监听。窗口配色属于 `desktop.window_chrome` 的宿主恢复基础设施，关闭业务插件后仍与工作台保持一致。

应用单实例运行，重复打开聚焦现有窗口。Windows 的 desktop 插件生效时提供系统托盘：关闭窗口隐藏工作台，后端与任务继续运行；点击托盘或再次打开快捷方式恢复窗口，托盘菜单「退出 Xueness」才结束应用。也可用 `Xueness.exe --quit` 请求现有实例正常退出。desktop 关闭或系统托盘不可用时，关闭窗口仍正常退出；其它平台保持原有关闭行为。明确退出应用会停止后端与所属子进程，Windows 通过 Job Object 保证宿主结束时清理继承任务。POSIX 工作流跟踪宿主所属 worker，并在父进程丢失后取消命令；同一状态目录中由 CLI 启动的 worker 不属于桌面清理范围。POSIX 终端保持真实 PTY，Windows 使用真实 ConPTY 和固定 PowerShell/CMD 配置；插件关闭后服务清理沿用现有生命周期门禁。

Windows 托盘右键菜单显示「运行中」「已固定」「最近」会话，左侧标题、右侧工作区名称；各组最多显示三个条目，其余记录在「更多」中打开。每次展开从本机后端读取最多 100 条最新会话，不持久复制用户标题或项目路径。点击会话恢复窗口并打开该记录；「新建会话」复用工作台入口；「发送反馈」打开项目的 GitHub issue 选择页，由用户填写和提交。菜单跟随中英文及浅深色设置，支持方向键、Home/End 和 Escape，失去焦点后收起。工作台执行任务时只能打开当前会话，切换与新建沿用现有忙碌限制；sessions 关闭时不读取列表，desktop 关闭时销毁托盘菜单及其请求。菜单页为独立 Vite 构建入口，仅暴露固定命令 IPC；后端凭据只在 Electron 主进程使用。加载菜单失败时降级到原生「打开/退出」菜单。

工作区切换保持可点击，目录、文件与 Git 信息在后台刷新；下一次选择取消旧请求，旧响应不能覆盖当前目录。发送任务仍等待新目录的信息加载完成，超时提供重试入口。Git 只读命令不继承桌面宿主的控制管道，避免 Windows Git 启动器等待输入而阻塞工作区信息读取。

品牌图标保留原来的量子 X 造型，统一为黑底、白色实线与中性灰概率点。矢量源在 `webapp/public/xueness-icon.svg`，PNG/ICO 由 `node tools/build_brand_assets.mjs [包含 node_modules/sharp 的目录]` 生成；Sharp 只用于生成资产，不属于应用运行时。Windows 托盘使用包含 16–256px 的 ICO。

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

左下角侧栏底部仅在已确认有新版本时显示更新图标和红点，点击打开更新设置。下载、待安装和安装过程中保留入口；已确认新版的下载失败或取消也保留入口，方便重试。尚未发现新版、正在首次检查、检查失败或已是最新版本时隐藏。隐藏入口不会停止后台状态轮询，仍可从「设置 → 应用更新」手动检查；入口和轮询仅在 updates 与 desktop 插件同时生效时启用，关闭后停止请求。

应用版本和数据位置移至「设置 → 扩展与维护 → 关于 Xueness」，也可搜索“关于”进入。原来的独立「桌面端」设置页已移除；数据位置按当前运行实例读取，不改变或迁移会话、模型配置和插件设置。信息页仍归 `desktop.status`，更新入口归 `updates.desktop`，关闭所属插件后隐藏并停止请求。

2026-10-06 界面整理已通过 714 项前端测试、类型检查、构建与插件结构门禁（含 26 项架构回归）。真实 production Web 构建在隔离数据目录验证了中英文、浅深色、1280px/420px 布局、真实数据位置、隐藏入口继续轮询、新版各阶段红点和插件关闭后停止请求。更新状态使用测试响应，不下载或安装更新；此验证不代表桌面安装包已重新发布。

0.1.1 加入 updates 插件的应用内更新入口。稳定更新源固定为本仓库 GitHub Releases，支持自动检查、自动下载开关、手动下载及取消，安装前检查活动任务。Windows 安装版提供「重启并更新」；便携版不能原地更新。当前无签名 Mac 版本在客户端校验并下载对应架构 DMG，打开后仍需在 Finder 中替换。0.1.0 未内置更新器，首次迁移需要手动升级一次。完整行为和边界见[客户端更新说明](xueness-reliability-and-updates.md#桌面更新)。版本源码与客户端发布状态分别以仓库和 Releases 为准。

## 0.1.4 更新下载修复

Mac 更新下载使用 Electron `net.request`，在每次重定向事件中同步核验 HTTPS、端口与固定 GitHub 主机白名单后才继续。下载保留系统代理、流式写入、取消、文件大小限制与 SHA-256 检查；禁止目标不会收到请求。此前 0.1.2/0.1.3 使用 `net.fetch` 的手动重定向，可能显示 `Redirect was cancelled`。已受此问题影响的旧 Mac 客户端需要替换一次应用，修复随后随 0.1.4 客户端提供。应用替换保留数据目录。

源码构建还需运行 `node desktop/scripts/check_electron_update_transport.cjs`，该检查启动真实 Electron，在隔离 loopback 服务中验证重定向下载、取消与禁止跳转目标；不请求模型或读取用户状态。完整公网下载的验证结果记录在发布说明中，loopback 回归不等于公网更新验证。

Windows 更新页显示实际传输字节、下载速度和预计剩余时间，缺失测量时明确保持未知。GitHub 线路影响下载速度，不能保证各地网络相同；这些指标不表示安装器已经运行。原生 Windows CI 另运行 `node desktop/scripts/check_windows_github_download.cjs`，通过真正的 NSIS 网络执行器下载公开稳定版并完成内置 SHA-512 校验，使用隔离旧版本与缓存且不执行安装器；安装、重启和数据保留由独立 loopback NSIS 验证负责。

起始页没有历史记录时仅显示快捷操作；最近项目和会话有实际记录后才显示，单组铺满、双组并排并在窄屏堆叠。
