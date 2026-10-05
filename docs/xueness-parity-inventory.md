# Xueness 能力对照清单（Capability Parity Inventory）

> **当前实现入口（2026-09-30）**：[设置、工作区与旧壳移除](xueness-settings-workspaces.md) 和 [插件架构说明](xueness-plugin-architecture.md)。下文引用的 vendor 路径与旧表数字为历史审查快照；旧机壳已移除，不再作为当前代码路径或完整对齐声明。

> 2026-10-05：四大核心能力（#21 记忆、#11 MCP、#22 浏览器、#18 子代理）对照 ZCode 开源版已完成回归审查与安全微补齐，详见 [审查报告](xueness-parity-audit-memory-mcp-browser-subagents.md) 与文末 §10。

> 2026-09-30：第十八批已补本轮四项与扩展界面，当前范围及限制见 [四项功能说明](xueness-four-workstreams.md)。

> 2026-09-29：本表是旧版本的 Web 能力快照，后续补齐情况见文末各批次与路线图，不能将旧行直接当成现状。产品主线已明确为自用 Agent CLI；上游 `29628c9a` 的新增差距及 CLI 验收维度另见 `zcode-upstream-2026-09-29.md`。此前「CLI 与 Web 全部拉平」仅是当批命令覆盖总结，不代表完整功能对齐。

日期：2026-09-28。范围：`vendor/zcode/packages/{ui,shared,services,rpc,provider,model-option-map,zcode-cua}`
（ZCode，Apache-2.0，固定在 `328c1a0c`）对 `xueness/`（后端）+ `webapp/src/`（原生界面）。

这份历史清单曾用来约束当批的功能对齐声明；当前验收应结合上面的最新复查和逐批证据：
没在这一类里给出 ZCode 证据、Xueness 证据和明确结论，就不能声称该类已对齐。

## 0. 怎么读

- **按用户可感知的功能归类，不按文件名罗列。** 一个类里往往横跨 ZCode 的十几个文件、
  Xueness 的若干文件与测试。
- **每一类三列**：ZCode 有什么（源码路径证据）/ Xueness 原生已有什么（文件+测试证据）/
  差距与是否需要。
- **路径前缀约定**（表中用简写，完整前缀在这里定义一次，均可直接拼出）：
  - `ui/…` = `vendor/zcode/packages/ui/src/…`
  - `shared/…` = `vendor/zcode/packages/shared/src/…`
  - `services/…` = `vendor/zcode/packages/services/src/…`
  - `provider/…` = `vendor/zcode/packages/provider/src/…`
  - `model-option-map/…` = `vendor/zcode/packages/model-option-map/src/…`
  - 原生文件直接给 `webapp/src/…`；后端给 `xueness/…`。
  - 抽查命令：把 `ui/` 等替换为上述前缀后 `test -e` 即得存在性（见 §6）。
- **计数口径**（一类只算一种）：
  - **已对齐**：原生界面里用户能完成同一件事，且有测试或真浏览器证据。
  - **缺失**：用户做不到，或缺关键部分。**部分覆盖一律计入缺失**，不按「差不多」放水。
  - **不适用**：该项在本项目形态下**不该也不需**实现，理由逐条写在第四节。
- 「harness 层已有」= 后端/Python 侧已实现该能力，但原生界面尚未暴露给用户；
  它把差距缩到「只剩 UI」，但**仍计缺失**。

## 1. 枚举口径（先对账，避免数字各说各话）

实测（`find`/`grep`，2026-09-28）：

| 包 | `.ts`/`.tsx` 文件数 |
|---|---|
| `packages/ui` | 1494 |
| `packages/services` | 329 |
| `packages/shared` | 226 |
| `packages/provider` | 23 |
| `packages/rpc` | 20 |
| `packages/zcode-cua` | 12 |
| `packages/model-option-map` | 8 |

`packages/ui/src` 下：`.tsx` **648** 个，其中 PascalCase（组件型）`.tsx` **462** 个；
全部 `.ts`/`.tsx` **1492** 个；顶层功能目录 **38** 个（`app-shell/` `settings/` `v4/`
`terminal/` `GitPane/` `workspace-file-tree/` `browser-use/` `shortcuts/` `i18n/` …）。

