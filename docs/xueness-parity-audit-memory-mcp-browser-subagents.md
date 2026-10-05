# Xueness 对照 ZCode 回归一致性审查报告（记忆、MCP、浏览器、子代理）

> 日期：2026-10-05  
> 审查基准：ZCode 开源版 `apps/zcode-cli/packages/core/src/` (`memory/`, `mcp/`, `browser-client/`, `subagent/`, `tool/`, `system-reminder/`) 及相关包 (`adapters/`, `bootstrap/`)  
> 对照目标：Xueness 内置插件 `xueness/bundled_plugins/{memory,mcp,browser,subagents}/` 与共享工具/内核注册表  

---

## 概述与审查方法

本审查逐项核对 ZCode 开源版在**记忆（Memory）**、**MCP 连接（Model Context Protocol）**、**浏览器使用（Browser-Use）**与**子代理（Subagents）**四个核心能力上的设计规范与实现，并与 Xueness 的插件实现进行逐条比对。

对照状态定义：
- **一致**：Xueness 与 ZCode 在用户可感知语义、协议规范或安全边界上等价对齐。
- **部分**：Xueness 实现了该领域的核心能力，但在细节特性（如类型兼容、格式清洗、黑名单过滤等）存在微小缺口。
- **缺失**：ZCode 具备该功能，Xueness 尚未实现且属于可作为后续演进的大功能。
- **有意不做**：因单机隐私、沙箱安全、模型轻量化或架构原则（如坚持由外部/操作员明确审批而非自主静默改写）而明确排除的功能。

---

## 一、记忆（Memory）

| # | ZCode 能力项 | ZCode 源码证据 | Xueness 实现位置（文件:符号） | 状态 | 差异与对齐说明 |
|---|---|---|---|---|---|
| 1.1 | 作用域与项目目录解析 | `memory/project-root.ts:resolveProjectMemoryRoot`（基于工作区路径与 identity 计算 SHA-256 前 16 位，存入 `memories/projects/<slug>-<hash>/memory`） | `xueness/bundled_plugins/memory/memory.py:project_hash`, `memory.py:track_paths` | **部分** | ZCode 按单一项目根目录隔离 Markdown 文件；Xueness 采用兼容 dsh-grok-memory 的三轨道布局（`MEMORY.md` 全局事实、`USER.md` 用户偏好、`projects/<sha1(cwd)[:12]>/KEY.md` 本项目事实），由环境变量 `XUENESS_MEMORY_ROOT` 统一指定根目录。 |
| 1.2 | 索引文件格式与清洗 | `memory/index-content.ts:formatProjectMemoryIndexContent`, `stripTopLevelMarkdownHtmlComments`（移除 YAML frontmatter 与顶层 `<!-- HTML -->` 注释；限制 200 行 / 25,000 字符，超限追加警告） | `xueness/bundled_plugins/memory/memory.py:_strip_entry_head`, `memory.py:clip` | **一致**（已补齐） | Xueness 原先仅剔除程序前缀（`[id:...]`, `[YYYY-MM-DD]` 等）；本次补齐了在 `_strip_entry_head` 中剔除 YAML frontmatter（`^---\s*\n[\s\S]*?---\s*\n?`）与 HTML 注释（`<!-- ... -->`），保证注释不污染上下文，空项自动丢弃。每轨道独立预算（2500/1500/4000 字符）与总预算 12000 字符截断。 |
| 1.3 | 自动注入上下文 | `runtime/methods/context.ts:loadProjectMemoryIndexContent`, `system-reminder/source.ts:wrapSystemReminderForSource` | `xueness/bundled_plugins/memory/catalog.py:load_run_memory`, `memory.py:load` | **一致** | 均在会话执行前注入系统上下文。Xueness 始终带有强制声明 `UNTRUSTED_PREAMBLE`，明确标明记忆为不可信本地数据，不可覆盖系统安全指令；并通过 `settings.memoryEnabled` 与插件开关进行多层禁用保护。 |
| 1.4 | 记忆编辑与权限 | `tool/executor/memory-file-permission.ts:applyMemoryFilePermission`（放行模型 Write/Edit 写入内存目录下的 `.md` 文件） | `xueness/bundled_plugins/memory/editor.py:read`, `editor.py:write` | **有意不做** | ZCode 允许模型在推理过程中通过 Write/Edit 工具直接篡改持久记忆。Xueness 出于安全原则**严格禁止运行期模型自主写入持久记忆**；记忆编辑完全由操作员在 Web 界面或 `/api/memory/tracks/*` HTTP 接口显式确认执行，采用乐观锁（SHA-256 digest 校验）与原子写入。 |
| 1.5 | 记忆自动提取循环 | `memory/extraction.ts:createMemoryExtractionScheduler`, `buildMemoryExtractionPrompt`, `memory-agent-loop.ts` | —（无后台提取 subagent） | **缺失** | ZCode 会话结束后派发后台提取 subagent 解析新增对话事实并增量更新文件。此项需引入后台 LLM 提取调度循环，属高 Token 消耗的大型能力，列为后续阶段性演进，暂不在插件内硬编码。 |

