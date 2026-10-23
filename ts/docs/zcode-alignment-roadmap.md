# 完全对齐 ZCode 路线图（只用 TS，2026-10-18）

> 本文保留早期迁移和界面工作的历史记录。2026-10-24 的当前基线为 ZCode 3.16.2 源码快照，完整引擎后续任务见 [15阶段82轮清单](../../docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.md)。下文24轮完成不表示最新ZCode全部能力已对齐；动态工作流已有基础实现，仍需按新清单深化。

**目标**：Xueness 只保留 TS 架构（`ts/` 后端、`webapp/`、`desktop/`），把 ZCode v3.15.1（`aac4755`，Apache-2.0）的前后端功能逐项做成 Xueness 插件，最后删除 Python。

本文是计划，不代表已经实现。每完成一步，在 [HANDOVER](../HANDOVER.md) 新增一节，并更新下面第 1 节的状态。

路径约定：`core/` 指 ZCode 的 `apps/zcode-cli/packages/core/src/`，`pkgs/` 指 `apps/zcode-cli/packages/`；ZCode 前端在仓库根目录的 `packages/`。

## 1. 进度总览

| # | 步骤 | 状态 | 粗估 |
| --- | --- | --- | --- |
| A | 完成判定（Python + TS，HANDOVER 第 8 节） | 已完成 | — |
| B | 代理循环（只改 TS，HANDOVER 第 9 节） | 已完成 | — |
| 1 | 权限与批准流（HANDOVER 第 11 节） | 已完成（2026-10-19） | 1 轮 |
| 2 | 提示词、上下文与插话（HANDOVER 第 12 节） | 已完成（2026-10-19） | 1 轮 |
| 3 | 补齐核心工具（HANDOVER 第 13、14 节） | 已完成（2026-10-19） | 3 轮 |
| 4 | 上下文压缩（HANDOVER 第 15 节） | 已完成（2026-10-19） | 1 轮 |
| 5 | 扩展能力迁到 TS（HANDOVER 第 16–20 节） | 已完成（2026-10-19） | 5 轮 |
| 6 | 文档与浏览器插件（HANDOVER 第 21–23 节） | 已完成（2026-10-19） | 3 轮 |
| 7 | 退役 Python，收尾前端（HANDOVER 第 24–33 节） | 已完成（第 1–10 轮，2026-10-21） | 10 轮 |
| 可选 | 动态工作流 / 平台插件 | 待决定 | 约 2 轮 / 不建议 |

主线合计约 24 轮，只是粗估：第 1–6 步实际用了 14 轮，第 7 步重新估为 10 轮；24 轮全部完成。1 轮约等于 B 项的工作量：实现、ZCode 用例、`npm run check`、文档和打包。

## 2. 共同规则

- **Python 冻结**：不再修改 `xueness/`。TS 缺原生能力时仍经 `ts/apps/server/src/python-feature-bridge.ts` 回退；某一步完成后才取消对应的回退（HANDOVER 第 5 节）。
- **直接移植 ZCode**：照搬对应模块的行为和提示词，按 Xueness 插件清单接入 `ts/plugins/*`，共用逻辑放在 `ts/packages/*`。来源记入 [`NOTICE.md`](../../NOTICE.md)，去掉 ZCode/Z.AI 品牌、账号和遥测。
- **门禁**：每步 `npm run check` 全部通过（`.ts` 文件 400 行上限、插件门禁、类型检查、测试）。
- **测试**：仍与 Python 一致的行为，继续跑 Python 对照差分测试；按 ZCode 有意改变的行为，改写成 ZCode 用例（参照 `packages/agent/test/zcode-loop.test.ts`），并注明 ZCode 源文件。
- **界面同步**：每步涉及的 webapp/desktop 界面在同一步完成，第 7 步只做收尾。
- **交付**：每步交付 patch（相对上一个完整包）和完整 zip，并重新生成 `complete-project-manifest.json`。

## 3. 主线步骤