> **口径说明**：请求里说的「393 个组件」与本次实测（648 个 `.tsx`／462 个组件型）不一致。
> 本清单**以实测为准**，并把「按用户功能归类」作为主口径——数字差异不影响分类，
> 因为清单的粒度是能力类，不是文件数。如 393 是某一时点或某一子集的计数，请以本文件
> 的可复现命令为准。

原生侧：`webapp/src/` 原生（不含 `legacy/`）约 **6.7k 行** TS/TSX + **156 项** `node:test`；
后端 `xueness/` **23 个模块** + **697 项** Python 测试。

## 2. 对照总表（33 类）

| # | 能力类 | ZCode 有什么（证据） | Xueness 原生已有什么（证据） | 差距与是否需要 |
|---|---|---|---|---|
| 1 | 会话/任务管理（列表·新建·重命名·归档·置顶·删除·分组·搜索） | `ui/TaskList.tsx` `ui/TaskListItemContextMenu.tsx` `ui/TaskRenameDialog.tsx` `ui/DeleteAllArchivedTasksButton.tsx` `ui/workspace-grouped-tasks/` `ui/SortableWorkspaceSidebar.tsx` | `webapp/src/XuenessShell.tsx`(`Shell`+`SidebarNav`) `webapp/src/XuenessWorkbenchView.tsx`(`TaskList`) `webapp/src/xuenessWorkbench.ts`；后端 `xueness/web.py` sessions 建/列/详情 | **缺失**。只有「列表+选择」；重命名/归档/置顶/删除/分组/搜索均无对应后端端点与 UI。 |
| 2 | 会话时间线渲染（消息行·工具调用块·状态·markdown·代码评论） | `ui/v4/ConversationTimeline.tsx` `ui/v4/ConversationRowView.tsx` `ui/v4/ConversationTurnGroup.tsx` `ui/ToolCallBlocks.tsx` `ui/AssistantCodeCommentCards.tsx` | `webapp/src/XuenessTimeline.tsx`(`TimelineStream`) `webapp/src/XuenessShell.tsx`(`TimelineCard`+`SimpleMarkdown`)；后端 `xueness/events.py`(协议 v1)；测试 `xueness/../tests/test_events_v1.py`(33) `webapp/src/XuenessTimeline.test.tsx`(5) `webapp/src/XuenessShell.test.tsx`(8) | **已对齐**（形态不同、覆盖到事件级）。代码评论/富交互未做，属该类的边缘。 |
| 3 | 输入与提示编辑器（composer·@提及·斜杠命令·附件·富文本） | `ui/LexicalChatInput.tsx` `ui/prompt-editor/` `ui/mentions/` `ui/slashCommandPanelSections.tsx` | `webapp/src/XuenessWorkbenchView.tsx`(`Composer`)；后端 `xueness/commands.py`(斜杠展开，`tests/test_commands.py` 37) | **缺失**。仅有纯文本输入框；无 @提及、无斜杠面板 UI、无附件。 |
| 4 | 终端（交互式 shell · 侧栏终端） | `ui/terminal/` `ui/Terminal.tsx` `ui/SidePaneTerminalPane.tsx` `ui/app-shell/AnimatedTerminalPanel.tsx` | —（后端只有 `xueness/builtin_tools.py` 的一次性 `exec`，非交互终端） | **缺失**。需 PTY 会话 + UI，属高成本项。 |
| 5 | Git 面板（状态·分支·动作·提交图） | `ui/GitPane.tsx` `ui/GitPane/` `ui/git-graph/` `ui/git-action-menu/` `ui/git-branch-switcher/` | —（后端无 git 模块） | **缺失**。 |
| 6 | 文件改动与 Diff | `ui/GitPaneChangeCard.tsx` `ui/previewPanePatchFallbackContent.tsx` `shared/lineChangeStat.ts` | `webapp/src/XuenessWorkbenchView2.tsx`(`DiffView`) `webapp/src/xuenessWorkbench.ts`(journal 派生改动)；`webapp/src/XuenessWorkbenchView2.test.tsx`(13) | **缺失**。原生是**会话 journal 派生**的只读改动视图（代码内已明确标注「非工作树 diff」），与真 Git diff 不等价。 |
| 7 | 文件树与目录浏览（+文件搜索） | `ui/WorkspaceFileTree.tsx` `ui/workspace-file-tree/` `ui/DirectoryBrowser.tsx` `ui/workspace-file-search/` | `webapp/src/XuenessWorkbenchView2.tsx`(`FileBrowser`) `webapp/src/XuenessPanels.tsx`(`DirectoryBrowser`)；后端 `xueness/directory_api.py`；测试 `tests/test_resources.py`(29) | **已对齐**（文件搜索项缺席，属该类子项）。 |
| 8 | 内容预览（代码·图片·markdown·PDF·Office·媒体·白板·树图） | `ui/PreviewPane.tsx` `ui/previewPane{Code,Image,Markdown,Pdf,Pptx,Office*}` `ui/WhiteboardPane.tsx` `ui/TreemappingPane.tsx` | `webapp/src/XuenessWorkbenchView2.tsx`(`CodeBlock` 文本预览) | **缺失**。仅有纯文本/代码片段，无富预览。 |
| 9 | 审批与权限（逐动作审批·CUA/工作流权限） | `ui/PermissionDialog.tsx` `ui/SaveWorkflowPermissionBlock.tsx` `ui/WorkflowPermissionBlock.tsx` `ui/cua-permission/` | `webapp/src/XuenessWorkbenchView.tsx`(`Approvals`)；后端 Gate 逐 `tool_call_id` 审批；测试 `tests/test_mcp_gate_web.py`(10) `tests/test_approval_audit.py`(8) | **已对齐**（CUA/工作流专属权限随对应能力不存在而暂缺）。 |
| 10 | 设置 | `ui/SettingsPage.tsx` `ui/settings/` `ui/settings-sync/` | `webapp/src/XuenessPanels.tsx`(`SettingsSections`) `webapp/src/XuenessWorkbenchView2.tsx`(`SettingsPanel`)；后端 `xueness/settings_store.py`；测试 `tests/test_settings_store.py`(23) `webapp/src/xuenessSettings.test.ts`(14) | **已对齐**（分区数少于上游，结构同）。 |
| 11 | MCP 管理（服务器增删改·列表·状态） | `ui/settings/Mcp*` `shared/mcp.ts` `services/mcp-sync/` `services/official-mcp/` | 仅能力开关 `webapp/src/XuenessPanels.tsx`(`allowMcp`)；后端 `xueness/mcp.py`(stdio 客户端)+`tests/test_mcp*.py`(61) | **缺失**。harness 能连 MCP，但用户无法在界面里增删/查看 MCP 服务器。 |
| 12 | 供应商与模型配置 | `ui/ModelConfigSelect.tsx` `ui/settings/model-provider-section/` `provider/` `model-option-map/` | `webapp/src/XuenessPanels.tsx`(`ProvidersPanel`)；后端 `xueness/providers_api.py`；测试 `tests/test_providers_api.py`(20) | **已对齐**（本地单机范围；上游云账号/额度联动不适用，见 26）。 |
| 13 | 快捷键（绑定表·冲突检测） | `ui/shortcuts/` `ui/hooks/useAppKeyboard.ts` | `webapp/src/XuenessWorkbenchContainer.tsx`(仅 ⌘N/⌘K) | **缺失**。无绑定表/冲突/可配置。 |
| 14 | 国际化 i18n | `ui/i18n/`(`IntlProvider`+`LocaleSwitcher`+`locales`) | —（文案硬编码中文） | **缺失**。 |
| 15 | 用量与配额 | `ui/CodingPlanUsageRemainingPanel.tsx` `ui/WorkspaceSidebarFooterUsageSummary.tsx` `shared/usage-stats.ts` | `webapp/src/XuenessPanels.tsx`(`UsagePanel`)；后端 `xueness/usage_api.py`；测试 `tests/test_usage_api.py`(22) | **已对齐**（本地统计；上游订阅额度见 26）。 |
| 16 | 会话分享（导出/只读/导入） | `ui/ConversationShareMenu.tsx` `ui/v4/ConversationShare*` `services/conversation-share/` | — | **不适用**（依赖上游云端分享服务与账号）。见 §4.1。 |
| 17 | 自动化与工作流 | `ui/app-shell/WorkflowRun*` `shared/automation-types.ts` `shared/dynamic-workflow-feature.ts` | —（原生有 plan 模式与步数上限，非工作流引擎） | **缺失**。 |
| 18 | 子代理与 Agent 策略 | `ui/app-shell/Subagent*SidePane.tsx` `shared/subagents-types.ts` `shared/zcode-agent-policy.ts` | 后端 `xueness/subagents.py`+`xueness/task_registry.py`（`tests/test_subagents.py` 41） | **缺失**。harness 能跑子代理，界面无目录/进度/结果面板。 |
| 19 | Skills 与插件 | `ui/settings/InstalledPluginManagement.tsx` `services/skills/` `services/plugins/` `services/plugin-sync/` `shared/plugin-types.ts` | 后端 `xueness/skills.py` `xueness/plugins.py` `xueness/plugin_sdk.py`（`tests/test_plugin_sdk.py` 46 `tests/test_skills*.py` 24） | **缺失**。harness 有加载/授权，界面无 marketplace/安装/管理。 |
| 20 | Hooks | `shared/hooks.ts` `services/hooks/` `shared/workspace-hook-config.ts` | 后端 `xueness/hooks.py`（`tests/test_hooks.py` 61 `tests/test_hook_events_complete.py` 4） | **缺失**。harness 有 13 种事件，界面无查看/编辑。 |
| 21 | 记忆 | `ui/settings/MemorySettingsSection.tsx` `shared/memoryDiagnostics.ts` | `webapp/src/XuenessPanels.tsx`(`MemoryPanel`)；后端 `xueness/memory.py` `xueness/memory_api.py`（`tests/test_memory*.py` 21） | **已对齐**（只读展示；上游写入/诊断未做，属子项）。 |
| 22 | 浏览器与 CUA | `ui/browser-use/` `ui/EmbeddedBrowserPaneParts.tsx` `vendor/zcode/packages/zcode-cua/` | — | **不适用**（依赖 Electron 宿主与外部浏览器/CUA 授权链）。见 §4.2。 |
| 23 | 远程连接与 SSH | `ui/remote-connection/` `ui/SSHDialog.tsx` `services/remote-sync/` `shared/remote-sync.ts` | — | **不适用**（远程主机/隧道属桌面与云端场景）。见 §4.3。 |
| 24 | 更新与版本提示 | `ui/UpdateStatus*.tsx` `shared/update.ts` `shared/forceUpdate.ts` | — | **不适用**（自更新属桌面分发形态；本项目非分发式应用）。见 §4.4。 |
| 25 | 桌面窗口壳（窗口控件·菜单·托盘） | `ui/DesktopWindowFrame.tsx` `ui/DesktopWindowControls.tsx` `ui/WindowsTopLeftLogo.tsx` `shared/desktopMenu.ts` | — | **不适用**（Electron 桌面专属）。见 §4.5。 |
| 26 | 登录/账号体系 | `ui/login/LoginApiKeyForm.tsx` `services/oauth/` `provider/account-provider-service.ts` | —（密钥走服务端环境变量，无登录） | **不适用**（厂商账号/OAuth/额度体系）。见 §4.6。 |
| 27 | 引导 onboarding | `ui/onboarding/` | — | **缺失**（低优先；依赖账号/职业画像的上游引导不适用，但首启本地引导可做）。 |
| 28 | 遥测与反馈 | `ui/feedback/` `shared/telemetry.ts` `shared/telemetryRedaction.ts` | — | **不适用**（向厂商上报，本项目不采集）。见 §4.7。 |
| 29 | 命令面板/快速查找 | `ui/command-center/` `ui/quickpick/` | —（仅 ⌘K 聚焦一个输入框） | **缺失**。 |
| 30 | 资源与存储管理 | `ui/resource-manager/` `shared/processResourceTelemetry.ts` | — | **缺失**（本地磁盘/进程/存储用量面板）。 |
| 31 | 后台任务与子运行 | `shared/background-bash-jobs.ts` `shared/background-task-controls.ts` `ui/app-shell/BackgroundBashOutputSidePane.tsx` | 后端 `xueness/task_registry.py`（进度镜像+协作取消）；`exec` 工具 | **缺失**。harness 有后台任务与取消，界面无输出面板/状态。 |
| 32 | Bots/渠道集成 | `ui/BotsDialog.tsx` `services/bots/` `shared/bots.ts` | — | **不适用**（渠道集成依赖云端）。见 §4.8。 |
| 33 | 团队协作与广播 | `services/broadcast/` `shared/channels.ts` | — | **不适用**（多端同步/广播属云端）。见 §4.9。 |

