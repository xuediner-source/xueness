# 公共能力与行为契约表（人类可读摘要）

日期：2026-10-24。任务：F00.03。机器可读真源：[public-capability-contracts.json](public-capability-contracts.json)（字段定义、delta 词表、全部锚点以 JSON 为准）。

上游基线：ZCode **3.16.2**，commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`。本机无上游源码树；所有 `upstream:` 锚点转引自本目录四份领域证据（采集时行号），核对时按 [reference-baseline.json](reference-baseline.json) 的 commit 重取，不得假装本机已克隆上游。Xueness 侧 `ts/...` 锚点为 2026-10-24 在本仓库逐项复核。

## 读法

- 表以**不变量为行**，不以文件为行；验收以不变量成立为准，**不按文件数量或完成度百分比打分**。
- `delta` 固定词（与审计分类一致）：
  - `aligned` 双侧生产接线且不变量等效（细节深化仍可排在后续轮次）
  - `gap` 上游有生产接线而 Xueness 缺失或**已证实断线**
  - `arch_delta` 双侧均有接线但架构/契约形态不同，不能按缺失描述
  - `keep_advantage` Xueness 应保留的额外保证
  - `unverified` 至少一侧行为未完成采集，不据此宣称对齐或缺失
- `账本`列回链 [gap-register.json](gap-register.json) / [AUDIT.md](AUDIT.md) 的 G/D/P/R 编号；`验收`列指向 [82 轮任务表](../../ZCODE-FULL-ALIGNMENT-TASKS-20261024.md) 的轮次 ID。
- 统计：47 条契约（models 6 / tools 10 / sessions 7 / workflows 8 / remote 7 / adjacent 9）；delta 分布 aligned 13 / gap 13 / arch_delta 13 / keep_advantage 1 / unverified 7（F02.03 顺延 F02.02 的实际行重算，C-TOOL-04 gap→aligned）。**这是行分类计数，不是完成度。**

---

## 1. 模型域（models / providers）

### 不变量

- **C-MDL-01** 每个协议的响应归一为统一内部模型（工具调用、reasoning、usage/cache、finish reason、流式事件）；不支持字段显式报告，不虚构用量。
- **C-MDL-02** 同一失败只计一次预算；取消不重试；已消费的流式输出不重播；失败分类驱动退避。
- **C-MDL-03** 执行级回退先结算已接收的流式工具调用，再回原模型；不等价于普通重试。
- **C-MDL-04** 模型请求经统一 admission，自适应（AIMD）、公平轮转、冷却；前台不被排队挤占。
- **C-MDL-05** 前台/辅助/子代理/工作流请求同一 admission 治理，辅助调用不牺牲前台。
- **C-MDL-06** 每回合/请求有稳定轨迹 ID 与生命周期投影；不采集隐藏思考正文。

### 映射表

| ID | 契约 | Xueness 归属 / 接线 | delta | 验收 | 账本 |
| --- | --- | --- | --- | --- | --- |
| C-MDL-01 | 请求/响应字段规范化 | `ts/packages/providers`（`metadata.ts:7-12,35,57`、`tool-protocol.ts:78,166`、anthropic-stream/openai/sse/streams）+ `ts/plugins/providers`；F01.01 逐字段账本见 [provider-field-contracts](provider-field-contracts.md) | gap（字段级：FC-GAP-01..03） | F01.01 | FC-GAP-* |
| C-MDL-02 | 失败分类与重试不变量 | `ts/packages/agent`（`model-request.ts:13-20,40-52,89-108`、`model-retry.ts:56-68`、`stream.ts:23-95`）+ `ts/packages/providers/failure-codes.ts:8-65`；F01.02 分类表见 [failure-retry-contracts](failure-retry-contracts.md) | aligned | F01.02 | — |
| C-MDL-03 | 执行级临时选型与回退 | `ts/packages/agent`（`execution-selection.ts` + `driver.ts:140-142` / `runner.ts:58,98` / `model-request.ts:23-24,117`）+ `ts/plugins/providers`（`execution-selection.ts:44-86`）；F01.03 已接线 SingleAttempt/选择失败 vs 请求失败/结算与会话模型恢复，见 [F01.03-result.md](../../../F01.03-result.md) | aligned（F03.02 深化结算账本） | F01.03 / F03.02 | G03 |
| C-MDL-04 | admission/并发治理 | `ts/plugins/providers`（`admission-controller.ts` per-model AIMD + `admission-policy.ts` 按 run 轮转/冷却/前台 observer + `model-execution.ts` 注入）；F01.04 已接线，见 [F01.04-result.md](../../../F01.04-result.md) | aligned | F01.04 | G02 |
| C-MDL-05 | 辅助模型调用入口 | `ts/plugins/providers`（`aux-admission.ts` 统一辅助入口：title/semantic/goal/memory dream/ZCode 压缩摘要经 foreground scope 进入共享 governor，无双重持槽）；F01.05 已接线，见 [F01.05-result.md](../../../F01.05-result.md) | aligned | F01.05 | G02 |
| C-MDL-06 | 轨迹/诊断投影 | `ts/plugins/sessions/turn-runtime.ts:6-18,45,68-69` + `ts/plugins/providers/model-execution.ts:27-29`（ModelDebugStore）；F01.06 统一关联语义：`packages/agent/execution-selection.ts` selectionId+attempt facts、`model-retry.ts` 全事件 ID/usage、contracts `ModelRetry`/`ModelExecutionFallback` 运行事件 + usage 投影、`runtime-event-extension.ts` 映射、`model-diagnostics.ts` selectionId、AIMD cap-change 投影环（concurrency-changed 等价），见 [F01.06-result.md](../../../F01.06-result.md) | aligned（F01.06 验收：跨重试/回退可还原、无密钥、缺失用量=未知） | F01.06 | — |

---

## 2. 工具域（tools）

### 不变量

- **C-TOOL-01** 工具经注册表登记并声明 gate/读写破坏性/并发安全/权限；**插件禁用后从请求目录与执行器同时移除**。
- **C-TOOL-02** 工具可按暴露分类延迟进入请求 schema（不删目录）；分类只影响暴露不改变权限。
- **C-TOOL-03** 通用 tool_search 检索启用插件的工具目录并返回引用；不启用未开插件、不提权。
- **C-TOOL-04** 延迟调用在流中解包为真实调用并走同权限/调度路径。
- **C-TOOL-05** 工具发现跨轮持久、投影回历史；公告一次持久化，fork/resume 不重复。
- **C-TOOL-06** 工具级 deadline 在嵌套模型排队时暂停、准入后恢复；超时报文区分排队时长。
- **C-TOOL-07** 只有显式并发安全的调用并行；其余是屏障；审批挂起阻止后续副作用。
- **C-TOOL-08** 前台超时不等于命令死亡：合格命令到期限转后台保留输出。
- **C-TOOL-09** 写入版本校验覆盖到 rename 前一刻；子进程清理覆盖宿主崩溃。
- **C-TOOL-10** 范围/编码读取不产生半个字符；全文件摘要完整；遗留编码有界回退。

### 映射表

| ID | 契约 | Xueness 归属 / 接线 | delta | 验收 | 账本 |
| --- | --- | --- | --- | --- | --- |
| C-TOOL-01 | 注册/安全元数据/禁用移除 | `ts/packages/engine-tools/tool.ts:59-118`（gate/mutating/concurrencySafe/requires/subject + F02.01 readOnly/destructive/alwaysLoad/shouldDefer 与 `toolSafetyMetadata`/`toolExposure` 归一化）+ kernel 注册表（`tool-registry.ts:19-32,77-84` 声明视图携带）；禁用移除 = `agent/driver.ts:86-99` owner 双层过滤 + `agent/tools.ts:54-57` 执行器 plugin_disabled（先于 active 集）+ 轻量目录无 schema 即不可见 | aligned | F02.01 | D01 |
| C-TOOL-02 | 延迟暴露元数据（deferred/alwaysLoad/shouldDefer） | **F02.01 已接线（暴露半区）**：标准模式 `agent/kernel-hooks.ts:15` 过滤 shouldDefer（目录不删）；轻量模式 `providers/runtime-tools.ts:6-11,45-50` policy.alwaysLoad 强制入图（不计入 maxDiscoveredTools）、deferred 移出、alwaysLoad 优先；`apps/server/agent-service.ts:267-276` 从注册表派生名单；MCP 连接配置 `alwaysLoad: true / false / 工具名数组` 透传（`mcp/config.ts:40`、`mcp/index.ts:54-88`）。tool_search 执行器、DeferredToolCall 通路、discovered_tools 写入分别归 C-TOOL-03/04/05 | aligned | F02.01 | G01, D05 |
| C-TOOL-03 | 通用 ToolSearch 执行器 | **F02.02 已接线**：执行器 `providers/tool-search.ts:93-131 createToolSearchTool` 经 `result-tool.ts:83` `ctx.tool` 注册（`ownerOf("tool_search")="providers"`，与 tool_result_read 同一 providers 工具面）；本地目录 = 宿主注入的内核活目录投影（`agent-service.ts:140`、`workflow-actors.ts:87`，含 shouldDefer、不含禁用插件工具）；检索 `tool-search.ts:54-71`（名称/描述打分，≤`toolSearchResults` 默认 3）；非延迟命中写 `session.discovered_tools`（`tool-search.ts:85-91`，最新在尾、≤maxDiscoveredTools），轻量选择器 `runtime-tools.ts:22,43` 下一请求重暴露（两步端到端单测锁死）；local/native 协商 `packages/providers/tool-search.ts:26-28` `resolveToolSearchMode` 以协议能力门控（`nativeToolSearch` 仅由实现 deferred-loading 面的适配器声明，本轮无适配器声明→恒 local；无 wired surface 时稳定失败 `native_tool_search_unavailable`，不假成功） | aligned | F02.02 | **R01**, G01 |
| C-TOOL-04 | DeferredToolCall 通路 | **F02.03 已接线**：信封契约 `packages/providers/deferred-call.ts:14-44`（`deferred_tool_call` schema `{tool,input}` + `resolveDeferredToolCall`，包装器/准入点共享）；包装工具 `plugins/providers/deferred-call.ts` 经 `result-tool.ts:86` `ctx.tool` 注册（`ownerOf="providers"`，gate=tool_search、concurrencySafe=false 信封永不批量、run 被桥直触时稳定失败 `deferred_call_unavailable`）；准入/解包 `agent/tools.ts:60-85` runTools prepare——wrapper owner 未启用即 `plugin_disabled`，信封校验失败 `invalid_tool_arguments`，目标经 `kernel-hooks.ts:14` `toolDefinition` 活目录解析、非 deferred 拒绝 `not_deferred_tool`（含嵌套信封）；解包后与直接调用共用同一段 owner/enabled、beforeTool、ToolBridge（lease/schema/Gate/PermissionSession/调度）与 results 关联（按模型 call_id，`tool_result_read` 可分页）；取消 run_paused/cancelled 同源。同轮端到端单测锁死 `tool_search→deferred_tool_call→目标真实执行`，deferred 命中仍不写 discovered_tools（C-TOOL-05/F02.04 维持 gap） | aligned | F02.03 | G01 |
| C-TOOL-05 | discovered_tools 持久化与压缩公告 | **F02.04 已接线**：生产者 `plugins/providers/tool-search.ts`（非延迟命中写 `session.discovered_tools`（最新在尾、≤maxDiscoveredTools）+ `queueDiscoveredAnnouncement` 排队从未公告名 → `flushDiscoveredToolsAnnouncement` 一次性持久化隐藏 reminder 行（role=user、`wrapSystemReminderForSource('tool_discovery')`、`_meta_source` 标记；累计台账 `announced_discovered_tools` 保证 fork/resume/后续轮不重复公告，`_meta_source` 行被 rewind/memory 表面过滤）；`hydrateDiscoveredTools` 在 `lightweightRuntimeExtension.beforeRun` 顶端对活目录校验持久窗口（剪除/去重/重封顶、空目录 no-op），双 profile 覆盖冷恢复与 fork/resume，`agent-service.ts` 注入 `discoveredCatalog`）；压缩后 `agent/compact/post-reminders.ts` `discoveredToolsReminder` 随 summary 行 `_post_compact_reminders` 同批 staged 写入、失败同批丢弃，`announced_compact_discovered_tools` 集合签名跨压缩去重，`zcode-compact-view.ts` 让 `tool_discovery` 源过投影、`system-reminder.ts` 登记持久源；deferred 命中仍不写 discovered_tools（F02.02 边界保持） | aligned | F02.04 | — |
| C-TOOL-06 | 排队感知 ToolDeadline | **F02.05 已接线**：`ts/packages/tool-bridge/tool-deadline.ts`——`ToolDeadline` 只计主动执行：`pause()`（model_request_queued）停表并计入 queuedMs、`resume()`（model_request_admitted）按剩余预算续表，排队期间永不触发；外部 AbortSignal 立即生效（暂停中亦然）且与超时互斥；`race()` 工具自身结算优先，悬挂运行以 `ToolDeadlineExceededError`（code `tool_timeout`）结束，`deadlineFailure` 报告 `{ timedOutAfterMs, queuedMs, activeMs }`；声明式启用 = `engine-tools/tool.ts` `ToolDefinition.timeoutMs` + `ToolEnv.deadlineControl`（pause/resume 供嵌套模型请求通报排队，复用 C-MDL-02 事件词汇）；`bridge.ts #through` 以 `deadline.signal` 运行并 race：超时→`tool_timeout`、外部取消→`cancelled`，未声明路径不变。请求 deadline（`model-request.ts`）与进程超时（`exec.ts:232-257`）各司其职 | aligned | F02.05 | — |
| C-TOOL-07 | 安全并发屏障与顺序 | **F02.06 已统一**：`ts/packages/tool-bridge/batch-scheduler.ts`——`planBatches` 纯规划（仅显式 concurrencySafe 且非 destructive 进并行组，readOnly/mutating 单独不授权；`concurrencyCap` 可配置默认 10、非法值 TypeError；mutating/destructive/未标记各为串行屏障；`suspended()` 阻止展开；dependsOn 非空即屏障、默认无任何边）+ `runBatches`（有界 worker 认领、组间严格有序、结果按索引回填）。`bridge.ts callAll` 与 `agent/tools.ts`（eligible=`hooks.concurrencySafe`、suspended=halt/stopTurn/blockEffects）共用；配置面 `ToolBridgeOptions.batchConcurrency` + `hooks.batchConcurrency`；`BATCH_CONCURRENCY=DEFAULT_BATCH_CONCURRENCY` 兼容导出 | aligned | F02.06 | — |
| C-TOOL-08 | 前台超时转后台 | **未接线（auto 转后台）**：仅 `input.background=true` 建后台（`exec.ts:194-242`）；前台超时 `command_timeout` | gap | F05.03 | G05 |
| C-TOOL-09 | 原子写复核与进程收容 | `ts/packages/engine-tools`（`write.ts:72-79`、`filesystem.ts:162-181`+`atomic-write.ts:35-44,71-79` rename 前 CAS、`process.ts:48-123`+`windows-job.ts:82-135` Job Object） | keep_advantage | F05.02 / F05.05 | D02 |
| C-TOOL-10 | 文件读取策略（编码/范围） | `ts/packages/engine-tools/filesystem-ranges.ts:82-139,142-166`（严格 UTF-8 流式 + 有界回退） | arch_delta | F05.01 | D02 |