### 第 1 步：权限与批准流（已完成，2026-10-19）

- **ZCode 来源**：`core/permission/`（`broker.ts`、`service.ts`、`rule-matching.ts`、`plan-mode-policy.ts`）；`core/tool/handlers/` 的 `bash-command-permission-policy.ts`、`bash-command-rule-evaluator.ts`、`bash-readonly-policy-*`；`core/tool/executor/turn-control.ts`。
- **现状**：需要批准的工具调用会挂起整轮，批准后再续跑（第 9 节留下的差异）。`ts/packages/permissions` 已有策略和只读判断。
- **要做**：
  - 批准在进程内等待：工具调用原地挂起，用户作答后同一轮继续；用户停止时取消等待。
  - 拒绝作为普通工具结果交给模型，本轮继续；只有拒绝退出计划模式才结束本轮。
  - 权限模式（含 yolo 直通、计划模式只读直通）、规则匹配、工具自报的 `alwaysAsk`。
  - bash 只读命令免批，按 ZCode 的 argv 解析规则判断。
- **完成标准**：批准后不新开轮次；拒绝后模型收到拒绝结果并继续；只读命令不弹批准；新增 ZCode 权限用例。第 10 轮后安装包和 Docker 镜像不再含 Python；这里只跑了 TS、Web、CLI 和桌面宿主的测试，安装包、镜像和 CI 没有实际构建。
- **界面**：批准卡片在运行中直接回传决定，不再“批准后重新发起”。
- **状态**：已完成，详见 HANDOVER 第 11 节。剩余差异：「始终允许」持久化规则、服务端读取规则设置、工具自报 alwaysAsk、计划模式下服务端放行只读 exec（随第 3 步的 `exit_plan_mode`）。

### 第 2 步：提示词、上下文与插话（已完成，2026-10-19）

- **ZCode 来源**：`core/context/`（`builder.ts`、`dynamic-sections.ts`、`sections/`）；`core/system-reminder/`（`incoming-message.ts`、`prompt-attachment.ts`、`source.ts`）；`core/session-context/`；各工具的模型说明（`core/tool/model-contract.ts` 和各 handler）。
- **现状**：系统提示和工具说明是 Xueness 自己的文本（`ts/packages/sessions/src/system-prompt.ts`）。TS 已有沿用 Python 规则的 steering，但没有 system-reminder。
- **要做**：
  - 按 ZCode 分段构建系统提示：身份、环境、日期、桌面、记忆、技能、用户请求上下文等（对应 `sections/`）。
  - system-reminder：插话、附件等按 ZCode 的格式附在请求上；运行中发送的消息在两步之间排入当前轮。
  - 会话上下文引用（`session-context/`，含 read-session-context 工具）。
  - 工具说明改用 ZCode 文本（是否用原文见第 7 节）。
  - 如有需要，参照 `packages/model-option-map` 补齐模型上下文窗口和输出上限，供第 4 步使用。
- **完成标准**：系统提示各段与 ZCode 对应；插话出现在下一次模型请求里；新增用例。
- **界面**：运行中可以发送插话，并显示已排入。
- **状态**：已完成，详见 HANDOVER 第 12 节。剩余差异：工具改名与 ZCode 工具说明（并入第 3 步）、会话上下文引用与 read-session-context、记忆/技能等分段（随第 5 步）、其余 reminder 来源的产生方、模型上下文上限表（第 4 步）。

### 第 3 步：补齐核心工具（已完成，实际 3 轮）