## 3. 结论数字

- **共 33 类能力。**
- **已对齐 7**：#2 时间线渲染、#7 文件树与目录浏览、#9 审批与权限、#10 设置、
  #12 供应商与模型配置、#15 用量与配额、#21 记忆。
- **缺失 17**：#1 会话/任务管理、#3 输入编辑器、#4 终端、#5 Git 面板、#6 改动/Diff、
  #8 内容预览、#11 MCP 管理、#13 快捷键、#14 i18n、#17 工作流、#18 子代理、
  #19 Skills/插件、#20 Hooks、#27 引导、#29 命令面板、#30 资源管理、#31 后台任务。
- **不适用 9**：#16 分享、#22 浏览器/CUA、#23 远程/SSH、#24 更新、#25 桌面壳、
  #26 登录/账号、#28 遥测、#32 Bots、#33 协作广播。

即 **33 = 7 已对齐 + 17 缺失 + 9 不适用**。

> 判定「已对齐」的 7 类里，除 #2/#7/#9 有真浏览器证据外，#10/#12/#15/#21 的对齐依据是
> 「文件+测试」；它们离「与 ZCode 逐项一致」仍有子项差距（分区数、模型选项映射等），
> 已在表内注明。

## 4. 不适用类的理由（逐条）

凡标「不适用」都是**因为本项目形态根本不该有**，不是「懒得做」：