> 工具域必须如实反映 F00.02：R01 为 **已证实断线**（`confirmed_broken_transfer_f02`）。在 F02.02 落地前，任何 catalog/文档对 tool_search 的完成描述都不是事实。

---

## 3. 会话域（sessions / events / storage）

### 不变量

- **C-SES-01** 历史由带身份的消息与类型化内容块组成；私有元数据进 journal 不进模型载荷；重复身份拒绝。
- **C-SES-02** 写入先持久化后公布；重启恢复到一致修订点；镜像失败不破坏主存储判据。
- **C-SES-03** 分页以稳定序号/epoch 游标恢复投影；缺口显式记录；瞬态裁剪不破坏持久事实。
- **C-SES-04** 分叉/回退/重试是显式意图：身份重生成、原前缀连续、不重放旧工具副作用。
- **C-SES-05** 文件副作用 before/after 捕获；回退逐文件核验、失败补偿、确认后执行。
- **C-SES-06** 压缩先持久化 operation/状态；只有匹配 checkpoint 才恢复 completed，否则 interrupted。
- **C-SES-07** 迁移不丢执行判据：reindex 不重执行旧工具；导出可续写修订链。

### 映射表

| ID | 契约 | Xueness 归属 / 接线 | delta | 验收 | 账本 |
| --- | --- | --- | --- | --- | --- |
| C-SES-01 | 消息与内容块规范模型 | `ts/packages/sessions`（history/transcript/attachments/store.ts:34,71） | unverified | F04.01 | — |
| C-SES-02 | 主存储架构 | `ts/plugins/sessions/session-storage.ts:30,43-49,55-64`（JSONL 主 + 可选 SQLite 镜像）；工厂 `application-api.ts:86` | arch_delta | F04.02 | D06 |
| C-SES-03 | 事件保留与历史分页 | `runtime-event-log.ts:92-133,137-156`、`runtime-event-api.ts`（epoch 409）、`contracts/runtime-events.ts:288` | arch_delta | F04.03 | D06 |
| C-SES-04 | Fork/Edit/Retry 意图 | `forking.ts`/`fork-boundaries.ts`、`rewind-api.ts:11`/`rewind.ts`（已接线） | unverified | F04.04 | — |
| C-SES-05 | 文件撤销事务 | `ts/plugins/files/file-rewind.ts`、`file-rewind-api.ts:12`（已接线） | unverified | F04.05 | — |
| C-SES-06 | 压缩恢复事务 | `ts/plugins/sessions/compact-runtime.ts:3`、`compact-operations.ts`（已接线） | unverified | F04.05 | — |
| C-SES-07 | 工作区/历史迁移 | `ts/scripts/session-storage.ts`（import/list/export）、`archive.ts` | unverified | F04.06 | — |