---

## 二、MCP（Model Context Protocol）

| # | ZCode 能力项 | ZCode 源码证据 | Xueness 实现位置（文件:符号） | 状态 | 差异与对齐说明 |
|---|---|---|---|---|---|
| 2.1 | 多传输协议支持 | `adapters/src/mcp/stdio-transport.ts`, `network.ts` (stdio, Streamable HTTP, SSE) | `xueness/bundled_plugins/mcp/mcp.py:McpClient`, `mcp_http.py:HttpMcpClient`, `sse.py:SseMcpClient` | **一致** | 均支持 stdio（子进程 JSON-RPC 2.0）、标准 HTTP / Streamable-HTTP 以及历史 SSE 协议。Xueness 在加载时根据配置 `transport` 自动分发对应客户端。 |
| 2.2 | 工具命名与字符清洗 | `core/src/mcp/name.ts:toMcpToolName`, `toModelVisibleMcpNamePart`（将 `:`、`/` 等替换为 `_`，`mcp__${server}__${tool}`） | `xueness/bundled_plugins/mcp/mcp.py:sanitize_mcp_name_part`, `mcp.py:tool_schema`, `mcp.py:namespaced`, `mcp.py:parse_namespaced`, `plugin.py:tool_name_map` | **一致**（已补齐） | Xueness 遵循规范使用 `mcp__<server>__<tool>` 前缀。针对三方 MCP 服务包含 `:` 或空格等非标准字符的工具名，本次在 `tool_schema` 中引入 `sanitize_mcp_name_part` 进行模型可见命名清洗，并在 `McpPlugin` 中维护 `tool_name_map` 映射，调用时自动还原真实工具名，彻底解决非标准名称无法派发的问题。 |
| 2.3 | 工具结果与内容提取 | `core/src/mcp/index.ts:formatContentBlock`, `formatMcpToolResult`（支持 text、resource 文本/结构化回显、image/audio 占位符及 `structuredContent`） | `xueness/bundled_plugins/mcp/mcp.py:_extract_text`, `mcp.py:call_tool` | **一致**（已补齐） | Xueness 原先仅简单拼接 `type == "text"`。本次补齐了针对 `type == "resource"` 嵌入文本的提取，并支持服务返回的 `structuredContent` 自动格式化追加至工具结果文本，避免三方 MCP 结果丢失关键数据。 |
| 2.4 | OAuth 2.0 认证 | `adapters/src/mcp/oauth-*.ts` (PKCE 流程、回调服务器、刷新令牌) | `xueness/bundled_plugins/mcp/oauth.py:begin`, `oauth.py:finish`, `oauth.py:refresh`, `oauth.py:revoke` | **一致** | Xueness 在插件内完整实现了 PKCE 授权码模式、单机回环回调、AES 隔离凭据存储、基于租约的 token 刷新与撤销端点。 |
| 2.5 | 资源与提示词发现 | `core/src/mcp/index.ts`, `contracts/mcp.port.ts` (`resources/list`, `resources/read`, `prompts/list`, `prompts/get`) | `xueness/bundled_plugins/mcp/plugin.py:load`, `lifecycle.py:catalog`, `lifecycle.py:read` | **一致** | 若 MCP 服务声明了 `resources` 或 `prompts` capabilities，Xueness 会合成为 `_xueness_resources_list`、`_xueness_resources_read`、`_xueness_prompts_list`、`_xueness_prompts_read` 专用工具，并通过 HTTP 接口提供分页只读访问。 |
| 2.6 | 启停、连接池与重连 | `adapters/src/mcp/pool.ts` | `xueness/bundled_plugins/mcp/lifecycle.py:Pool`, `plugin.py:teardown` | **一致** | 采用连接池管理子进程与 HTTP 会话；工具调用时如检测到子进程停止，自动通过 Pool 进行重连与工具重新发现；插件禁用或退出时通过 `teardown()` 安全释放。 |
| 2.7 | 超时与进程管理 | `adapters/src/mcp/timeout.ts`, `windows-job-object.ts` (默认 30s) | `xueness/bundled_plugins/mcp/mcp.py:DEFAULT_TIMEOUT`, `mcp.py:TIMEOUT_CAP`, `windows_process.py:WindowsJobObject` | **一致** | Xueness 默认单请求超时 10s，服务器可配置至最高 30s（`TIMEOUT_CAP = 30`）。Windows 下支持 Job Object 树终止，POSIX 下采用 `terminate()` + `kill()` 进程组级清理。 |