1. **#16 会话分享**：上游把会话上传到厂商云端生成只读链接/权限分级
   （`services/conversation-share/`、`shared/conversation-share.ts`）。Xueness 是
   loopback 单机服务、无账号、无上传入口，分享链路的**服务端在厂商侧**，无法自行实现。
2. **#22 浏览器与 CUA**：`ui/browser-use/` 与 `vendor/zcode/packages/zcode-cua/` 依赖
   Electron 宿主提供的嵌入浏览器视图与外部桌面自动化授权（`services/cua-permission-broker`）。
3. **#23 远程连接与 SSH**：管理**远程主机**上的工作区、经 SSH 隧道转发——属桌面客户端
   与云端编排场景；本项目是本地单机 web UI。
4. **#24 更新与版本提示**：应用自更新/强制升级是**桌面分发形态**的能力；本项目无安装器、
   无版本渠道。
5. **#25 桌面窗口壳**：窗口控件、系统菜单、托盘是 Electron 专属；浏览器标签页里不存在。
6. **#26 登录/账号体系**：OAuth 客户端、账号态、额度订阅全部指向厂商账号系统
   （`services/oauth/`、`provider/account-provider-*.ts`）。**且**商标条款明令：Xueness 与
   Z.AI/ZCode 无隶属关系（`NOTICE.md`）——接入其账号体系本身即越界。