> 会话域的 `unverified` 指**上游侧对照未采集**；Xueness 侧以上接线均为已交付生产路径（Z2/Z3），不能按旧路线图记为未实现。

---

## 4. 工作流域（workflows / autonomy）

### 不变量

- **C-WFL-01** 回合状态机阶段化（含 scheduled/waiting_permission/running/…）；输入/指导/通知/命令有确定优先级与合并点。
- **C-WFL-02** 模型边界至多接入一条指导；纯文字收口后仍检查迟到指导；回执语义稳定。
- **C-WFL-03** Goal active 自动续跑直至判据停止；续跑输入不是新人类发言。
- **C-WFL-04** 后台终态/lost 通知在安全边界并入回合并去重；不触发额外模型请求。
- **C-WFL-05** 收尾受租约保护；关闭/禁用时 drain 在途工作。
- **C-WFL-06** 工作流脚本以受控子集编排，经宿主端口（world.run/artifact/stream/dashboard）提供原语；编译不执行；取消及时生效。
- **C-WFL-07** 空闲父会话对有待决项的 run 产生有界自动提醒；用户/进度活动重置。
- **C-WFL-08** 脚本创建与执行有显式审批边界；真实模型调用另需宿主开关；digest 绑定被审内容。

### 映射表

| ID | 契约 | Xueness 归属 / 接线 | delta | 验收 | 账本 |
| --- | --- | --- | --- | --- | --- |
| C-WFL-01 | Turn 状态机与命令优先级 | `turn-runtime.ts:6-18`、`steering-runtime.ts:4`、`runner.ts:79-86`（分立机制，未建统一优先队列） | aligned | F03.01 | — |
| C-WFL-02 | Steering 与输入接管 | `steering-runtime.ts:4`、`steering.ts`/`steering-http.ts`（FIFO/CAS/回执） | arch_delta | F03.03 | — |
| C-WFL-03 | Goal 继续/停止 | `planning/goal-extension.ts:32-46`、`runner.ts:79-86`、`agent-service.ts:250`（**已接线，防误报**） | aligned | F03.04 | D03 |
| C-WFL-04 | 后台通知回合合并 | `shell/background-runtime.ts`、`subagents/background-tools.ts:13-15` | aligned | F03.05 | — |
| C-WFL-05 | 驻留租约与 drain | `ts/packages/sessions/locks*.ts` + workflows close drain（已有 lease/cancel/drain；竞态未探针） | unverified | F03.06 | D07 |
| C-WFL-06 | 动态工作流 SDK/VM 端口 | `workflows/dynamic-engine.ts:75-81`、`agent/script/dynamic-compile.ts`/`dynamic-evaluate-statement.ts:49-77`（受限 AST；无 world.run/artifact/stream/dashboard/VM） | gap | F10.01–F10.05 | G08 |
| C-WFL-07 | 阻塞自动提醒 | **未接线**：resolve 后 paused 需显式 resume（`dynamic-service.ts:121-131`） | gap | F10.07 | G07 |
| C-WFL-08 | 启动审批边界 | `dynamic-service.ts:55-84`（digest 确认 + allowReal + parent ceiling）——有意强于上游，保留 | arch_delta | F10.06 | — |