- **ZCode 来源**：`core/tool/handlers/`；`core/tool/` 的 `patch-parser.ts`、`patch-apply.ts`、`edit-matchers.ts`、`read-file-state.ts`、`input-validation-model-content.ts`、`result-persistence-format.ts`、`tool-visibility.ts`、`bash-timeout-policy.ts`、`webfetch-preapproved.ts`；`pkgs/node-repl-host`。
- **现状**：见第 4 节对照表。
- **第 1 轮，文件和命令**：apply-patch；edit 匹配器和“先读后改”的读文件状态；bash 后台任务生命周期和 task-output / task-stop（对应现在的 `exec_output` / `exec_kill`）；超时策略；结果持久化格式；参数校验和工具可见性。
- **第 2 轮，网络、多媒体和 REPL**：webfetch（缓存、出站限制、预批准域名）、websearch；read 支持图片、PDF、视频；node-repl（移植 `node-repl-host`）；cron；plan-mode 进入 / 退出计划；todo、ask-user-question 的参数与 ZCode 一致。
- skill 工具放到第 5 步，与技能目录一起做。
- **完成标准**：各工具的输入校验、输出格式和错误文本与 ZCode 一致；新增工具用例。
- **界面**：补丁 diff、网页抓取、图片/PDF 预览、后台任务输出等结果卡片。
- **状态**：第 1 轮已完成（HANDOVER 第 13 节）：契约层（ZCode 工具名、说明、schema、校验文案、结果投影、旧会话别名）、ExitPlanMode 与 `plan_exit` 批准、Read/Write/Edit/Bash 行为与文案、移植 ZCode 用例、前端工具名映射。实际分轮与上面的原计划不同：契约层和 exit_plan_mode 提前到第 1 轮；apply-patch 和 edit 匹配器（Grok 辅助）移到第 2 轮。第 2 轮另含 Glob/Grep、TodoWrite、TaskOutput/TaskStop、AskUserQuestion、EnterPlanMode；网络、多媒体、REPL、cron 视时间而定。
- **状态（2026-10-19 收尾）**：已完成，详见 HANDOVER 第 13、14 节。第 2 轮：Glob/Grep/TaskOutput/TaskStop/TodoRead/TodoWrite 的 ZCode 结果文本、Grep 参数（type、head_limit 0、默认 files_with_matches）、EnterPlanMode。第 3 轮：ApplyPatch 与 Edit 匹配器（Grok 辅助移植，主代理审核接线；Edit 加了四项防误改修正）。剩余差异：WebFetch/WebSearch、Read 图片/PDF/视频、node-repl、cron、Read 的 file_unchanged 存根（随第 4 步）、Bash 工作目录保留与后台完成通知、AskUserQuestion 限额、结果卡片界面。

### 第 4 步：上下文压缩（已完成，2026-10-19）

- **ZCode 来源**：`core/compact/`（`policy.ts`、`microcompact.ts`、`manual.ts`、`rounds.ts`、`prompt.ts`）；`core/agent/compact-session.ts`。
- **现状**：`ts/packages/agent/src/compaction.ts` 沿用 Python 的压缩规则。
- **要做**：microcompact（精简旧的工具结果）；按上下文占用比例自动压缩（为输出预留空间）；请求超出上下文后压缩并重试；手动压缩；摘要提示词用 ZCode 文本；与会话分叉、检查点兼容。
- **完成标准**：长会话接近上下文上限时自动压缩并继续；超限错误后压缩重试成功；新增用例。
- **界面**：压缩提示和手动压缩入口。
- **状态**：已完成，详见 HANDOVER 第 15 节。ZCode 的阈值、摘要提示词（原文）、保留与超窗重试、auto/reactive/manual、快速回填熔断、压缩后读文件与 todo 提醒、microcompact（默认关）、Read file_unchanged 存根、按模型的窗口表；webapp `/compact [说明]` 调压缩接口，分隔线用 ZCode 文案。剩余差异：agent listing 与记忆召回重置（随第 5 步）、计划文件引用、microcompact 设置项与时间触发、压缩进行中/失败的时间线行与一键重试、媒体过大占位重试。

### 第 5 步：扩展能力迁到 TS（5 轮，已完成）

按下列顺序逐项做，每项完成就取消 HANDOVER 第 5 节里对应的 Python 回退：

