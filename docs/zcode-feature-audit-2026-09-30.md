# ZCode 源码复查与原生工作台美化（第十九批）

> 后续状态：第二十批已进行插件拆分与缺口补齐。下文是第十九批审查时的快照，不代表最新实现；当前能力、验收与剩余范围见 [插件架构说明](xueness-plugin-architecture.md)。

日期：2026-09-30。目的：重新确认功能遗漏，并改善现有原生 Web 工作台。审查不是宣称全面对齐，也不把旧版清单中的“缺失”直接沿用为当前状态。

## 上游基线与方法

重新查询 GitHub `zai-org/ZCode` 的提交记录，并下载当前 HEAD 到临时目录，只读检查源码。当前公开 HEAD 仍为 **29628c9acdb81b703bbd4080c207a0e7ce5e276e**，提交时间 **2026-09-24 06:49:06 UTC**，标题 `feat: update v3.14.3`。没有发现比上次复查更新的公开提交。

来源：[固定提交](https://github.com/zai-org/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e)、[CLI 与 Agent 包](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages)、[Web UI](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src)、[服务层](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src)。保留已有 vendor 基线，没有运行上游安装脚本或覆盖本地未提交改动。

下表上游路径相对该固定提交：`cli/` = `apps/zcode-cli/packages/`；`ui/` = `packages/ui/src/`；`services/` = `packages/services/src/`。Xueness 路径相对项目根目录。结论按功能子项记录；“可用”指现有范围可使用，不能推导为该类全部对齐。检查了源码与现有测试，未逐一运行上游所有功能。

## 四项工作的真实边界

1. **CLI 会话与模型切换可用**：`operator_cli.py`、`provider_config.py`、`session_lease.py` 支持选择/管理会话、保存模型、切换当前会话与单写入者保护。但交互仍为行式 REPL，尚非上游全屏 TUI。
2. **工具与长任务有可用基础**：后台命令、真实 PTY、子任务进度/取消、按需技能读取及 HTTP MCP 已接入。模型请求仍整包响应，没有逐 token 输出；MCP 没有 OAuth 与连接池恢复。
3. **工作流引擎可用但范围较窄**：持久 DAG、命令/只读 Agent 节点、失联恢复、已完成结果复用、手动动态并发已完成。缺模型直接创建/修订工作流、脚本 DSL、可写 Agent actor、升级问答、基于限流的自适应并发、运行间公平调度。
4. **辅助 Web 与扩展界面可用**：配置/工作流/后台命令/MCP/子任务/PTY/Office 内容/媒体/中英文均有入口。Office 是结构化文字/表格预览，没有上游 DOCX 页面排版与 PPTX 完整渲染；Web 国际化不等于 CLI 国际化。

详细验收与命令见 [四项功能说明](xueness-four-workstreams.md)。

## 需要继续补齐的具体项

| 优先级 | 漏项 / 部分覆盖 | ZCode 实现证据 | Xueness 当前证据与差距 |
|---|---|---|---|
| P1 | 模型增量输出与请求恢复 | [runner-stream.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-stream.ts#L310)、同目录 `streaming-tool-call-assembler.ts`、`retry-policy.ts`、`stream-retry-boundary.ts` | `provider.py:complete` 读取完整 JSON；`events.py` / Web SSE / CLI stream-json 是步骤事件流，不是模型 token 流。没有通用限流退避、流中断恢复、原生 Anthropic 适配。 |
| P1 | 模型原生工作流编排 | [create-workflow.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/tools/create-workflow.ts)、[amend-workflow.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/tools/amend-workflow.ts)、`cli/contracts/src/tools/workflow.ts` | `workflows.py` / `workflow_cli.py` / `operations_api.py` 是操作员提供 JSON DAG；没有对应模型工具，也不解释上游 `agent()/parallel()/pipeline()/phase()` 脚本。 |
| P1 | 工作流 actor 写入、问答与复用语义 | [workflow-actor-tools.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-tools.ts)、`cli/dynamic-workflow/src/engine/imported-cache.ts` | `workflows.py` Agent 节点只读；命令可以写入但不等价于 Agent actor。复用仅匹配节点规格和依赖、同 root，不校验外部文件变化；没有 actor 转录/世界读取缓存与升级问题机制。 |
| P1 | 自适应并发 | [workflow-concurrency-governor.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/app/workflow-concurrency-governor.ts#L42) | `workflows.py` 并发可在 1..8 手动调整，降限不杀活动节点；没有按 provider/model 分桶的 AIMD、Retry-After 冷却和运行间轮转。不能称为已完整对齐动态并发。 |
| P1 | CLI 全屏交互与多模态输入 | `cli/cli/src/tui-command.ts`、`cli/tui/src/app-model-streaming.ts`、`cli/cli/src/clipboard-image.ts`、`cli/cli/src/prompt-command.ts` | `cli.py` 有行式聊天/审批/选择；`cli_input.py` 限 UTF-8 文本附件。没有 TUI 布局、图像粘贴与 image/video/pdf 模型附件。Web 能预览媒体不代表模型能理解媒体。 |
| P1 | Agent 原生后台执行与网页工具 | `cli/contracts/src/tools/bash.ts`、[websearch.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/tools/websearch.ts)、`cli/core/src/tool/handlers/webfetch.ts` | `builtin_tools.py` 的模型 `exec` 仍同步等待，超时 30 秒；操作员 jobs/workflow 不等价于模型能启动/查询/终止后台命令。也没有原生 WebSearch/WebFetch；可配置 MCP 提供外部工具，但不是内建实现。 |
| P2 | 历史会话上下文检索 | [read-session-context.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/tools/read-session-context.ts) | `core.py` 有历史压缩与 durable journal，CLI/Web 可读取记录；缺模型可调用的、有范围约束的相关片段检索/交接摘要工具。读取当前工作区文件不等于专用跨会话检索。 |
| P2 | MCP 授权与连接生命周期 | [mcp/index.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/mcp/index.ts)、同目录 `oauth*.ts`、`pool.ts` | `mcp.py` / `mcp_http.py` / `diagnostics.py` 支持 stdio、HTTP JSON/SSE 响应、环境认证映射和诊断；没有 OAuth 授权刷新、旧 SSE transport、连接池失效重连、resource/prompt 接口。 |
| P2 | Git 操作与 checkpoint | [gitService.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/git/gitService.ts#L301)、`services/git/gitCheckpointService.ts` | `git_api.py` / `XuenessGitView.tsx` 仅 status/diff/log；没有专用提交、分支切换、stash、checkpoint/还原 UI。通过批准 exec 运行 git 不等于已有对应产品流程。 |
| P2 | Office 排版与富预览 | [previewPaneOfficeDocxContent.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/previewPaneOfficeDocxContent.tsx#L121)、`ui/previewPaneOfficeXlsxContent.tsx`、`ui/previewPanePptxContent.tsx` | `office_preview.py` / `XuenessWorkbenchView2.tsx` 显示 DOCX 段落/表格、XLSX 缓存值、PPTX 文本；没有完整页面/样式/图片/图表/动画、旧 .doc 转换、白板或树图。 |
| P2 | 本地自动化 | [automationService.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/automationService.ts)、`services/session/automationCron.ts` | 现有工作流需要显式开始；没有定时调度、时区、下次运行、自动化历史管理。后台 jobs 不等于 cron。 |
| P2 | 设置、用量与可移植会话 | `ui/shortcuts/bindings.ts` / `conflicts.ts`、`ui/ConversationShareMenu.tsx`、`services/conversation-share/conversationShareService.ts` | 快捷键只读；没有自定义绑定/冲突检测、主题与编辑器完整设置。`usage_api.py` 统计运行/步骤，不提供准确模型 token/成本。没有本地安全导出/导入；云分享可不复刻，但本地可移植性不能据此算“不适用”。 |
| 后续插件化 | marketplace 与能力拆分 | [plugins-command.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/plugins-command.ts#L44)、`services/plugins/` | `plugin_sdk.py` 已有本地 manifest/授权/安装计划与卸载，`plugins.py` 已有接缝；没有完整 marketplace 浏览/下载/升级 UI，也还未把原生全部能力拆成用户预期的 harness 插件。遵循先功能、后拆分的顺序。 |

## 原有 33 类能力重新过账

| # | 能力 | 当前实现与证据 | 仍有差距 / 范围判断 |
|---|---|---|---|
| 1 | 会话管理 | `session_management.py`、`operator_cli.py`、`XuenessWorkbenchContainer.tsx` | 列表/选择/重命名/归档/恢复/置顶/搜索已有；未覆盖上游全部拖拽排序与多工作区管理。上游 `ui/TaskList.tsx`。 |
| 2 | 时间线 | `events.py`、`XuenessTimeline.tsx` | 消息/工具/步骤可用；代码评论卡片、丰富行交互与模型增量流部分缺失。上游 `ui/v4/ConversationTimeline.tsx`。 |
| 3 | 输入编辑 | `cli_input.py`、`XuenessWorkbenchView.tsx`、`commands.py` | 文本、命令与上下文选择可用；Lexical 富编辑器、多模态附件部分缺失。上游 `ui/LexicalChatInput.tsx`。 |
| 4 | 终端 | `terminals.py`、`terminal_worker.py`、`TerminalPanel` | 真实 PTY 可用；仅 POSIX，服务器重启不恢复；终端 profile/多分屏不齐。上游 `services/terminal/`。 |
| 5 | Git 面板 | `git_api.py`、`XuenessGitView.tsx` | 查看可用；写操作、图形历史与 checkpoint 缺失。上游 `services/git/`。 |
| 6 | Diff | `git_api.py`、`XuenessWorkbenchView2.tsx` | 真工作树 diff 与 journal 改动均有；逐 hunk 暂存/还原与高级 diff 交互缺失。上游 `ui/GitPane/`。 |
| 7 | 文件树与搜索 | `directory_api.py`、`FileBrowser` | 目录浏览和文件上下文选择可用；没有上游完整递归文件搜索/编辑流程。上游 `ui/workspace-file-search/`。 |
| 8 | 富预览 | `core.py` 文件预览、`office_preview.py`、`FileBrowser` | 文本/图像/PDF/浏览器媒体/Office 内容已有；Office 排版/白板/树图仍缺。上游 `ui/PreviewPane.tsx`。 |
| 9 | 审批 | `core.py:Gate`、`Approvals`、工作流 approve | 逐调用批准/拒绝、计划审批可用；上游 CUA 等专用权限未有同等实现。上游 `ui/PermissionDialog.tsx`。 |
| 10 | 设置 | `settings_store.py`、`SettingsSections` | 分区与现有实际能力可用；不是上游全部设置项。上游 `ui/settings/`。 |
| 11 | MCP | `mcp.py`、`mcp_http.py`、能力编辑与诊断 | CRUD/连接诊断可用；OAuth/旧 SSE/resource/prompt/连接池部分缺失。上游 `cli/adapters/src/mcp/`。 |
| 12 | 模型配置 | `providers_api.py`、`provider_config.py`、`ModelManager` | 保存/编辑/选择可用；模型能力映射、推理选项、多个协议适配部分缺失。上游 `packages/provider/src/`。 |
| 13 | 快捷键 | `SettingsSections`、Container 键盘处理 | 当前绑定已列出；自定义/冲突检测缺失。上游 `ui/shortcuts/`。 |
| 14 | 国际化 | `i18n.ts`、原生界面调用 | Web 中英切换与持久化可用；CLI/后台错误/上游全部语种未覆盖。上游 `ui/i18n/`。 |
| 15 | 用量 | `usage_api.py`、`UsagePanel` | 本地步骤/运行统计已有；准确 token/成本缺失，厂商订阅额度建议不复刻。上游 `services/usage-stats/`。 |
| 16 | 分享/导出导入 | 目前无专用实现 | 云服务建议不复刻；本地导出/导入仍可补，不能整类排除。上游 `services/conversation-share/`。 |
| 17 | 工作流/自动化 | `workflows.py`、`WorkflowPanel` | DAG 功能可用；动态脚本/模型工具/自适应调度/cron 缺失，详见上表。上游 `cli/dynamic-workflow/`。 |
| 18 | 子代理 | `subagents.py`、`task_registry.py`、WorkflowPanel 子任务 | 启用/配置/进度/取消已有；没有完整多 actor 交接、升级问答与专用转录面板。上游 `ui/app-shell/` Subagent 面板。 |
| 19 | Skills/插件 | `skills.py`、`plugins.py`、`plugin_sdk.py`、能力页 | 目录/按需读取/本地管理已有；marketplace 生命周期与全部 harness 插件化待做。上游 `services/plugins/`、`cli/cli/src/plugins-command.ts`。 |
| 20 | Hooks | `hooks.py`、`XuenessCapabilityDialog.tsx` | 事件执行与资源编辑已有；不保证与上游全部事件/信任作用域语义一致。上游 `services/hooks/`。 |
| 21 | 记忆 | `memory.py`、`memory_api.py`、`MemoryPanel` | 注入、压缩、只读轨道信息已有；专用编辑/修复/诊断流程缺失。上游 `ui/settings/MemorySettingsSection.tsx`。 |
| 22 | 浏览器/CUA | 无原生 Agent 工具 | 尚缺；上游也有 CLI browser-use，不能仅因无 Electron 宣称整类不适用。自用 CLI 是否纳入可在后续插件范围决定。上游 `cli/cli/src/run.ts`、`packages/zcode-cua/`。 |
| 23 | 远程/SSH | 无连接管理 | 尚缺；自用本地形态当前不阻塞，未来可作为插件。上游 `ui/remote-connection/`。 |
| 24 | 自动更新 | 无分发更新器 | Electron 更新器建议不复刻；CLI 版本/升级流程仍可独立设计。上游 `ui/UpdateStatus*.tsx`。 |
| 25 | 桌面壳 | 浏览器工作台 | 窗口/托盘原生桌面功能属于不同形态。上游 `ui/DesktopWindowFrame.tsx`。 |
| 26 | 厂商账号 | 自定义密钥配置 | Z.AI 账号/组织/商业配额建议不复刻；不要与通用 MCP OAuth 缺失混淆。上游 `services/oauth/`。 |
| 27 | 引导 | README 与空状态 | 新手本地配置向导缺失。上游 `ui/onboarding/`。 |
| 28 | 遥测/反馈 | 日志/测试与固定错误 | 厂商遥测建议不复刻；本地诊断包/反馈导出尚缺。上游 `ui/feedback/`。 |
| 29 | 命令面板 | Container 命令面板、`xuenessFuzzy.ts` | 任务/命令查找已有；覆盖面小于上游 quickpick。上游 `ui/command-center/`。 |
| 30 | 资源/存储 | 有输出/附件上限，无管理面板 | CPU/内存/存储明细和清理 UI 缺失。上游 `ui/resource-manager/`。 |
| 31 | 后台任务 | jobs/workflow、`task_registry.py`、WorkflowPanel | 创建/日志/暂停/取消/恢复可用；Agent 原生后台 Bash 工具与整套子运行交互尚未同等覆盖。上游 `shared/background-bash-jobs.ts`。 |
| 32 | Bots/渠道 | 无渠道接入 | 不是纯云专属，当前自用 CLI 未实现；是否加入插件后续决定。上游 `services/bots/`。 |
| 33 | 团队协作 | 本地单用户存储与锁 | 跨端广播/共享会话未实现；商业团队服务建议不复刻。上游 `services/broadcast/`。 |

不使用“已对齐百分比”：每一类仍可能包含重要未实现子项。旧清单的“7/17/9”只是 9 月 28 日历史计数，已不能表示当前状态；“仅有纯文本预览”“没有交互终端”“没有工作流”也已过时。

## 本轮界面实现

- 工作流：图标标题、工作区上下文卡片、计划/后台命令创建卡片、运行状态徽标、节点指标与进度条、可展开完整计划、状态对应的操作按钮、紧凑并发控件、可横向滚动的节点表格与按需日志。修订按钮展开原计划编辑器；活动运行不能被当作复用来源。
- 模型：可用配置卡片和编辑表单分栏，字段中文/英文标签、密钥状态、明确保存/选择反馈、清空表单、保存期间防止重复提交；空密钥继续保留原值，保存后清空密码输入。
- 终端：状态工具栏、就绪空状态、统一暗色终端与操作按钮、自适应高度、底部快捷提示，保留真实 PTY 输入/调整/关闭/重连。
- 通用：二级页面直接切换视图；侧栏工作流/模型入口采用一致 SVG 图标与可访问名称；新文案跟随语言切换；390px 窄屏用单栏并约束表格内部滚动。

实现：[XuenessOperations.tsx](../webapp/src/XuenessOperations.tsx)、[operations.css](../webapp/src/styles/operations.css)、[XuenessWorkbenchContainer.tsx](../webapp/src/XuenessWorkbenchContainer.tsx)、[i18n.ts](../webapp/src/i18n.ts)、[icons.tsx](../webapp/src/ui/icons.tsx)。

## 验证

本轮仅改原生前端与文档，Python 服务逻辑未修改。前端 219 项测试、TypeScript 类型检查、Vite 构建通过；构建仍提示既有 legacy 大 chunk。

浏览器在一次性工作区实测：完整计划审批 → 执行 → 运行/完成状态按钮 → 并发从计划的 3 读取并改为 5 → 节点日志；以此修订自动展开编辑器、创建时复用已完成节点并重置审批；模型保存/选择、保存后清空密钥输入；真实 PTY 输入/关闭且输出不覆盖页脚；二级视图切换；中英切换；390px 页面无整体横向溢出，移动侧栏可正常展开/收起。另回归语言重载持久化、技能编辑保留正文与 MCP 默认工作区，0 页面错误。两个 golden 协议校验与 `git diff --check` 通过。

实际查看过截图：[工作流中文](screenshots/batch19-workflows-zh.png)、[模型配置](screenshots/batch19-models.png)、[终端](screenshots/batch19-terminal.png)、[移动工作流](screenshots/batch19-workflows-mobile.png)、[移动模型](screenshots/batch19-models-mobile.png)。修复浏览器实测发现的终端 FitAddon padding 溢出和移动侧栏关闭按钮被抽屉遮挡。

Python 全量 867 项是第十八批既有验收，本轮未重跑；本轮浏览器使用当前后端真实 API，不调用付费模型，不部署现有容器。

后续建议先补模型流式请求与恢复、Agent 后台执行及网页工具，再补模型工作流工具/可写 actor/自适应并发，随后补 MCP OAuth、Git 操作和 Office 排版。全部功能边界明确后再推进 harness 插件拆分。