---

## 5. 远程协议域（remote / app-server）

### 不变量

- **C-RMT-01** 连接首次 initialize 固定协议版本；能力在 hello 声明；协议不互换时不接受混合方法。
- **C-RMT-02** 大回复分片有完整性校验、作用域绑定、驻留上限与生命周期；分片是传输层不是业务重试。
- **C-RMT-03** 订阅帧带 subscriptionId/generation；resync 递增 generation 使旧帧不能覆盖；轮询不调模型。
- **C-RMT-04** 持久写入走 durable command；ACK 丢失以同 ID 查询不重提交；旧写入路径显式标非幂等。
- **C-RMT-05** 冷恢复先快照后增量；epoch/序号变化显式失败；每页 snapshot 是游标前投影。
- **C-RMT-06** 客户端 hello 校验与服务器能力目录一致。
- **C-RMT-07** 远程执行只在已批准主机；探测先于命令；失败区分 retryable 且不暂停运行。

### 映射表

| ID | 契约 | Xueness 归属 / 接线 | delta | 验收 | 账本 |
| --- | --- | --- | --- | --- | --- |
| C-RMT-01 | 协议族与版本协商 | `ts/apps/server/cli/app-server.ts:14,72,167-176`（原生 v1/v2；不实现 V4 wire） | arch_delta | F11.01 | G13 |
| C-RMT-02 | Wire 帧/传输分片 | `remote/app-protocol-transfers.ts:78`（`xueness.remote-fragment.v1`） | arch_delta | F11.02 | G13 |
| C-RMT-03 | 投影订阅与 resync | `remote/app-protocol-subscriptions.ts:42-61`（16 订阅/200ms/generation） | arch_delta | F11.03 | G13 |
| C-RMT-04 | 命令收据与幂等重放 | `sessions/command-receipts.ts` + `app-server.ts:176`（24h 保留；legacyWritesIdempotent:false） | arch_delta | F11.04 | — |
| C-RMT-05 | Hydration/投影恢复 | `sessions/runtime-event-api.ts`、`event-resume.ts`、`contracts/runtime-events.ts:288` | arch_delta | F11.05 | G13 |
| C-RMT-06 | 自有 remote manager 版本 | `remote/manager-ops.ts:78-85`（**仅接受 v1**，服务端已支持 v2——内部消费侧滞后） | gap | F11.03 | — |
| C-RMT-07 | SSH/WSL 交互端口 | `docs/remote-handshake.md`（`xueness.remote-handshake.v1` 自有握手）+ `remote/session-guard.ts:12` | unverified | F11.06 | — |