1. **MCP**：`core/mcp/`（`name.ts` 工具命名、`image-normalization.ts`、`app-tools.ts`）。MCP 服务配置、启用和工具调用。
2. **技能、命令和插件引用**：`core/plugin-reference/`、`pkgs/bundled-skills`、`core/tool/handlers/skill.ts`；随附 `skill-creator-plugin`、`plugin-creator-plugin`、`superpowers-plugin`。composer 目录（commands、skills、remote）改由 TS 组合。
3. **hooks**：`core/hooks/`（配置的 hook 运行器、工作区 hook 信任流程）。
4. **子代理与后台任务**：`core/subagent/`（内置 explore、general-purpose）、`core/runtime-task/`；agent、send-message、respond-to-coordinator、reply-to-channel、escalate、submit-result、list-models 等工具，以及完成通知。
5. **记忆**：`core/memory/`（记忆目录、提取、召回、dream）。

- **状态**：第 1 轮（MCP 运行时）已完成，详见 HANDOVER 第 16 节：stdio / Streamable HTTP / 旧 SSE 服务、工具、资源与提示词工具都在 TS 插件 `plugins/mcp` 里跑，每次调用都要批准，结果按 ZCode `formatMcpToolResult`（50 KB 预算）。仍回退 Python：配了 OAuth 或 `elicitation: true` 的服务、`resources/plugins` 里管控 mcp 的清单、远程会话。剩余差异：图片块、app tools、进度事件、代理环境变量。
- **状态**：第 2 轮（技能）已完成，详见 HANDOVER 第 17 节：文件/资源技能的发现、合并、校验与续读提醒在 TS 插件 `plugins/skills` 里跑（对照 Python 一致），模型用 ZCode 的 `Skill` 工具按需加载，清单作为单独的 `skills_listing` 提醒。命令展开随 composer 推到第 7 步。剩余差异：Skill `args`、内置技能、eager 模式改为按需加载。下一轮：hooks（第 3 项）。
- **状态**：第 3 轮（hooks）已完成，详见 HANDOVER 第 18 节：资源 hooks 与按摘要授权的工作区 hooks（`.xueness/hooks.json`、`.zcode/config.json`）在 TS 插件 `plugins/hooks` 里跑，七个事件的触发点、PreToolUse 拦截、审计和 pipeline Post hooks 对照 Python 一致；ZCode 的 JSON 输出只采用收紧型 PreToolUse 决定。剩余差异：shell 字符串 hooks、hook 放行/改参/上下文注入、ZCode stdin 字段、精确 matcher。下一轮：子代理（第 4 项）。
- **状态**：第 4 轮（子代理）已完成，详见 HANDOVER 第 19 节：模型用 ZCode 的 `Agent` 工具（内置 general-purpose、Explore 和已存定义），子代理在 TS 插件 `plugins/subagents` 里前台、只读运行，子会话和 `task_runs` 用 Python 的布局（Python 能载入、会话投影能显示）；类型清单作为 `agent_listing_delta` 提醒每次请求重建，压缩后照样在。仍回退 Python：会话里有未收集的 Python 后台任务。剩余差异：后台运行、task_collect/resume/send_message 与 SendMessage、完成通知、`inherit_history`、并行执行。下一轮：记忆（第 5 项）。
- **状态**：第 5 轮（记忆）已完成，详见 HANDOVER 第 20 节：Python 的只读三轨记忆（MEMORY.md、USER.md、项目 KEY.md，旧数据原样读取）在 TS 插件 `plugins/memory` 里加载（对照 Python 一致），标准运行时作为 ZCode `relevant_memory` 提醒、轻量运行时作为 Python injected 块注入，不进日志；任一压缩边界或新一轮都重新召回。配了 `XUENESS_MEMORY_ROOT` 不再回退。剩余差异：ZCode 模型驱动记忆（目录索引、selector 语义召回、extraction、dream）、`/api/memory` 编辑器（第 7 步）。**第 5 步完成**，下一步：第 6 步文档与浏览器插件。

- **完成标准**：以上五类不再回退 Python；对应的 Python 对照测试改成 ZCode 用例。
- **界面**：MCP、技能、插件、hooks 设置页；子代理和后台任务面板；记忆管理。