7. **#28 遥测与反馈**：`shared/telemetryRedaction.ts` 表明其用途是**向厂商上报**；本项目不采集、
   不外发用户数据。
8. **#32 Bots/渠道**：机器人/渠道（微信、飞书等）接入依赖厂商云端网关。
9. **#33 团队协作与广播**：`services/broadcast/`、`shared/channels.ts` 是多端同步/广播，
   属云端多用户服务。

## 5. 缺失类的高价值优先序（建议，不在本轮实施）

按「用户可感知收益 ÷ 成本」粗排：

1. **#1 会话/任务管理补全**（重命名/归档/删除/搜索）——后端增量小，收益最直接。
2. **#6 真 Git diff + #5 Git 面板**——「改动」当前是 journal 派生，用户最容易误判。
3. **#8 内容预览**（图片/markdown/PDF 起步）。
4. **#4 终端**（成本最高，放后）。
5. **#11/#19/#20/#18 的界面化**——harness 已实现，只差 UI，属「低成本高杠杆」。

## 6. 证据来源（可复现命令）

```bash
# ZCode 侧
find vendor/zcode/packages/ui/src -type f -name '*.tsx' | wc -l          # 648
find vendor/zcode/packages/ui/src -type f -name '*.tsx' | xargs -n1 basename | grep -cE '^[A-Z]'  # 462
find vendor/zcode/packages/ui/src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l  # 1492

# 路径存在性抽查（把简写换成 §0 的前缀）
for p in TaskList.tsx v4/ConversationTimeline.tsx settings/McpServerList.tsx; do
  test -e "vendor/zcode/packages/ui/src/$p" && echo "OK $p" || echo "MISS $p"
done
test -e vendor/zcode/packages/shared/src/mcp.ts && echo OK
test -e vendor/zcode/packages/services/src/oauth && echo OK

# Xueness 侧
wc -l webapp/src/*.ts webapp/src/*.tsx                                   # 原生行数
python3 -m unittest discover -s tests -q                                 # 697 OK
cd webapp && npx npm run typecheck                                       # 0 错（只扫 src）
```