> V4 常量注意：ZCode V4 的 `V4_WIRE_PROTOCOL_VERSION = 3`，名称与 wire 数字不同；兼容目标以固定源码 schema 为准。『行为对齐』与『现有 ZCode 客户端可直连』是两个不同验收目标。

---

## 6. 相邻挂靠域（adjacent，轻量记录）

| ID | 契约 | Xueness 归属 / 接线 | delta | 验收 | 账本 |
| --- | --- | --- | --- | --- | --- |
| C-ADJ-01 | 配置层级与 Hook/MCP 信任 | `settings/runtime-config.ts:9-18,173-260`、`hooks/trust.ts:92-105`（根+digest 双命中才信任，更保守） | arch_delta | F07.01 / F07.03 | D04 |
| C-ADJ-02 | MCP 基础能力 | `mcp/mcp-ops-http.ts:73-141` + elicitation UI（**已接线，防误报**） | aligned | F06.02 | D04 |
| C-ADJ-03 | MCP Apps UI 宿主 | **未接线**（无 ui://、waitForAppConnection、Apps host） | gap | F06.06 | G11 |
| C-ADJ-04 | 多根 Skills/Commands | `skills/discover.ts:34-43`（单根发现） | gap | F07.04 | G10 |
| C-ADJ-05 | 记忆 recall/extraction 与 Dream | `memory/index.ts:4-14,84-109` 三轨注入 + `memory-dream-service.ts:241-248,342-352` 显式 Dream；缺 recall/extraction 生产触发 | gap | F09.01–F09.03 | G09 |
| C-ADJ-06 | 持久 REPL/Browsers/OS CUA | `browser/tools.ts:15` 六个固定工具 + `native_ops`；**无** agent.browsers/computerUse/REPL SDK | gap | F12.01–F12.03 | G12, D05 |
| C-ADJ-07 | 外部频道回复端口 | **未接线**（task_send_message 是子任务指导，≠ ReplyToChannel） | gap | F12.05 | P02 |
| C-ADJ-08 | WebSearch 执行接口 | `network/tools.ts:22-25,88-96`（显式端点/搜索模型 + 审批） | arch_delta | F12.04 | D05 |
| C-ADJ-09 | Off-Peak 票据与接管 | `automation/tool.ts:29-73` 持久空闲队列；**无** ticket 续期/凭据/接管 | gap | F13.02 | P01 |

