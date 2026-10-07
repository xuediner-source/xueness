# Mac / Windows 桌面统一记录

原生 Windows 中断回归发现，普通 Ctrl+C 字节和 ConPTY 键盘协议事件均不能恢复运行中 PowerShell 的提示符。terminal 插件改为固定的隔离控制台辅助进程：只附加该终端拥有的活动 Shell 控制台，发送真正的 CTRL_C_EVENT；宿主不附加控制台、不接收该信号，也不终止整个交互式 Shell 来替代中断。普通输入继续传递，关闭和输入串行化。测试使用与 xterm Enter 一致的 CR，并检查中断后可以继续输入、资源关闭完成。依据为 [Microsoft GenerateConsoleCtrlEvent](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent) 和 [AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole)；原生结果以本轮实际 CI 为准。

Windows 原生 CI 在冻结后端检查中发现 ConPTY 输出正常但关闭返回 400。本轮在 terminal 插件内串行化关闭与资源释放：pywinpty 原生关闭失败时，只对该终端拥有的 PID 使用系统终止进程树，再检查是否退出；失败继续报告错误，重复关闭不重复处理资源。终端真实 Shell、尺寸和中断回归已加入三平台构建门禁，原生冻结检查仍验证关闭，不放宽通过条件。对上游 API 的参考为 [pywinpty 3.0.2 关闭实现](https://github.com/andfoy/pywinpty/blob/v3.0.2/winpty/ptyprocess.py)。该修复扩展已有终端生命周期，功能目录数量不变。

2026-10-07 工作规则补强：当前目录 **28 个插件、163 项功能**，共享版本 **0.1.5**。planning 的标准／轻量规则同时进入 Windows x64、Mac Intel 和 Mac Apple Silicon 的原生构建；两个 CI 流程均纳入实际请求和插件开关回归。用户已授权本轮完成后上传 GitHub；下面“未上传”表述属于此前各阶段状态。原生构建与发布结果以本轮最终检查和 GitHub 记录为准。

2026-10-07 后续补强已同步两端构建链路：当前目录为 **28 个插件、162 项功能**，版本保持 **0.1.5**。压缩后的子任务与技能恢复实现由同一可信插件源码提供，Windows x64／Mac x64／Mac arm64 构建矩阵均执行新增连续性回归，独立 Windows 运行时门禁也覆盖它们；固定 Office 依赖、原生冻结、精确插件目录、打包 UI 与 Windows 默认开启的更新演练保持统一。Mac 本机构建、Windows 原生构建及本轮未上传的边界见[本轮补强说明](context-continuity-2026-10-07.md)。下方版本和统计为先前桌面统一阶段的记录。

本轮统一工作台功能、导航、主题、快捷键和维护入口，使用同一前端构建与插件目录。保留系统窗口按钮、权限、终端、进程清理和安装机制的必要差异。没有提交、推送或发布 GitHub 安装包。

## 已实现

| 范围 | 统一结果 | 归属 |
|---|---|---|
| 标题栏 | 相同的品牌、前进/后退、帮助、终端与侧栏操作；40px 高度，Mac 左侧交通灯/Windows 右侧窗口按钮分别留安全空间；键盘焦点可见 | desktop.window_chrome |
| 主题 | Windows 窗口按钮颜色及两端原生窗口背景随工作台切换，Mac 保留系统交通灯 | desktop.window_chrome |
| 原生语言 | 中英文菜单、目录选择和宿主错误随当前界面语言更新；只接受当前窗口、主帧、私有回环 origin 的 zh/en 消息 | desktop.window_chrome / desktop.folder_picker |
| 后台入口 | Windows 托盘右键和 Mac Dock「任务与项目」共用会话菜单、新建、分组、反馈与退出；不增加后台轮询 | desktop.background / desktop.tray_navigation |
| 快捷键 | 显示、录制和现有分发统一平台判定，识别浏览器 MacIntel/Win32 与原生 darwin/win32；Mac ⌘，Windows Ctrl | settings.shortcuts 及原有动作插件 |
| 默认 Shell | 从实际发现的列表选择，不再在 Windows 的加载/空配置状态假定 /bin/sh；保留用户已保存的选择 | terminal.preferences |
| 更新说明 | 根据宿主 installMode 说明 DMG/Finder 替换、重启安装或不支持原地安装；未取得状态时不猜测 | updates.desktop |
| 权限入口 | 关于页按「当前系统支持的权限」描述，Windows 仍仅提供实际可查询的麦克风权限 | desktop.permissions / onboarding.desktop_permissions |

原生词典 `desktop/src/native-labels.cjs` 纳入 desktop manifest 的 `desktopModules`；没有新增共享例外或可执行资源入口。沿用既有功能 ID，完整目录仍为 **28 个插件、160 项功能**。

## 生命周期与边界

- Windows 关闭窗口进入托盘后台；Mac 关闭最后一个窗口保留应用与后端，点击 Dock 恢复安全工作台窗口。
- Mac 窗口关闭时销毁其自定义 Dock 菜单与弹窗；恢复窗口并同步插件状态后重新建立。明确退出清理所属后端和进程。
- desktop 禁用时移除托盘/Dock 入口、销毁任务弹窗、取消列表请求。sessions 禁用时不读取会话，不允许新建或切换；任务运行中只允许打开当前会话。
- 窗口主题及原生应用菜单是恢复宿主基础设施，禁用产品插件后仍能使用其它插件与恢复入口。原生目录选择与系统权限操作继续受所属插件与既有授权边界限制。
- Windows rich popup 同步语言时只更新备用菜单，避免同时自动弹出原生菜单。Mac 启用或重新启用时复用之前发布的受限状态。

## 验证

- 前端全套 **804/804**，类型检查、production 构建、设计与体积门禁通过。
- Electron 桌面全套 **94/94**，覆盖可信 IPC、菜单语言、Mac Dock 与 Windows 托盘的开关、窗口关闭、状态复用和退出清理。
- 架构脚本通过；架构与桌面 Python 相关回归 **40 项通过，其中 3 项平台条件跳过**。架构的 26 项必检包含在其中。
- 冻结后端完成真实认证 HTTP、PTY、工作流、插件禁用、时区和退出检查。
- `node webapp/verify-desktop-parity.mjs` 验证 **8 个 production 布局**：Mac/Windows 浏览器平台响应，亮/暗色，1280px/760px，标题栏安全区、快捷键实际触发、设置和正确更新文案；零页面错误、外网/模型请求。Windows 浏览器平台由测试模拟，不代表 Windows 原生验收。
- `desktop/scripts/check_app.py` 已增加真实宿主留白、背景颜色、原生菜单及 Mac Dock 菜单断言，随两端原生构建门禁运行。

本轮没有改变 Python 业务行为，2256 项后端全套已在前一轮最终核查通过，本轮按桌面变更运行原生全套及上述相关/冻结回归。

## 构建限制

两端版本、GitHub 更新源和资源清单一致。Windows NSIS/ConPTY、Mac Intel 与 Apple Silicon 后端仍需在对应系统/架构构建；Mac 无法生成或实测 Windows 原生后端。现有 CI 使用 Windows x64、Mac x64、Mac arm64 原生矩阵并执行打包应用检查。当前无签名 Mac 更新仍需 Finder 替换，不能宣称两端自动安装机制相同。

界面证据保存在系统临时目录 `xueness-desktop-parity-20261007/`，各布局截图和 verification.json 明确注明 Windows 原生未验收。本轮已重新打包并覆盖 `/Applications/Xueness.app`，版本保持 0.1.4；安装前后 2058 个文件/链接逐项核对。已安装应用通过隔离启动、原生留白与主题、双语菜单、真实 Dock 任务弹窗和内置浏览器运行时检查。


本机完整旧版备份：`/Users/xuediner/code/Xueness.app.bak-20261007-141931-before-desktop-parity`。用户数据、会话、模型和插件开关未迁移或改写。Windows 新安装包尚未构建/发布，现有 GitHub Release 不会因本地覆盖而改变。
