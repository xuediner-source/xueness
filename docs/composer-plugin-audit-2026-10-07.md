# 添加菜单与功能插件核查（2026-10-07）

本轮完成添加菜单能力、最近请求上下文圆环、完全访问确认，并复查全部功能归属。

## 插件归属

- 构建 allowlist、28 份后端 manifest 和 28 项前端注册一致。
- 160 个功能 ID 唯一，均有中文名称与英文名称。135 个后端模块引用、104 个前端模块/导出引用可解析。
- 完整已安装目录显示全部 28 个插件及 160 项子功能，包括禁用、依赖阻塞和无独立面板的插件。
- 添加菜单来自六个固定可信源码入口。数据清单不能加载代码；插件、依赖和工具执行均核对有效状态。
- 插件开关不代替 Gate、单项批准、系统权限、CSRF、Host/Origin 或工作区边界。
- 新功能继续按照 AGENTS.md / CONTRIBUTING.md 实现于已有或新增 bundled plugin，必须登记双语 features 并可在插件面板找到。

## 此次修复的真实问题

1. 目标弹窗和会话时间线的 sibling key 重复，保存后留下旧弹窗 DOM；改为独立 key。
2. 会话稳定化忽略目标、权限、模型和已修改文件等字段；改为全快照结构比较，兼容未来新增字段，同时保留等价轮询的对象身份。
3. 进入完全访问时旧权限菜单遮挡警告；进入前关闭菜单，取消后恢复触发按钮焦点。
4. 添加菜单、用量提示在窄窗口越界；限定盒模型/宽度，并在焦点或悬停时定位用量提示。无操作的提示不拦截按钮点击。
5. 前端可选九项能力但后端最多接受八项；在达到上限时说明原因、禁用新增选项、保留取消选择。
6. Office 成功写入未进入“已更改文件”；通过注册工具的路径与 write/edit 元数据统一发现，拒绝或失败不展示。
7. App-server 完全访问缺少确认参数传递；增加明确布尔 acknowledgeYolo，未确认仍返回 428 并保留会话与文件。

## 全量验证

| 检查 | 结果 |
| --- | --- |
| 后端全量 unittest discovery | 2256 项，2215 通过、41 项按环境/平台跳过；0 失败 |
| 前端全量 | 797 / 797 通过 |
| 桌面 Node 测试 | 83 / 83 通过 |
| 插件架构脚本与回归 | PASS；26 / 26 通过 |
| TypeScript / Vite / 设计与启动包预算 | PASS |
| 全套浏览器检查 | 插件展示、工作区/子代理生命周期、时间线/侧栏虚拟化、composer 交互通过 |
| 本轮真实构建浏览器检查 | 明暗主题 × 1280/420，添加/取消能力、八项上限、目标创建/替换、上下文来源与边界、权限确认/取消/焦点、28 插件/160 子功能展示 |
| Mac 应用包 | Electron 真实启动、28 个插件/160 项功能、隔离 renderer、内置 Node/Playwright 浏览器与正常退出通过 |
| 冻结后端 | 时区、认证 HTTP、真实 PTY、工作流进程、开关/依赖、正常关闭通过 |

使用隔离状态目录与合成数据，没有修改用户会话、模型、工作区或插件开关，没有请求收费模型。合成 2048/8192 的读数只用于界面与数据契约验证，不代表真实模型性能。Windows 原生安装/更新不在 Mac 上冒充验收。

Office 支持有界结构化创建与重建，无法保留任意富版式；不完整的读取不给覆盖证明。搜图使用真实图片服务接口，公网地址检查不代表已下载/核实图片内容。具体用法及边界见 [使用说明](xueness-composer-capabilities.md)。

## 本机安装

已将最终构建覆盖到 `/Applications/Xueness.app`，本地版本仍为 0.1.4，未对外发布。覆盖前保留完整旧包 `/Users/xuediner/code/Xueness.app.bak-20261007-114715-before-composer-capabilities`；核对 2058 个包内文件，并在安装位置完成隔离启动与内置浏览器检查。用户状态目录不参与覆盖。

## 全部功能清单

