# Xueness 0.2.1 / ZCode 3.16.2 最新源码差异审计

日期：2026-10-24。固定上游 [3c5b22764937](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab)。本次方法为静态生产源码追踪；未调用模型、未重启应用、未修改运行时代码。结论由主代理复核，Luna max 子代理仅执行指定证据采集。

## 结论

Xueness 已有较完整的通用运行基础，但若目标是完全对齐最新 ZCode，仍需显著增加执行语义、动态 SDK、服务适配和公共协议的深度。优先缺口是通用 ToolSearch/DeferredToolCall、执行级模型回退、自适应 admission、通用 ToolDeadline、工作流 SDK/阻塞提醒、后台记忆提取、MCP Apps 与持久交互 SDK。存储和线协议是已有实现与上游的架构/契约差异，不能简单按“没有数据库/没有订阅”描述。

不提供代码量或功能完成度百分比：此次未做代码行数归一、真实模型任务或性能对照。249 仅是指定五组 CLI 源码的新旧文件变化数；dynamic-workflow/src 未变化，完整工作流 SDK 缺口早于本次更新。版本、目录、生产源码摘要见 [reference-baseline.json](reference-baseline.json)；文件增量见 [upstream-engine-delta.json](upstream-engine-delta.json)。

## 差异账本

下表覆盖本次已定位的主要差异，并非未经运行验证的完整性能评级。阶段映射通向 [82 轮完整计划](../../ZCODE-FULL-ALIGNMENT-TASKS-20261024.md)。

| ID | 能力 | 分类 | 后续阶段 | 证据与结论 |
| --- | --- | --- | --- | --- |
| G01 | 工具暴露与 deferred 调用 | 新增缺口 | F02 | [源码证据](models-runtime-evidence.md)：已有 lightweight selector；缺完整 generic ToolSearch/DeferredToolCall、结构化引用和历史 hydration。 |
| R01 | tool_search 生产执行器和 discovered_tools 写入 | 待运行核验 | F00.02 / F02 | [源码证据](models-runtime-evidence.md)：全 TS 检索未定位生产执行器。result-tool.ts 仅注册 tool_result_read，agent-service 注入该工厂；catalog 声明不能代替可执行接线。 |
| G02 | 模型自适应 admission 与辅助请求归一 | 旧缺口 | F01 | [源码证据](models-runtime-evidence.md)：Xueness 固定 FIFO；上游 AIMD、公平轮转和冷却。标题/语义等需统一生产 admission。 |
| G03 | 执行级临时模型与失败回退 | 新增缺口 | F01 / F13 | [源码证据](models-runtime-evidence.md)：上游先结算已接收工具，再回到原模型；普通 retry 不等价。 |
| G04 | 排队感知工具 deadline | 旧缺口 | F02 | [源码证据](models-runtime-evidence.md)：已有请求和进程时限，缺通用工具计时器及嵌套模型排队暂停。 |
| D01 | 安全工具并发元数据和配置 | 局部行为差异 | F02 | [源码证据](models-runtime-evidence.md)：双方已有默认10并发；上游 mapper dependsOn 当前为空，不能虚构活跃调用DAG优势。 |
| G05 | 前台超时转后台 | 旧能力的行为缺口 | F05 | [源码证据](models-runtime-evidence.md)：Xueness 已有显式后台；上游 eligible Bash 到前台期限后转后台。新版还解除 off-peak 限制。 |
| D02 | 文件读取策略与原子写复核 | 实现差异/保留优势 | F05 | [源码证据](models-runtime-evidence.md)：Xueness 已有编码与范围读取、冷恢复读状态；应保留 rename 前 CAS 和 Windows Job Object。 |
| G06 | 隐藏 runtime reminder 持久化 | 新增缺口 | F03 / F08 / F10 | [源码证据](autonomy-workflows-evidence.md)：上游将隐藏提醒进入历史与 compaction；Xueness 部分列表提示是请求时重建。 |
| G07 | 工作流阻塞自动提醒 | 新增缺口 | F10 | [源码证据](autonomy-workflows-evidence.md)：已有显式 query/resolve/resume，缺上游空闲父会话 blocked-reminder/reset 语义。 |
| G08 | 完整动态工作流 SDK/VM | 旧缺口 | F10 | [源码证据](autonomy-workflows-evidence.md)：当前 DAG+TS AST 子集；需 world.run、artifact/stream/future/dashboard 与完整宿主端口。dynamic-workflow/src 在两版基线间未变。 |
| G09 | 选择式记忆与后台提取 | 旧缺口 | F09 | [源码证据](autonomy-workflows-evidence.md)：已有 curated 三轨注入和显式 Dream；上游 recall/extraction 两版都有生产触发。两版均未自动触发 Dream。 |
| D03 | 子代理与 Goal 的深度契约 | 已实现基础需深化 | F03 / F08 | [源码证据](autonomy-workflows-evidence.md)：Goal 自动继续、TaskCoordinator、后台收集和 send_message 都已接线；不能按旧清单宣称缺失。 |
| G10 | 多根 Skills/Commands | 新增缺口 | F07 | [源码证据](extensions-config-evidence.md)：上游支持目录根与命名空间；Xueness 当前单工作区根发现。 |
| D04 | 配置层级与 Hook/MCP 信任 | 契约差异 | F06 / F07 | [源码证据](extensions-config-evidence.md)：双方有配置、hooks、MCP。准入、摘要授权、会话 lease 和默认信任策略不同，需确定兼容配置。 |
| G11 | MCP Apps UI 宿主 | 已确认能力缺口 | F06 | [源码证据](extensions-config-evidence.md)：已有 MCP tools/resources/prompts/OAuth/elicitation，不等于 Apps；上游有 waitForAppConnection 和 lease 代次复核。 |
| G12 | 持久 Node REPL/Browsers/OS CUA | 已确认能力面缺口 | F12 | [源码证据](extensions-config-evidence.md)：固定浏览器工具与桌面宿主不等于 agent.computerUse、持久 agent.browsers SDK。 |
| D05 | 插件包与原生 WebSearch | 能力面/适配差异 | F07 / F12 | [源码证据](extensions-config-evidence.md)：保留可信 allowlist 与现有搜索；补组件包SDK、alwaysLoad、供应商原生搜索能力。 |
| D06 | SQLite 主存储及事件保留 | 架构/算法差异 | F04 | [源码证据](sessions-protocol-evidence.md)：Xueness 已有可选 SQLite 镜像和持久JSONL；上游默认SQLite主存储及内存turn-window。未证明数据丢失或内存泄漏。 |
| G13 | ZCode V4 公共协议兼容 | 协议不互换 | F11 | [源码证据](sessions-protocol-evidence.md)：原生v1/v2已有fragment/回执/订阅；不等于V4 wire。自有remote manager尚只接受v1。 |
| D07 | 驻留租约与模块抽取 | 审查目标/未证实缺陷 | F03 | [源码证据](sessions-protocol-evidence.md)：上游新增模块不直接算缺失；Xueness已有lease/cancel/drain，需要行为探针后决定修复。 |
| P01 | Off-Peak live ticket/接管 | 服务绑定机制缺口 | F13 | [源码证据](models-runtime-evidence.md)：Xueness已有持久空闲队列；缺执行级ticket续期、凭据和用户接管。私有服务可用性另列。 |
| P02 | 外部频道回复与供应商权益 | 适配接口待补齐 | F12 / F13 | [源码证据](autonomy-workflows-evidence.md)：ReplyToChannel不是子代理发消息。机制与公共契约要实现；无法接入私有后端不能宣称线上等价。 |