- Xueness 能力与测试证据见 `docs/xueness-ui-comparison.md`、`docs/xueness-harness-notes.md`、
  `docs/xueness-event-protocol-v1.md`。
- ZCode 许可证与来源见仓库根 `LICENSE`、`NOTICE.md`。

## 7. 本轮（2026-09-28 下午）进度：状态数字不变

本轮做了三件事（视觉基准+令牌、应用级外壳与时间线、高频交互），但按本清单
「**部分覆盖一律计入缺失**」的口径，**没有任何一类被完整判定为「已对齐」**：

- **#1 会话/任务管理**：新增 重命名 / 删除（归档式，不删工作区与审计）/ 历史刷新，
  列表项显示 `title`。**仍缺**：归档 UI、置顶、分组、独立搜索、重命名对话框。
  → 仍计**缺失**。
- **#3 输入编辑器**：composer 支持多行、粘贴、提交态、Esc 取消、`isComposing` 保护。
  **仍缺**：@提及、斜杠命令面板 UI、附件、富文本。→ 仍计**缺失**。
- **#13 快捷键**：新增 ⌘K（命令面板）/⌘N（新建）/Esc（关浮层）。
  **仍缺**：绑定表、冲突检测、可配置。→ 仍计**缺失**。
- **#29 命令面板**：新增最小命令面板（任务搜索 + 新建/刷新）。**仍缺**：分类命令、
  预览、fuzzy 排序。→ 仍计**缺失**。

因此结论数字维持 **33 = 已对齐 7 + 缺失 17 + 不适用 9**，未因本轮放水上调。
后端新增 `xueness/session_management.py`（`rename`/`archive`/`list_summaries`，
带 `management_history` 审计、符号链接拒绝、CSRF 与「运行中 409」校验）。

验收（本轮实跑，非「应该没问题」）：
- `cd webapp && npm run typecheck` → **0 错**
- `npx vite build` → 通过（vendor 惰性大分块警告，非错误）
- `bun test src/` → **160 pass / 0 fail**（`node --test` 不支持本项目 TS/TSX 导入，
  不能作为结论）
- `python3 -m unittest discover -s tests -q` → **706 OK**
- 真 Chrome：原生 `xn-shell` 1 个、⌘K 打开命令面板 1 个、Esc 关闭后 0 个。

## 8. 第九批（2026-09-28 晚）进度：结论数字不变，缺口实质收窄

本轮（harness 功能界面化 + 会话管理补全）之后，按「部分覆盖一律计入缺失」口径，
**33 = 已对齐 7 + 缺失 17 + 不适用 9 维持不变**，但以下类别的差距实质性收窄：