| 插件 | 功能 ID | 中文名称 | English name |
| --- | --- | --- | --- |
| sessions | sessions.conversation | 会话创建与 Agent 对话 | Sessions and agent conversations |
| sessions | sessions.plan_mode | 计划权限模式（只读并先出计划） | Plan permission mode (read-only, plan first) |
| sessions | sessions.management | 选择、搜索、重命名、固定与归档 | Select, search, rename, pin and archive |
| sessions | sessions.history | 会话历史预览、阅读位置记忆与跨会话上下文检索 | History previews, reading-position memory and session context search |
| sessions | sessions.fork | 闭合历史轮次分叉与来源链接 | Safe history forks and parent links |
| sessions | sessions.fork_from_checkpoint | 从轮次检查点派生新会话 | Fork a session from a turn checkpoint |
| sessions | sessions.portable | 脱敏导出、导入与恢复 | Redacted export, import and resume |
| sessions | sessions.streaming | 文本、思考与工具增量流、执行状态和中断提示 | Text, reasoning and tool streams, execution states and interruption notices |
| sessions | sessions.composer | 附件、上下文引用与会话输入 | Attachments, context mentions and input |
| sessions | sessions.message_queue | 运行期间排队发送后续消息 | Queue follow-up messages during a run |
| sessions | sessions.tui | 多行 CLI、全屏 TUI 与中断恢复 | Multiline CLI, fullscreen TUI and interruption |
| sessions | sessions.command_palette | 命令面板搜索与键盘导航 | Command palette search and keyboard navigation |
| sessions | sessions.timeline_follow | 时间线跟随与回到底部 | Timeline following and return to bottom |
| sessions | sessions.start_page | 空会话起始页快捷动作与最近会话 | Empty-session start page actions and recent sessions |
| sessions | sessions.manual_compact | 手动压缩上下文（/compact 与说明） | Manual context compaction (/compact with instructions) |
| sessions | sessions.tool_concurrency | 依赖感知的工具并发调度 | Dependency-aware tool concurrency |
| sessions | sessions.runtime_model_switch | 模型与推理档位切换（滑块与 /model、/effort） | Model and reasoning-level switching (slider, /model and /effort) |
| sessions | sessions.model_picker | 统一模型选择与详情卡 | Unified model picker and detail card |
| sessions | sessions.events_cursor | 会话事件增量游标拉取（实验，默认关闭） | Incremental session event cursor polling (experimental, off by default) |
| sessions | sessions.answer_question_experimental | 通过界面答复会话问题（实验，默认关闭） | Answer session questions in the UI (experimental, off by default) |
| sessions | sessions.question_answer_ui | 会话问题答复界面 | Session question answer UI |
| sessions | sessions.composer_capabilities | 添加菜单与插件能力上下文 | Add menu and plugin capability context |
| sessions | sessions.usage_guide | Xueness 使用与配置诊断指南 | Xueness usage and configuration guide |
| sessions | sessions.context_usage_ring | 当前请求上下文用量圆环与来源说明 | Current-request context usage ring and provenance |
| sessions | sessions.yolo_confirmation | 完全访问权限确认 | Full access permission confirmation |
| files | files.read | 文件列表、搜索与分页读取 | File listing, search and paged reading |
| files | files.mutations | 批准后的文件写入与编辑 | Approved file writes and edits |
| files | files.directory | 目录浏览、新建与本机目录选择 | Directory browsing, creation and host folder selection |
| files | files.preview | 文本、图像、PDF 与媒体预览 | Text, image, PDF and media previews |
| files | files.changes | 会话文件改动、逐行差异与上下文折叠 | Session file changes, line diffs and folded context |
| files | files.instructions | 工作区 AGENTS 指导文件加载 | Workspace AGENTS instruction loading |
| shell | shell.exec | 批准后的 argv 命令执行 | Approved argv command execution |
| planning | planning.todos | 待办计划读取与更新 | Read and update task plans |
| planning | planning.questions | 提问、用户回答与继续 | Questions, user answers and continuation |
| planning | planning.delivery | 交付清单与内容完整性检查 | Delivery checklist and content completeness checks |
| planning | planning.session_goal | 会话目标设置、每轮注入与完成核验 | Session goals with per-request reminders and completion checks |
| planning | planning.goal_editor | 添加菜单会话目标创建与显式替换 | Add-menu goal creation and explicit replacement |
| providers | providers.termination | 生成结束原因与截断安全暂停 | Generation termination and safe truncation pause |
| providers | providers.budget_feedback | 实际用量校准与缓存容量计入 | Measured budget calibration including cached context |
| providers | providers.checkpoints | 用户要求保留与可追溯历史摘要 | Preserved human requirements and traceable history checkpoints |
| providers | providers.profiles | 模型配置保存、选择与切换 | Save, select and switch model profiles |
| providers | providers.protocols | OpenAI 兼容与 Anthropic 协议 | OpenAI-compatible and Anthropic protocols |
| providers | providers.default_selection | 默认模型与推理档位保存 | Saved default model and reasoning level |
| providers | providers.discovery | 显式模型发现 | Explicit model discovery |
| providers | providers.lightweight | 本地小模型轻量档位 | Lightweight profile for local small models |
| providers | providers.lightweight_layout | 轻量档极简工作台布局 | Lightweight minimal workbench layout |
| providers | providers.lightweight_compact_timeline | 轻量紧凑时间线与极简输入状态 | Lightweight compact timeline and minimal input status |
| providers | providers.budgets | 上下文、输出与安全预算 | Context, output and safety budgets |
| providers | providers.tools | 精简工具、按需发现与结果分页 | Minimal tools, discovery and result paging |
| providers | providers.json | JSON 工具协议与有限修复 | JSON tool protocol and bounded repair |
| providers | providers.transport | 兼容参数、超时与有限重试 | Compatibility, deadlines and bounded retries |
| providers | providers.compatibility_checks | 本地接口对话、工具与流式兼容诊断 | Local endpoint conversation, tool and streaming diagnostics |
| providers | providers.activity | 输出阶段、延迟、计数与速率趋势 | Output phase, latency, counts and rate trends |
| providers | providers.custom_empty | 自定义模型空状态 | Custom model empty state |
| memory | memory.injection | 只读记忆轨道与上下文注入 | Read-only memory tracks and context injection |
| memory | memory.editor | 手动编辑与版本冲突检测 | Manual editing and version conflict checks |
| memory | memory.settings | 记忆能力与工作区配置 | Memory capability and workspace settings |
| settings | settings.workspace | 工作区登记、项目选择与默认目录 | Workspace registration, project selection and default folder |
| settings | settings.appearance | 主题、语言、字体与代码显示 | Theme, language, fonts and code appearance |
| settings | settings.shortcuts | 快捷键配置、验证与冲突检测 | Shortcut configuration, validation and conflicts |
| settings | settings.agent | Agent 运行与能力偏好 | Agent runtime and capability preferences |
| settings | settings.destination_search | 设置项搜索 | Search settings destinations |
| usage | usage.usage | 会话、步骤与日期统计 | Session, step and daily statistics |
| usage | usage.tokens | 供应商实际报告的 Token 统计 | Provider-reported token statistics |
| usage | usage.costs | 实际报告成本与模型维度统计 | Reported costs and per-model statistics |
| usage | usage.quick_card | 工作台用量速览卡片 | Workbench usage quick card |
| git | git.inspect | 状态、差异、日志与分支查看 | Status, diffs, logs and branches |
| git | git.clone | 克隆远程仓库到已授权目录 | Clone a remote repository into an authorized directory |
| git | git.actions | 批准后的暂存、提交、分支与 stash | Approved stage, commit, branch and stash |
| git | git.checkpoint | 检查点、恢复预览与恢复前备份 | Checkpoints, restore review and recovery backups |
| git | git.turn_checkpoints | 轮次首个写入前自动检查点 | Automatic checkpoints before a turn's first change |
| git | git.rewind | 回退工作区到轮次检查点 | Rewind the workspace to a turn checkpoint |
| workflows | workflows.engine | DAG、声明式 DSL 与模型编排 | DAG, declarative DSL and model orchestration |
| workflows | workflows.actors | 只读及已批准可写 actor 与问答 | Read-only and approved writable actors and questions |
| workflows | workflows.resume | 持久恢复、结果复用与文件校验 | Persistent resume, result reuse and file checks |
| workflows | workflows.concurrency | 动态并发、限流退避与跨运行调度 | Adaptive concurrency, rate backoff and scheduling |
| workflows | workflows.background | 后台命令、日志、状态与取消 | Background commands, logs, status and cancellation |
| workflows | workflows.expert | 专家工作流（调研、计划、实现、审查） | Expert workflow (research, plan, implement, review) |
| workflows | workflows.dynamic_runs | 按会话列出、取消与恢复动态工作流运行 | Per-session dynamic workflow run listing, cancellation and resume |
| terminal | terminal.pty | 工作区 POSIX PTY / Windows ConPTY 交互式终端 | Interactive workspace POSIX PTY / Windows ConPTY |
| terminal | terminal.lifecycle | 终端尺寸、日志、关闭与服务清理 | Terminal sizing, logs, closing and cleanup |
| terminal | terminal.preferences | 默认 Shell 与终端偏好 | Default shell and terminal preferences |
| office | office.docx | DOCX 页面与嵌入图片预览 | DOCX pages and embedded images |
| office | office.pptx | PPTX 幻灯片、图片与缓存图表 | PPTX slides, images and cached charts |
| office | office.xlsx | XLSX 工作表与缓存单元格值 | XLSX worksheets and cached cell values |
| office | office.pdf_authoring | PDF 创建、读取与结构化替换 | PDF creation, reading and structured replacement |
| office | office.pptx_authoring | PPTX 创建、读取与结构化替换 | PPTX creation, reading and structured replacement |
| office | office.xlsx_authoring | XLSX 创建、读取与结构化替换 | XLSX creation, reading and structured replacement |
| office | office.docx_authoring | DOCX 创建、读取与结构化替换 | DOCX creation, reading and structured replacement |
| commands | commands.templates | 自定义斜杠提示模板 | Custom slash prompt templates |
| commands | commands.init | 内建 /init：调研工作区并生成或更新 AGENTS.md | Built-in /init: study the workspace and create or update AGENTS.md |
| commands | commands.resources | 命令资源创建、编辑与开关 | Command resource creation, editing and switches |
| commands | commands.file_commands | 目录型 Markdown 命令发现与位置参数展开 | File-shaped Markdown commands with positional argument expansion |
| commands | commands.cli | commands list/inspect 命令与聊天 /commands | commands list/inspect commands and in-chat /commands |
| skills | skills.catalog | 技能资源与按需目录摘要 | Skill resources and on-demand catalog |
| skills | skills.read | 有界技能正文读取 | Bounded skill body reading |
| skills | skills.file_skills | 目录型技能发现与来源覆盖 | Directory-shaped skill discovery and source shadowing |
| skills | skills.cli | skills list/inspect 命令与聊天 /skills | skills list/inspect commands and in-chat /skills |
| skills | skills.skill_creator | 技能创建与 SKILL.md 校验 | Skill creation and SKILL.md validation |
| hooks | hooks.lifecycle | 明确启用的生命周期事件钩子 | Explicitly enabled lifecycle hooks |
| hooks | hooks.approval | 钩子命令审批与运行记录 | Hook command approval and run records |
| hooks | hooks.tool_events | 工具执行事件管线接入 | Tool event pipeline integration |
| hooks | hooks.workspace_trust | 工作区钩子发现与按摘要信任 | Workspace hook discovery and digest trust |
| mcp | mcp.transports | stdio、HTTP 与旧 SSE 连接 | stdio, HTTP and legacy SSE connections |
| mcp | mcp.oauth | OAuth PKCE、凭据刷新与隔离 | OAuth PKCE, refresh and credential isolation |
| mcp | mcp.tools | 外部工具、资源与提示词 | External tools, resources and prompts |
| mcp | mcp.recovery | 连接诊断、失效恢复与设置 | Connection diagnostics, recovery and settings |
| mcp | mcp.elicitation | 结构化询问 | Structured elicitation |
| subagents | subagents.tasks | 只读子任务与嵌套代理 | Read-only subtasks and nested agents |
| subagents | subagents.progress | 子任务进度、结果与取消 | Subtask progress, results and cancellation |
| subagents | subagents.cancel_one | 单个子任务协作取消 | Cooperative cancellation for one subtask |
| subagents | subagents.parallel_coordination | 后台并发派发、主代理持续工作与结果收集 | Background delegation, parent progress and result collection |
| subagents | subagents.settings | 子代理资源与能力配置 | Subagent resources and capability settings |
| subagents | subagents.sidepane | Web 端子代理运行态侧栏 | Web subagent runtime sidepane |
| network | network.fetch | 受限公网 HTTPS 页面读取 | Restricted public HTTPS fetching |
| network | network.search | 显式配置的网页搜索 | Explicitly configured web search |
| network | network.search_model | 独立 OpenAI 兼容搜索模型 | Independent OpenAI-compatible search model |
| network | network.search_settings | 搜索服务地址与密钥配置 | Search service endpoint and key settings |
| network | network.dns_diagnostics | 按需诊断 DNS 与搜索服务 | On-demand DNS and search service diagnostics |
| network | network.fakeip_doh | FakeIP 环境的显式 DoH 解析 | Explicit DoH resolution in FakeIP environments |
| network | network.image_search | 有界公网图片搜索与来源链接 | Bounded public image search and source links |
| automation | automation.schedules | 五字段 cron、时区与下次执行 | Five-field cron, time zones and next run |
| automation | automation.approval | 计划审批与无人值守触发 | Schedule approval and unattended triggers |
| automation | automation.history | 持久认领、运行历史与暂停 | Persistent claims, run history and pause |
| automation | automation.off_peak | 闲时队列：本地低峰窗口排队执行、仅在空闲时与完成通知 | Off-peak queue: local idle-window runs, idle-only tasks and completion notices |
| extensions | extensions.marketplace | 可信资源清单市场浏览 | Trusted resource manifest marketplace |
| extensions | extensions.management | 数据 manifest 安装、升级与移除 | Data manifest install, upgrade and removal |
| extensions | extensions.validate_update | 插件市场清单只读校验与原子升级 | Read-only manifest validation and atomic upgrades |
| extensions | extensions.plugin_profiles | 插件组合 profile 档位 | Plugin composition profiles |
| extensions | extensions.plugin_creator | 插件创建与非执行清单校验 | Plugin creation and non-executing manifest validation |
| diagnostics | diagnostics.export | 脱敏支持诊断导出 | Redacted support diagnostic export |
| diagnostics | diagnostics.storage | 状态存储统计与限定日志清理 | State storage statistics and scoped log cleanup |
| diagnostics | diagnostics.runtime | 实时本机 CPU、内存与磁盘采样 | Live host CPU, memory and disk sampling |
| browser | browser.pages | 受审批约束的页面导航与检查 | Approved page navigation and inspection |
| browser | browser.actions | 精确点击、输入与内存截图 | Exact click, fill and in-memory screenshots |
| browser | browser.settings | 浏览器控制配置与生命周期清理 | Browser control settings and lifecycle cleanup |
| browser | browser.desktop_import | 桌面 Chrome 资料选择、确认导入与持久浏览器环境检测 | Desktop Chrome profile selection, confirmed import and persistent browser runtime detection |
| browser | browser.snapshot | 页面无障碍树快照 | Page accessibility tree snapshot |
| browser | browser.composer_operation | 添加菜单浏览器操作工作流 | Add-menu browser operation workflow |
| remote | remote.app_server | stdio JSON-RPC app-server 入口 | Stdio JSON-RPC app-server entry point |
| remote | remote.connections | 命名 SSH 主机连接配置 | Named SSH host connection settings |
| remote | remote.exec | 明确批准的远程 argv 执行 | Explicitly approved remote argv execution |
| bots | bots.inbox | Telegram 白名单收件箱 | Allowlisted Telegram inbox |
| bots | bots.reply | 明确批准的消息回复 | Explicitly approved message replies |
| onboarding | onboarding.wizard | 模型与工作区初次配置向导 | Initial model and workspace setup wizard |
| onboarding | onboarding.credentials | 隐藏密钥输入与配置保存 | Hidden key input and configuration saving |
| onboarding | onboarding.desktop_permissions | 首次启动三步系统权限引导与可跳过的进度保存 | First-launch three-step system permission guide with optional progress saving |
| updates | updates.check | 源仓库版本与更新检查 | Source repository version and update checks |
| updates | updates.apply | 明确批准的干净仓库快进更新 | Approved clean-repository fast-forward update |
| updates | updates.desktop | 客户端更新检查、下载与重启安装 | Desktop update checks, downloads and restart installation |
| desktop | desktop.application | Windows / macOS 独立桌面应用与内置运行时 | Windows / macOS application with bundled runtime |
| desktop | desktop.folder_picker | 窗口所属的原生项目文件夹选择 | Window-owned native project folder selection |
| desktop | desktop.lifecycle | 单实例、启动恢复与后台进程清理 | Single instance, startup recovery and backend cleanup |
| desktop | desktop.status | 关于页面的应用版本与数据位置 | Application version and data location in About |
| desktop | desktop.window_chrome | 原生窗口控件与沉浸式工作台标题栏 | Native window controls and integrated workbench title bar |
| desktop | desktop.background | Windows 系统托盘与关闭窗口后后台运行 | Windows system tray and background operation after closing the window |
| desktop | desktop.tray_navigation | Windows 托盘会话分组、快速打开、新建与反馈入口 | Windows tray chat groups, quick navigation, new chat and feedback |
| desktop | desktop.permissions | 系统权限真实状态与受限原生授权入口 | Actual system permission status and fixed native authorization actions |
| tools | tools.dry_run_experimental | 工具调用干跑预览（实验，默认关闭） | Tool call dry-run preview (experimental, off by default) |
| tools | tools.call_budget_experimental | 单轮工具调用预算（实验，默认关闭） | Per-turn tool call budget (experimental, off by default) |
