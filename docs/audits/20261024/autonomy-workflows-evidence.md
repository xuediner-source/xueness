# Autonomy / workflow 源码差异证据

## 范围与判读口径

- 最新 ZCode：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024，HEAD 3c5b227649371507ddc4eb46ac5133afe6db1cab，3.16.2。
- 基线 ZCode：E:/models/apps/session-comparison-20261012/sources/ZCode，HEAD aac4755666d09fdcd70272fcf063c077a639015f，3.15.1。
- Xueness：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project。
- 与相邻的 upstream-engine-delta.json 一起判读：packages/dynamic-workflow/src 在 3.15.1→3.16.2 为零新增、修改或删除。因此下列“新于 3.16.2”只用于在宿主/runtime 中新出现且接入生产调用链的行为；相同功能边界标为基线已有。没有用生成物或测试来证明生产接线，也没有跑测试或调用模型。
- 证据项只陈述源码行为和接线；不含优先级、实现方案或比例。

## 证据项

### 1. 动态工作流的启动/审批边界是基线已有差别，3.16.2 没有改动引擎源码

- ZCode 3.15.1 和 3.16.2 的工具描述都把入口定义为“Create and run a dynamic workflow”，并限制在用户明确要求时调用；两版分别见 E:/models/apps/session-comparison-20261012/sources/ZCode/apps/zcode-cli/packages/core/src/tool/handlers/create-workflow-description.ts:12-25 与 E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/create-workflow-description.ts:12-25。当前工具注册在 E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/index.ts:65-66,119；运行时 handler 检查 dynamicWorkflowRunPort 后提交脚本，未接宿主时明确返回 unavailable：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/create-workflow.ts:154-188，工具条目声明 needsApproval: true：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/create-workflow.ts:367-384。
- Xueness 将建草稿与启动分开：workflow_script_create 保存不执行的草稿，workflow_script_run 以当前 digest 显式启动：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/workflows/src/dynamic-tools.ts:26-31；DynamicWorkflowService.create/start 校验确认及 digest 后才后台执行：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/workflows/src/dynamic-service.ts:55-84。该 service 在应用 API 构造并注入 workflow 插件：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/application-api.ts:100-105、E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/agent-service.ts:127-130。
- 结论范围：这是 ZCode 与 Xueness 的既有产品边界差异，不是 3.16.2 动态工作流引擎改动。

### 2. 3.16.2 新增“空闲且仍有待决项”的动态工作流提醒；Xueness 仍走显式查询/解决/续跑

- 3.16.2 新增纯状态机 WorkflowBlockedReminderClock：按会话空闲时长提醒仍有 pending question / waiting hole 的 run，用户发言、命令开始或待决集合变化会重置计时/次数：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime-task/workflow-blocked-reminder.ts:6-19,29-40,89-119。runtime 宿主读取 live run 的待决问题/holes 并将提醒送入现有后台通知队列：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-blocked-reminder.ts:41-90,114-142；AgentRuntime 构造该时钟：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts:343；命令队列排空后触发 idle、运行命令前重置提醒：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts:50-89；用户 steer 与 run 进度事件也重置：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/steering.ts:165-167、E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-run-progress.ts:40-47。
- 旧版没有该时钟文件或上述接线。Xueness 对外列出的工作流控制为 status/list/cancel/concurrency/resolve，resolve 后保持 paused，需显式再次 run/resume：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/workflows/src/dynamic-tools.ts:32-44、E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/workflows/src/dynamic-service.ts:121-124；workflow service/plugin 的生产绑定见 E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/application-api.ts:100-105、E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/agent-service.ts:127-130。在这个已接线产品面里未发现父会话 idle 自动提醒。
- 这是明确的 3.16.2 新宿主行为；不要与 dynamic-workflow/src 引擎变更混为一谈。

### 3. Goal 自动续跑两侧都已接线，不能列为 Xueness 缺项