### 第 6 步：文档与浏览器插件（2–3 轮）

- **ZCode 来源**：`pkgs/documents-plugin`、`pdf-plugin`、`presentations-plugin`、`spreadsheets-plugin`、`visualize-plugin`（Gen UI）、`image-search-plugin`（MCP 服务，依赖第 5 步的 MCP）、`browser-use-plugin` 和 `core/browser-client/`（经 `node-repl-host` 运行，依赖第 3 步）。
- **现状**：Office 文档检查和浏览器能力在 Python。
- **要做**：逐个移植插件，取消 browser 和 Office 文档的 Python 回退。
- **界面**：文档、表格、演示文稿预览；浏览器面板；Gen UI 渲染。
- **状态**：第 1 轮（Office）已完成，详见 HANDOVER 第 21 节：Python office 插件（`office_read/office_create/office_replace`、docx/pptx/xlsx/pdf 读写、交付文本抽取、有界预览 DTO）移植到 TS 插件 `plugins/office`，读写与错误文本对照 Python 一致、两个后端互读；交付清单含 Office 文件时不再回退 Python。ZCode 文档包是技能包，放第 3 轮随附。剩余差异：别家 PDF 的个别空格、精简的包模板、`read` 读 PDF/图片（第 7 步）、Office 预览路由（第 7 步）。第 2 轮（浏览器）已完成，详见 HANDOVER 第 22 节：Python 浏览器插件的 6 个 `browser_*` 工具（逐个精确批准、navigate 只许公网 HTTPS、快照格式与截图检查对照 Python 一致）移植到 TS 插件 `plugins/browser`，复用 Python 的 `bridge.mjs` worker（每个 state 目录一个，常驻、随插件关闭），取消 `browser.tools` 回退；仅当侧栏的 Python worker 正占着资料目录时，显式开浏览器的轮次留 Python。前门在转发标签动作、清数据、导入资料前先让出资料目录。ZCode 的 node_repl/IAB/CDP 浏览器与 Xueness 的安全模型相反，不对齐（待决定）。剩余差异：侧栏标签、远程标签、资料导入、数据清理与运行环境检测仍在 Python（第 7 步）。第 3 轮（网络与文档技能包）已完成，详见 HANDOVER 第 23 节：Python 网络插件的 `web_fetch/web_search/image_search` 移植到 TS 插件 `plugins/network`（公网 HTTPS、固定解析地址、FakeIP+DoH、三种搜索服务、搜索模型、图片搜索，112 个整次调用对照 Python 一致，读旧设置文件），加 ZCode 15 分钟网页缓存；ZCode 的 docx/pdf/pptx/xlsx 技能包作为最低优先级的 `bundled` 技能来源随附（去掉 ZCode 专用引用语法）。剩余差异：ZCode `WebFetch {url, prompt}` 契约与辅助模型、`/api/network/*` 路由（第 7 步）、visualize/Gen UI 与 visual-judge（第 7 步）。**第 6 步已完成，下一步：第 7 步。**

### 第 7 步：退役 Python，收尾前端（10 轮，进行中）

- **现状**：第 6 步结束时，下面这些 HTTP 家族和 CLI 仍由 Python 负责：
  - 设置与工作区、composer 与命令、已迁插件留下的资源和设置路由、extensions；
  - MCP 的 OAuth、elicitation 和插件管控，子代理后台协调；
  - terminal、tools、diagnostics、usage、updates、model_monitor、desktop、onboarding；
  - remote、subscriptions、bots、automation、workflows；
  - `bin/` 入口和 `python3 -m xueness`。