---

## 账本反向索引

| 账本 ID | 契约行 |
| --- | --- |
| R01 | C-TOOL-03, C-TOOL-05 |
| G01 | C-TOOL-02, C-TOOL-03, C-TOOL-04, C-TOOL-05 |
| G02 | C-MDL-04, C-MDL-05 |
| G03 | C-MDL-03 |
| G04 | C-TOOL-06 |
| G05 | C-TOOL-08 |
| G06 | C-TOOL-05 |
| G07 | C-WFL-07 |
| G08 | C-WFL-06 |
| G09 | C-ADJ-05 |
| G10 | C-ADJ-04 |
| G11 | C-ADJ-03 |
| G12 | C-ADJ-06 |
| G13 | C-RMT-01, C-RMT-02, C-RMT-03, C-RMT-05 |
| D01 | C-TOOL-01, C-TOOL-07 |
| D02 | C-TOOL-09, C-TOOL-10 |
| D03 | C-WFL-03 |
| D04 | C-ADJ-01, C-ADJ-02 |
| D05 | C-TOOL-02, C-ADJ-06, C-ADJ-08 |
| D06 | C-SES-02, C-SES-03 |
| D07 | C-WFL-05 |
| P01 | C-ADJ-09 |
| P02 | C-ADJ-07 |

## 刻意未展开

- F05 平台执行适配其余细节（shell 初始化快照、WebFetch 逐跳策略）：已有 Z4 交付与 [engine-z4.md](../../engine-z4.md)，契约化随 F05 轮次补充。
- F06 MCP OAuth/DCR、压缩二进制协议与 F07 插件组件包 SDK：按 brief 属轻量挂靠，本表仅记边界（C-ADJ-01/02/03）。
- F08 子代理配置继承/完成聚合细节：已接线面见 C-WFL-03/C-WFL-04，深度契约随 F08 展开。
- F14 全量验收与迁移：以本表 `acceptanceRound` 为入口，不在 F00.03 展开。