- ZCode 3.15.1 和 3.16.2 都会把续跑作为 goal-continuation 输入；旧/新 target.ts:172-176 相同。当前 runtime command queue 会对 prompt/task notification 调用 active target continuation loop，并执行 loop command：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts:176-190,260-270；loop 实现位于 E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts:12-43,45-85。
- Xueness 的 planningGoalExtension.afterRun 调用 goal driver 并在 action 为 continue 时返回独占续跑决定：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/planning/src/goal-extension.ts:30-46；agent runner 消费 extension afterRun 决定：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/packages/agent/src/runner.ts:79-82；server 实例安装该 extension：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/agent-service.ts:244-251。生命周期也调用 options.afterRun：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/sessions/src/lifecycle-api.ts:97-103。
- 两边 hook/队列形式不同，但自动续跑均有可达生产路径；本项是等效项的防误报记录。

### 4. Subagent 协调两侧都有真实生产接线；Xueness 的 coordinator 并非“未接”

- Xueness server 在本地、启用 subagents 时创建 TaskCoordinator 并声明 coordination capability，随后把 background executor 绑定给 coordinator：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/agent-service.ts:235-242,294-301。subagentsExtension 按此绑定公开能力；有 coordinator 时 task 后台 dispatch：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/subagents/src/index.ts:66-91,105-132。绑定后的工具包含 task_collect、task_resume、task_send_message：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/subagents/src/background-tools.ts:13-17,34-54,58-100。
- ZCode 注册 Agent/Task、TaskOutput/TaskStop、SendMessage/RespondToCoordinator：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/index.ts:34-39,55-63,101-116；Agent/Task 的工具条目见 E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/agent.ts:218-222,280-286，子代理运行实现及 coordinator-response port 接线见 E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts:38-54,350-356。
- 两者的任务恢复/结果投递 API 不同，不等于某侧没有协调能力。Xueness coordinator.ts 头部对 foreground/background 的说明与 agent-service.ts 实际注入不一致；本记录只按上述可执行调用链判定。completionCheck/contextReminder 虽有定义，但未找到 scoped production call site，故未把它们计作已执行的强制完成门。

### 5. Project-memory Dream 在 ZCode 基线与最新版都未自动触发；Xueness 提供显式审核路径

- 两版 ZCode helper 都明说“当前产品链路不自动触发 Dream”；runProjectMemoryDream 保留为可等待 handler：旧版 E:/models/apps/session-comparison-20261012/sources/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-dream.ts:54-70；最新版 E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-dream.ts:54-70。scoped core runtime/bootstrap callsite scan 只找到 helper 定义，没有产品链路调用。
- Xueness 的 Dream 是显式 propose/review/start/apply：启动要求确认、允许 real 和 provider 开关：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/memory/src/memory-dream-service.ts:241-248；apply 再检查确认及当前 candidate digest：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/memory/src/memory-dream-service.ts:342-352。server 构造 service/API 并 dispatch：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/application-api.ts:163-165,191-197；CLI 命令声明为显式 review：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/cli/memory-dream.ts:7-21。
- 因此“不自动 Dream”不是 Xueness 相对 ZCode 的落后项；ZCode 上游本身在基线和最新版都没有接线。

### 6. Channel reply 行为是旧功能；3.16.2 的 module 文件是目录清单，handler 仅新增 deferred 标记

- ZCode 3.15.1 已注册 ReplyToChannel，能力是回复当前 bot conversation：E:/models/apps/session-comparison-20261012/sources/ZCode/apps/zcode-cli/packages/core/src/tool/handlers/reply-to-channel.ts:51-58；最新版仍由 handler registry 注册：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/index.ts:1,114。当前 handler 在 metadata 加 shouldDefer: true：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/handlers/reply-to-channel.ts:51-56，这是暴露/延后分类变化，不是首次增加发消息能力。
- 新增 tool/channel-reply/module.ts 标注为 architecture-governance module，列出的 public entrypoint 仍指向既有 handler：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/channel-reply/module.ts:2-9；tool/workflow-entrypoints/module.ts 同样只列 workflow handlers 作为 public entrypoints：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/tool/workflow-entrypoints/module.ts:2-12。这两个 module manifest 本身是目录/治理 refactor，不应算作独立用户行为。
- Xueness task_send_message 的输入是 child task_id 加指导消息，目标是正在运行的子任务：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/subagents/src/background-tools.ts:85-100。它与回复当前外部 bot conversation 的 ReplyToChannel 不等价；在本次限定的 Xueness scope 中未发现通用当前 channel reply 工具。