- **做法**：每轮迁走一组 owner，并取消对应的转发或回退。仍与 Python 一致的行为继续跑对照测试，能对齐 ZCode 的按 ZCode 写。全部迁完后才删除 Python（第 10 轮）。每轮涉及的界面在同一轮完成。
- **分轮**：
  1. **设置与工作区**（已完成，2026-10-19，HANDOVER 第 24 节）：`/api/settings*`、`/api/workspaces*` 迁到 TS 插件 `plugins/settings`，包括偏好校验、逐字节一致的 `settings.json`、授权根、浏览一层和本机原生选择器。会话和附件的授权根也改由 TS 提供。
  2. **composer 与命令**（已完成，2026-10-19，HANDOVER 第 25 节）：新插件 `plugins/commands` 负责命令发现、`/命令` 展开和 `resources/commands*` 管理；`GET /api/composer`、`/prepare`、`/branch` 迁到 sessions 插件；prepared 消费和命令展开改在进程内完成，内部桥只在 remote 或 subscriptions 生效时兜底消费。
  3. **已迁插件的其余 HTTP 和 extensions**：逐个核对各插件的 `httpFamilies`，迁走仍转发 Python 的部分，例如：
     - `resources/{hooks,mcp,skills,subagents}`、`/api/mcp`、`/api/memory`、`/api/network/*`；
     - git clone 与会话 git、目录浏览、delivery/goal、Office 预览；
     - 浏览器侧栏标签、资料导入与数据清理。

     extensions（`plugins/marketplace`、`plugins/profiles`、`resources/plugins`）也在这一轮。工作量大的话拆成两轮。
  4. **MCP 与后台任务收尾**：MCP OAuth、`elicitation: true`、插件清单管控的 mcp；子代理后台任务和 `subagents.coordination`（参照 ZCode `core/runtime-task`）。
  5. **本机运维家族**：
     - terminal（PTY）、tools（干跑与调用预算）、diagnostics（含 `doctor`）；
     - usage、updates、model_monitor；
     - desktop 宿主（含桌面模式的原生选择器）、onboarding。
  6. **remote、subscriptions、bots**（已完成，2026-10-20，HANDOVER 第 29 节）：三个插件迁到 TS，`/api/remote`、`/api/bots`、`/api/subscriptions` 由 TS 负责；订阅模型进入 providers 目录；remote/subscriptions 下的 composer 与 prepared 不再转发 Python。Z.AI 账号不做。automation 依赖 workflows，移到第 7 轮。
  7. **workflows 与 automation**（已完成，2026-10-21，HANDOVER 第 30 节）：两个插件接进服务端，`/api/workflows`（含 dwf、expert）、`/api/automations`、`/api/automation/offpeak` 由 TS 负责；运行由独立的 TS worker 驱动，actor 节点在 TS 里跑，调度器在服务端；agent 会话可以用工作流工具和 `offpeak_create`。CLI `workflow`、`jobs`、`expert` 随第 9 轮。ZCode 动态工作流仍是可选项（第 5 节）。
  8. **前端模块与媒体**（已完成，2026-10-21，HANDOVER 第 31 节）：Python 插件的前端模块改由 TS 插件清单提供，插件目录与开关由 TS 负责；`read` 支持读图片和 PDF，工具媒体进入模型请求；visualize/Gen UI（`pkgs/visualize-plugin`）和 visual-judge 评审 agent；webapp 重新构建。
  9. **CLI**（已完成，2026-10-21，HANDOVER 第 32 节）：TS 版 `xueness` 命令行（`apps/server/src/cli/`）覆盖 Python 的全部子命令，含 `chat`、运维子命令（`settings`、`settings-set` 等）、`workflow`/`jobs`/`expert`/`automation`、`remote`、`bots` 和最小的 `app-server`，输出与 Python 逐条对照。临时入口是 `bin/xueness-ts`，第 10 轮替换 `bin/xueness`。全屏 TUI（`pkgs/tui`）没有移植。
  10. **删除 Python**（已完成，2026-10-21，HANDOVER 第 33 节）：删除 Python 后端 `xueness/`、Python 测试 `tests/`、`python-feature-bridge.ts`、代理和 Python 启动器；Web、桌面和 CLI 只运行 TS。desktop 打包、`Dockerfile`、`compose.yaml`、`install.sh` 和 CI 改用 Node。Python 对照测试保留，找不到 Python 后端时自动跳过。
  11. **Python 遗留清理**（已完成，2026-10-21，HANDOVER 第 34 节）：删除迁移期的 `RouteTable` 与 `PythonFlockBroker`，原先靠 Python 持锁的测试改用原生锁；新增 Node 版发布暂存脚本和清单生成脚本；补上 `/技能名` 与删除会话时的产物清理。
  12. **剩余差异第 1 批**（已完成，2026-10-21，HANDOVER 第 35 节）：子代理后台任务（`task_collect`/`task_resume`/`task_send_message`）、PTY 终端、GIF 与透明图片、PDF 发给 OpenAI 和 Gemini、可视化组件的保存状态与自适应高度、Windows job object。
  13. **全屏终端聊天首版**（已完成，2026-10-22，HANDOVER 第 36 节）：sessions 插件的 `sessions.tui`，用 `chat --tui` 进入。
  14. **TUI 交互对齐**（已完成，2026-10-22，HANDOVER 第 37 节）：对照 ZCode v3.15.1 的 TUI 补齐补全、审批、问题、排队与指导、卡片、侧栏和会话导航。
  15. **收尾**（已完成，2026-10-22，HANDOVER 第 38 节）：在 Linux 上跑全量检查、desktop、webapp、构建和 TUI 验收；修复 POSIX 上构建找不到 Node `LICENSE` 的问题；文档和清单定稿。