## R01 的额外根代理追踪

Xueness `ts/plugins/providers/src/result-tool.ts:64–76` 的 `createProviderResultTools` 仅注册 `tool_result_read`；`ts/apps/server/src/agent-service.ts:130` 注入该工厂，`providers/src/index.ts:25–26` 的 plugin apply 为空。`ts/catalog/providers.json:10` 宣告了 `tool_search`，而 `runtime-tools.ts:7–40` 消费 `session.discovered_tools`。全 TS 检索未定位该搜索执行器或写入生产者。该静态接线疑点优先进入 F00.02 的隔离运行核验；在确认前不把目录元数据当作已实现，也不据此声称所有工具发现均不存在。native_ops 的专属 discover 不是同一个通用接口。

## 重要边界与保留项

- native ToolSearch 取决于 Anthropic Messages 协议能力，默认启用还依赖 Zhipu Coding Plan；local 模式可用于其他支持工具调用的模型。不要将整个 ToolSearch 错说成仅限官方模型。
- 双方已有安全工具并发、读状态恢复和进程树清理。Xueness 的 Windows Job Object 与 rename 前 CAS 应保留。
- Goal 继续、TaskCoordinator、显式后台任务、off-peak 空闲队列、SQLite 镜像、fragment/订阅都不是空白能力。
- 上游 recall/extraction 有生产触发；Dream 的自动 helper 在旧版和最新版都明确不自动触发。
- 新增 module/residency-lease 目录可能是重构，不直接计为新功能。没有行为复现就不虚构竞态或性能缺陷。
- ZCode V4 名称与 wire 常量不是同一数字：当前常量为 3。兼容目标应以固定源码 schema 为准。
- 官方私有后端的认证、票据、权益依赖要单列；可以实现端口和可运行替代，但没有接入证据时不能宣布线上全等价。

## 文档使用说明

四份领域证据保留采集时的绝对本机路径与准确行号，仅用于审计定位；其他机器应按 `reference-baseline.json` 的 commit 重取 ZCode，并将 Xueness 路径解释为本项目根目录。审计没有附带上游源码副本，也没有复制账号/密钥。