- **#1 会话/任务管理**：新增 置顶（侧栏「已置顶」分组 + 头部 📌 切换，审计进
  `management_history`）/ 归档列表 + 恢复（「已归档」折叠区，↩ 恢复）/ 真重命名对话框
  （替代 window.prompt）/ 侧栏过滤框。**仍缺**：分组、独立搜索页、置顶拖拽排序。→ 仍计**缺失**。
- **#11 MCP 管理 / #19 Skills·插件 / #20 Hooks / #18 子代理**：新「能力」视图
  （会话头部切换器进入）六分区列出 `/api/resources` 真实条目，每条目真启用开关
  （PATCH 合并 `enabled`，实测服务端落库）。**仍缺**：创建/编辑/删除 UI、
  MCP 连接测试、子代理运行记录视图。→ 仍计**缺失**（harness 层早已实现，本轮补的是第一层 UI）。
- **#8 内容预览**：图片类（png/jpg/jpeg/gif/webp，2MB 上限，围栏拒软链逃逸）在文件面板
  以 `<img>` 渲染。**仍缺**：markdown 渲染预览、PDF、音视频。→ 仍计**缺失**。

证据：`docs/xueness-ui-comparison.md` §八（含 `native-batch9-*.png` 四张实测截图）、
`docs/xueness-native-agent-roadmap.md` 第九批。验收：Python **767 OK**、前端 **181 pass**、
typecheck 0 错、`vite build` 通过、线上容器 healthy，全部实跑。

## 9. 第十批（2026-09-28 夜）进度：结论数字不变，四类差距继续收窄

按「部分覆盖一律计入缺失」口径，**33 = 已对齐 7 + 缺失 17 + 不适用 9 维持不变**：

- **#11/#19/#20/#18（MCP/Skills·插件/Hooks/子代理）**：能力面板从「读取+开关」补齐到
  **创建/编辑/删除全闭环**（ID 与后端同正则实时校验；编辑只 PATCH 变化键）。
  **仍缺**：MCP 连接测试、子代理运行记录视图、复杂字段的专用编辑器。
- **#6 改动/Diff 与 #5 Git 面板**：新 Git 视图给出**真·工作树 diff**（status/diff/log，
  只读卫兵有集成断言），终结「只有 journal 派生假 diff」的最易误判点。
  **仍缺**：staged vs unstaged 区分、单文件 diff、暂存交互（需审批层设计）。
- **#8 内容预览**：图片 + markdown + PDF + 音视频（分型大小上限）。**仍缺**：真实媒体
  文件实测、office 类。
- **#3 输入编辑器**：/ 斜杠命令建议 + @ 工作区文件建议（↑↓/Tab/Esc）。**仍缺**：附件、
  富文本、@ 更多上下文类型。
- **#29 命令面板**：命令/任务分类 + 子序列 fuzzy + 描述行。**仍缺**：fuzzy 复杂度、
  预览面板、自定义命令注册。
- **#1 会话管理**：按状态分组（进行中/已完成/其他，带计数）。**仍缺**：拖拽排序、
  工作区分组、独立搜索页。
- **#13 快捷键**：真实绑定表落进设置页。**仍缺**：冲突检测、自定义。
- **#4 终端**：**明确不做**（绕过逐动作审批门控，需独立威胁模型），从「缺失」改列
  「不追求」，理由见 `xueness-ui-comparison.md` §九。

证据：`xueness-ui-comparison.md` §九（`native-batch10-*.png`）；验收 Python **791 OK**、
前端 **217 pass**、typecheck 0 错、容器 healthy（内置 git 2.47.3）。

## 10. 2026-10-05 回归一致性复查：记忆、MCP、浏览器、子代理（四大核心插件）深度对齐

本轮对照 ZCode 开源版（`apps/zcode-cli/packages/core/src/`）对四大核心插件（#21 记忆、#11 MCP、#22 浏览器、#18 子代理）进行了完整回归审查与安全微补齐，详见 [四大核心能力回归一致性审查报告](xueness-parity-audit-memory-mcp-browser-subagents.md)。

本次在遵循 AGENTS.md 插件架构、不放松安全边界、不侵入内核的前提下，在对应插件内直接完成 4 项微补齐：