- **前端收尾**：对照 ZCode `packages/desktop`、`web`、`ui`（以及 `client`、`rpc`、`services`、`shared`、`share-ui`、`stream-animate`）补齐剩余界面，统一风格；多语言参照 `pkgs/i18n`。各轮随做随补。第 10 轮核对了 webapp 调用的全部 `/api/...` 路径（143 条），都由 TS 处理，并补上了漏掉的会话 git 写操作和 MCP resources/prompts 目录；界面风格和多语言没有统一对照，留作后续。
- **完成标准**：安装包不含 Python；新机器上的桌面版、Web 版和 CLI 只靠 TS 运行全部功能。
- **状态**：第 1 轮到第 15 轮已完成，详见 HANDOVER 第 24 到 38 节。第 10 轮删除了 Python 后端，Web（`bin/xueness-web`）、桌面宿主和 CLI（`bin/xueness`）只运行 TS；没有处理方的路由返回 404，会话在另一个进程里运行时返回 409 `session_busy`（详见 HANDOVER 第 33 节）。第 11 轮清理了 Python 遗留（第 34 节），第 12 轮处理了剩余差异第 1 批（第 35 节），第 13、14 轮做了全屏 TUI 并与 ZCode 交互对齐（第 36、37 节），第 15 轮收尾（第 38 节）。剩余差异：
  - actor 只有 files、shell、planning、office、network 的工具；worker 里解析不了订阅模型；
  - 全屏 TUI 已与 ZCode 交互对齐（第 37 节），但没有 `guarded` 模式，macOS 终端和各平台真实剪贴板没有实机验证；`app-server` 只有最小协议（没有 v1 的 session/terminal/browser 方法族）；
  - Office 预览没有 `fullDocument`；extensions 应用档案后不做 Python `sync_services` 那样的服务同步；
  - tools 干跑不经过 Gate。model_monitor 没有包装上游调用。updates 没有「正在处理的操作」；
  - 图片：解码上限 50 MP；不读视频；轻量 JSON 模式不附加工具媒体；
  - visual-judge 忽略 `model`、`thoughtLevel`；
  - 子代理没有移植 `apply_messages` / `inherit_context`；
  - `doctor` 的 `version.python` 等字段沿用 Python 的名字；
  - 安装包、Docker 镜像和 CI 只做了静态修改，没有实际运行，需要在自己的 GitHub 仓库上跑一遍工作流；`ts/scripts/stage-desktop-release.ts` 只用假 `gh` 测过；`source-manifest.json` 描述原始 0.1.8 源码包，没有更新。

  **主线已完成。** 后续可选：处理上面的剩余差异，对照 ZCode 统一界面与多语言，以及表中「可选」一行。下一阶段是引擎深化，见 [`engine-roadmap.md`](engine-roadmap.md)。