---

## 三、浏览器使用（Browser-Use）

| # | ZCode 能力项 | ZCode 源码证据 | Xueness 实现位置（文件:符号） | 状态 | 差异与对齐说明 |
|---|---|---|---|---|---|
| 3.1 | 页面导航 | `browser-client/facade.ts:Tab.goto`, `Tab.navigate` | `xueness/bundled_plugins/browser/plugin.py:_call`, `bridge.mjs:act` (`browser_navigate`) | **一致** | 均使用 Playwright CDP/Chromium 导航；Xueness 严格限制只能导航至公网 HTTPS，并在服务端通过 DNS 解析进行私有地址和内网 SSRF 防御拦截。 |
| 3.2 | 页面截图 | `browser-client/facade.ts:Tab.screenshot` | `xueness/bundled_plugins/browser/plugin.py:_call`, `bridge.mjs:act` (`browser_screenshot`) | **一致**（已补齐） | Xueness 返回纯内存 base64 PNG data URL，并在 Python 侧校验 PNG 文件头及不超过 450KB 内存上限。本次对 `bridge.mjs` 中的文件截图指令加装了 `if (command.output)` 防护，消除了未指定文件路径时的冗余截图开销。 |
| 3.3 | 精确点击与输入 | `browser-client/facade.ts:Tab.click`, `Tab.fill`, `Tab.type` | `xueness/bundled_plugins/browser/plugin.py:REGISTRY`, `bridge.mjs:act` (`browser_click`, `browser_fill`) | **一致** | 均支持按 selector 执行 `click()` 和 `fill()`。Xueness 对 selector 施加 1000 字符限制，文本施加 5000 字符限制，执行前触发 Gate 严格逐操作批准。`browser_snapshot` 给出的 ref 沿用同一 selector 参数，写成 `aria-ref=<ref>`，不新增动作参数。 |
| 3.4 | 会话复用与持久环境 | `browser-client/facade.ts:Tab`, `selection.ts:selectTabForUrl` | `xueness/bundled_plugins/browser/profiles.py:managed_profile`, `bridge.mjs:launchPersistentContext`, `bridge.mjs:current.json` | **一致** | Xueness 在状态目录下维护专用持久目录 `<state_dir>/browser-profile`（应用 POSIX 0700 / Windows protected DACL 保护），启动时自动恢复 `current.json` 记录的上次活跃 URL，同一个状态目录共享持久运行进程。 |
| 3.5 | 页面检查与内容感知 | `browser-client/facade.ts:Tab.snapshot`（提取无障碍树） | `xueness/bundled_plugins/browser/plugin.py:REGISTRY` (`browser_snapshot`)、`snapshot.py:format_snapshot`、`bridge.mjs:act` (`snapshot`)；`browser_inspect` 仍保留 | **部分** | 已补齐只读无障碍树：Playwright `ariaSnapshotJSON({mode:"ai"})` 输出 role、accessible name、层级缩进，以及可交互元素的稳定 ref（`eN`，iframe 为 `f<序号>eN`）。节点上限 200、深度 24、正文 12000 字符，超限在树末标注截断。ref 不新增点击参数；既有 `browser_click` / `browser_fill` 的 selector 可写 `aria-ref=<ref>`，定位最近一次快照登记且仍连接的元素，再次快照或导航后失效。`browser_inspect` 仍返回主体文本（前 16000 字符）与前 40 个链接。与 ZCode 的差异：没有完整 DOM 元素记录（selector、xpath、rect、属性、parentRef）和单独的 dom 列表，也没有 `maxElements` / `includeHidden` 参数或 `selection.ts` 的多标签选择。 |
| 3.6 | 复杂人机动作（Hover, Drag, Press, Viewport） | `browser-client/facade.ts:Tab.{hover, drag, press, setViewportSize}` | —（未在工具暴露） | **有意不做** | ZCode 为 CUA 与通用桌面交互提供了低级鼠标键盘坐标操作；Xueness 侧重于稳健的 Web 任务操作与自动化审查，坚持基于语义选择器的 `click`/`fill`/`navigate`，不引入非确定性的像素级拖拽与坐标点击。 |