1. **#21 记忆（Memory）**：
   - 对齐 ZCode `stripTopLevelMarkdownHtmlComments` 与 `formatProjectMemoryIndexContent` 规范，在 `xueness/bundled_plugins/memory/memory.py` 的 `_strip_entry_head` 中补齐了 YAML frontmatter（`^---\s*\r?\n[\s\S]*?---\s*\r?\n?`，支持 LF 与 CRLF）和 HTML 注释（`<!-- ... -->`）的过滤清洗。
   - 保证带元数据或注释的 Markdown 记忆条目被安全载入，纯注释/空项自动丢弃，不污染模型上下文并不浪费上下文预算。
   - 对应测试：`tests/test_parity_memory.py`（6 项测试全部通过）。

2. **#11 MCP 管理（MCP）**：
   - 对齐 ZCode `toModelVisibleMcpNamePart` 命名规范，在 `xueness/bundled_plugins/mcp/mcp.py` 中引入 `sanitize_mcp_name_part`，将包含冒号 `:`、斜杠 `/`、空格等非字母数字字符规范化为下划线并保留合法下划线防止命名碰撞，并在 `McpPlugin` 中维护 `tool_name_map` 映射字典，派发工具调用时准确还原为 MCP 服务端原始工具名称；增强重连类型防卫。
   - 对齐 ZCode `formatContentBlock` 与 `formatMcpToolResult`，在 `_extract_text` 中支持 `type == "resource"` 内嵌文本提取与非文本元数据序列化，并在 `call_tool` 中支持结果附带的 `structuredContent` 自动 JSON 序列化并追加至返回文本。
   - 对应测试：`tests/test_parity_mcp.py`（5 项测试全部通过）。

3. **#18 子代理与 Agent 策略（Subagents）**：
   - 对齐 ZCode `createBuiltInGeneralPurposeAgentProfile` 与 `createBuiltInExploreAgentProfile`，在 `xueness/bundled_plugins/subagents/subagents.py` 的 `select()` 中加入内置 `general-purpose`（全工具可用）与 `explore`（只读代码检索工具）回退 Profile，用户自定义 Profile 具备最高优先级覆盖（支持大小写无缝命中），无需额外配置即可开箱即用派发标准子代理任务。
   - 对齐 ZCode `filterSubagentChildToolNames` 的 `disallowedTools` 机制，在 `provider_with_agent_tools` 及 `runner.py` 的 Gate 门禁中支持 `disallowedTools` / `disallowed_tools` 黑名单，支持参数剥离（`Bash(git *)` 等）及大小写/别名归一化，支持 PascalCase 工具白名单匹配，从模型 Provider 工具注入与运行时执行门禁两层严格拦截禁用工具。
   - 对应测试：`tests/test_parity_subagents.py`（8 项测试全部通过）。

4. **#22 浏览器与 CUA（Browser-Use）**：
   - 针对 Playwright 桥接脚本 `xueness/bundled_plugins/browser/bridge.mjs`，对 `browser_screenshot` 命令中写入文件的逻辑追加 `if (command.output)` 卫兵，消除未指定输出路径时的冗余截图动作与开销。
   - 明确 Xueness 与 ZCode 在浏览器自动化上的差异：Xueness 坚持基于语义选择器的 Web 审查与受限 HTTPS 导航（Gate 逐动作审批 + SSRF 防御），有意不做 ZCode 的低级像素拖拽/坐标点击（CUA），保持稳健性与安全性。
   - 对应测试：`tests/test_parity_browser.py`（5 项测试全部通过）。

### 自动化验证与门禁
- 架构完整性门禁：`python3 tools/check_plugin_architecture.py` 通过。
- 架构单测：`python3 -m unittest tests.test_plugin_architecture -q` 通过。
- 四大专项测试：`python3 -m unittest tests.test_parity_memory tests.test_parity_mcp tests.test_parity_subagents tests.test_parity_browser -q` (24 OK)。
- 四大领域既有测试回归：`python3 -m unittest tests.test_memory tests.test_mcp tests.test_subagents tests.test_browser -q` (206 OK, 7 skipped)。