## 4. 工具对照

| ZCode 工具（`core/tool/handlers/`） | Xueness TS 现在 | 步骤 |
| --- | --- | --- |
| bash（含后台任务、只读策略）、task-output、task-stop | `exec`、`exec_output`、`exec_kill` | 1（只读免批）、3 |
| read（文本、图片、PDF、视频） | `read`（文本、图片、PDF；不读视频） | 3、7 |
| read-session-context | 无 | 2 |
| edit、write、apply-patch | `edit`、`write`；没有补丁工具 | 3 |
| glob、grep | `glob`、`grep`、`list` | 3 |
| webfetch、websearch | 无 | 3 |
| node-repl、cron | 无 | 3 |
| plan-mode | 只有计划模式的权限拒绝 | 1、3 |
| todo、ask-user-question | `todo_read` / `todo_write`、`ask_user` | 3 |
| target（目标） | planning 插件的目标模式（核验已按第 9 节对齐） | 3 |
| skill | `skills`、`skill_read`、`skill_validate`（skills 插件） | 5 |
| agent、send-message、respond-to-coordinator、reply-to-channel、escalate、submit-result、list-models | `task`（ZCode 的 Agent 工具，subagents 插件）；其余没有 | 5 |
| workflow 系列（create、amend、save、run 等） | 无 | 可选 |
| off-peak | — | 不对齐 |
| — | `git`、`delivery_plan` | Xueness 独有，见第 7 节 |

## 5. 可选

- **动态工作流**：`pkgs/dynamic-workflow`、`pkgs/dynamic-workflow-runtime`、`core/workflow/` 和整套 workflow 工具。约 2 轮，依赖第 3、5 步。
- **平台插件**：`zcode-cua-plugin`、`android-emulator-plugin`、`ios-simulator-plugin`、`swift-bridge`。需要 macOS、模拟器或真机；开源版的 `packages/zcode-cua` 只是不含 Computer Use 的占位包。建议不做，或放到最后。

## 6. 不对齐

- 遥测：`core/telemetry/`、`pkgs/telemetry`。
- Z.AI 账号、云服务、错峰（off-peak 工具）和品牌。
- `zcode-guide-plugin`（ZCode 自己的使用与自诊断指南）和 `restore-legacy-sessions-plugin`（恢复 ZCode 旧会话）。需要的话另写 Xueness 版指南。

## 7. 待决定

| 事项 | 建议 |
| --- | --- |
| 是否做动态工作流和平台插件 | 先不做，主线完成后再定 |
| 系统提示和工具说明是否直接用 ZCode 原文（去品牌） | 用原文，便于逐字对照 |
| 模型可见的工具名是否改成 ZCode 的名字（如 `exec` 对应 bash，`todo_read` / `todo_write` 对应 todo） | 改名，旧会话保留别名 |
| Xueness 独有的工具（`git`、`list`、`delivery_plan`）是否保留 | 保留，不影响对齐 |
| 每步是否继续交付 patch 和完整 zip | 继续 |

## 8. 每步检查清单

- [ ] 移植代码并接入插件，在 `NOTICE.md` 记录来源
- [ ] 新增 ZCode 用例，调整受影响的 Python 对照测试
- [ ] `npm run check` 全部通过
- [ ] 同步界面（webapp 测试需要先安装 webapp 依赖）
- [ ] 取消对应的 Python 回退，更新 HANDOVER 第 5 节
- [ ] HANDOVER 新增一节，更新本文第 1 节
- [ ] 重新生成 `complete-project-manifest.json`（`npm --prefix ts run manifest -- --write`），交付 patch 和完整 zip