---

## 四、子代理（Subagents）

| # | ZCode 能力项 | ZCode 源码证据 | Xueness 实现位置（文件:符号） | 状态 | 差异与对齐说明 |
|---|---|---|---|---|---|
| 4.1 | 类型定义文件与内置 Profile | `subagent/profile.ts:createBuiltInGeneralPurposeAgentProfile`, `createBuiltInExploreAgentProfile`, `bootstrap/subagents.ts:loadZCodeAgentProfiles` | `xueness/bundled_plugins/subagents/subagents.py:select`, `subagents.py:load` | **一致**（已补齐） | ZCode 支持 Markdown + YAML 前置元数据文件定义子代理，并内置 `general-purpose` 与只读代码检索的 `Explore`。Xueness 在状态目录以 JSON 资源文件（`<state_dir>/resources/subagents/<id>.json`）存储用户自定义配置；本次在 `select()` 中补齐了内置的 `general-purpose`（全工具）与 `explore`（只读检索工具）回退 Profile，无需手动建配置即可派发标准子任务，用户自定义配置保持最高优先级覆盖。 |
| 4.2 | 工具白名单与黑名单 | `subagent/profile.ts:filterSubagentChildToolNames` (`tools`, `disallowedTools`), `tool/tool-visibility.ts:getToolRuleName` | `xueness/bundled_plugins/subagents/subagents.py:agent_tool_allowlist`, `subagents.py:normalize_disallowed_tools`, `subagents.py:provider_with_agent_tools`, `runner.py:run_subagent` | **一致**（已补齐） | Xueness 具备 `tools` 白名单及 `SUBAGENT_DENIED_TOOL_NAMES`（工作流持久写工具）。本次进一步支持了 `disallowedTools` / `disallowed_tools` 黑名单配置与参数剥离（`Bash(git *)` 等）及大小写/别名归一化，支持 PascalCase 工具白名单匹配，同时在模型 Provider 过滤层与子任务执行 Gate 门禁中生效，实现深度防御。 |
| 4.3 | 模型选择与推理覆盖 | `subagent/profile-model-selection.ts:resolveProfileModelSelection` | `xueness/bundled_plugins/subagents/subagents.py:provider_for_agent` | **一致** | 均支持子代理覆盖 `providerId`、`model` 以及 `reasoningEffort`，若未指定则继承父会话的模型配置，并在重叠运行时隔离 Provider 实例，防止并发修改超时与截止时间。 |
| 4.4 | 并发控制与调度 | `subagent/runner.ts`, `contracts/subagent.port.ts` | `xueness/bundled_plugins/subagents/coordinator.py:TaskCoordinator`, `coordinator.py:_WORKER_SLOTS` | **一致** | Xueness 严格施加资源上限：全局信号量 `_WORKER_SLOTS = 4` 限制并发子任务数，每人类轮次限 8 个任务预算，防止上下文与资源打爆。 |
| 4.5 | 结果回传与状态管理 | `tool/handlers/task-output.ts`, `tool/handlers/respond-to-coordinator.ts` | `xueness/bundled_plugins/subagents/tools.py:collect`, `coordinator.py:TaskCoordinator.collect`, `runner.py:run_subagent` | **一致** | `task` 工具派发后立即返回 `task_id`，主代理继续工作；通过 `task_collect` 工具收集结果，`TaskRegistry` 记录完整执行状态（`pending`, `running`, `completed`, `failed`, `cancelled`）、步数与摘要，父会话完成检查确保所有派发任务在结算前均已收集。 |
| 4.6 | 递归与嵌套限制 | `tool/handlers/agent.ts` (子代理不可再次调用 Agent 工具) | `xueness/core.py:line 1442` (`depth < max_depth`), `runner.py:run_subagent` | **一致** | 子任务运行于独立只读会话，传递 `depth = depth + 1`；当 `depth >= max_depth`（默认 1）时核心调度层直接拒绝 `task` 派发，子任务也未挂载 `task` 工具，彻底杜绝递归嵌套爆炸。 |
| 4.7 | 运行态侧栏与卡片面板 | `subagent/ui/SubagentSidePane.tsx`, `SubagentDirectorySidePane.tsx` | `webapp/src/plugins/subagents/SubagentSidePane.tsx` | **一致**（已补齐） | 对齐 ZCode SubagentSidePane；提供运行态子代理列表、步骤进度、耗时统计、结果/错误卡片展开与运行中任务取消；复用 `/api/sessions/<id>/tasks`，轻量模式零请求。 |