### 7. 新增 runtime reminder persister 让部分隐藏提醒可随会话恢复；Xueness 的 subagent listing 是 request-only

- 最新增加 persistRuntimeReminderMessage，将 reminder 作为 UI/transcript 隐藏、provider 可见、model-only 的合成 user message 持久化：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/runtime-reminder-persistence.ts:20-59。普通 turn 的 tool-search announcement 在加入 request history 前调用该 helper，代码注释明确用于 fork/resume 不重复公告：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:184-203；compact 后 reminder 与 summary 同批写入，失败时一起清理：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts:304-306,365-379。该 helper 及调用在 3.15.1 scoped sources 中不存在；旧 turn-loop 仍有单独的 todo notice 路径 E:/models/apps/session-comparison-20261012/sources/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:153-170。
- Xueness subagent listing 的 extension 在每次 request 注入，并明确是 request-only、survives compaction、never enters journal：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/subagents/src/index.ts:98-103,111-132。
- 这是 runtime reminder 的恢复/可见性语义差异，不应被误读为 channel-reply module 新增了回复功能。

### 8. 完整 Dynamic Workflow SDK 与 Xueness 的受限 AST 执行器不同；此边界在 3.15.1 已存在

- 最新 ZCode 的生产 facade 组合了 world.run、report/dashboard、artifact 与 stream/future：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts:16,64-79,138-164,268-319。生产启动器创建真实 driver、传入 artifactStore，并以编译后的 lowered 程序调用 runWorkflowScript：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch.ts:35,228-280,376-384；宿主把 run 操作落到 argv executionPort：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/bootstrap/src/app/workflow-world-read.ts:88-89,306-315。
- Xueness 的 durable dynamic engine 在真实执行路径中调用 compileDynamicWorkflow 和 evaluateDynamicWorkflow：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/workflows/src/dynamic-engine.ts:75-81。编译器逐类校验受支持语句/表达式并为不支持节点生成诊断：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/packages/agent/src/script/dynamic-compile.ts:75-114,182-256；解释器显式执行受支持语句，其他节点返回 unsupported statement：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/packages/agent/src/script/dynamic-evaluate-statement.ts:49-77。
- 版本判读：upstream-engine-delta.json 显示 packages/dynamic-workflow/src 在 3.15.1→3.16.2 为零新增、修改、删除：E:/models/apps/_stage-z8/engine-gap-audit-20261024/upstream-engine-delta.json:44-48。因此这里记作原 3.15.1 范围已存在的完整 SDK/执行面差异，不是 3.16.2 引擎新增行为。

### 9. ZCode project-memory recall/index 与后台 extraction 已接入生产 turn；这不等于自动 Dream

- 最新 ZCode turn 在模型执行前调用 recall prefetch，并在成功 turn 路径调度后台 extraction（可由单轮策略跳过）：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:788-795,947-952。3.15.1 已有同一类 recall 与 extraction 调用点：E:/models/apps/session-comparison-20261012/sources/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:596-603,747-753；故不能把这些生产调用说成 3.16.2 才出现。
- recall helper 从项目记忆 manifest/index 取得候选，调用 selector，再过滤并读取被选中的文件：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-recall.ts:203-232。成功 turn 的 scheduler 执行 extraction prompt 与后台记忆 agent：E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts:32-80,109-140。最新版 extraction helper 在 E:/models/apps/_stage-z8/engine-gap-audit-20261024/upstream-engine-delta.json:886-889 中标为 modified；两版的 turn 触发点都存在。本项记录生产接线，不把普通 extraction 混称为 Dream。
- Xueness memory extension 以三条 curated tracks 为上下文来源，并在 prepareRequest 注入模型请求：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/memory/src/index.ts:4-14,84-109；server 的生产 agent extensions 列表实际安装 memoryExtension：E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/apps/server/src/agent-service.ts:26,175,258。Xueness Dream 仍是显式确认的 start/apply 路径，见本文件第 5 项及 E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/ts/plugins/memory/src/memory-dream-service.ts:241-248,342-352；ZCode 两版也都没有自动触发 Dream（第 5 项）。这项比较的是 selector/index recall 与 extraction 对比固定三轨注入及显式 Dream，不把未接线自动 Dream 算作 Xueness 落后。

## 待确认项

无。