---

## 五、本次补齐的项与后续规划

### 1. 本次已完成的安全微补齐（均在插件内完成）
1. **记忆清洗能力**（`xueness/bundled_plugins/memory/memory.py`）：
   - 在 `_strip_entry_head` 中加入 YAML frontmatter（`^---\s*\r?\n[\s\S]*?---\s*\r?\n?`，支持 LF/CRLF）和 HTML 注释（`<!-- ... -->`）的过滤逻辑，使得带注释或元数据的记忆文件能够安全加载，纯注释项自动剔除，不消耗上下文预算。
2. **MCP 工具名清洗与映射**（`xueness/bundled_plugins/mcp/mcp.py` & `plugin.py`）：
   - 引入 `sanitize_mcp_name_part`，将包含冒号、空格等非标准字符的工具名规范化为模型可见的有效名称，保留合法下划线防止 `_private` 与 `private` 冲突，并在 `McpPlugin` 中建立双向映射表，保证派发至目标 MCP 服务器时使用原始真实名称；重连时对工具字典类型安全防卫。
3. **MCP 工具结果内容解析增强**（`xueness/bundled_plugins/mcp/mcp.py`）：
   - 扩展 `_extract_text` 支持嵌入式 `type == "resource"` 文本提取与非文本元数据序列化；在 `call_tool` 中支持将三方服务返回的 `structuredContent` 自动格式化追加至结果文本中，消除了工具调用结果数据静默丢失的隐患。
4. **子代理内置 Profile 支持**（`xueness/bundled_plugins/subagents/subagents.py`）：
   - 在 `select()` 中加入内置 `general-purpose` 与 `explore` 的回退对象，提供开箱即用的只读搜索与通用子任务能力，同时保证用户自定义同名配置拥有最高优先级（大小写均优先命中自定义）。
5. **子代理工具白名单与黑名单规则增强**（`xueness/bundled_plugins/subagents/subagents.py` & `runner.py`）：
   - 支持 `disallowedTools` / `disallowed_tools` 配置项，引入 `normalize_disallowed_tools` 自动剥离参数括号（如 `Bash(git *)` -> `bash`）并统一大小写与别名；在 `agent_tool_allowlist` 中支持对齐 ZCode 的 PascalCase 工具名映射，并在 Provider 过滤层和 `Gate.denied_tool_names` 双层予以强制执行。
6. **浏览器截图冗余消除**（`xueness/bundled_plugins/browser/bridge.mjs`）：
   - 对文件截图调用加设 `if (command.output)` 判定，消除无文件输出时的多余截图动作，优化了执行时延。
7. **浏览器无障碍树快照**（`browser/plugin.py`、`browser/snapshot.py`、`browser/bridge.mjs`）：
   - 新增只读工具 `browser_snapshot`（功能 `browser.snapshot`）。用 Playwright AI 模式无障碍树返回 role、name、缩进和可交互 ref，并施加节点与字符上限。ref 通过既有 selector `aria-ref=<ref>` 交给点击和输入，不新增动作参数，不放宽 Gate、选择器长度或公网 HTTPS 限制。
8. **子代理运行态侧栏面板**（`webapp/src/plugins/subagents/SubagentSidePane.tsx`）：
   - 对齐 ZCode 的 `SubagentSidePane`，实现可折叠运行态侧栏、实时子任务卡片列表、进度/耗时监控、结果详情展开与「停止会话（取消全部子任务）」按钮（尚无单任务取消接口）；在轻量模式与关闭状态下保持零网络请求。

### 2. 后续演进规划（列为大项，不硬做）
1. **记忆后台自动提取 Subagent（Large）**：
   - 依赖会话结束钩子、后台 Token 预算调度与长程事实分类模型，计划在未来的长会话演化版本中统一评估引入。
2. **浏览器 DOM 无障碍树快照（Medium，精简树已落地）**：
   - 只读工具 `browser_snapshot` 已提供精简无障碍树（role、name、可交互 ref、缩进、节点与字符截断）。既有点击和输入用 selector `aria-ref=<ref>` 引用最近一次快照，没有新增动作参数。
   - 仍不做 ZCode 的完整 DOM 元素记录（selector、xpath、rect、属性、parentRef）、隐藏节点开关和 `maxElements` 参数。`browser_inspect` 的轻量文本与链接摘要保留。
3. **子代理图形化侧栏面板（已完成）**：
   - 对应 ZCode 的 `SubagentSidePane`，已于本次作为 `subagents.sidepane` 功能实现并挂载到 Web 工作台。
