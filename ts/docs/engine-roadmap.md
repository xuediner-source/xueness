# Xueness 引擎深化路线图（ZCode 优先，2026-10-22 起）

> 历史路线图：2026-10-24 起，后续工作以 [最新完整对齐清单（15阶段82轮）](../../docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.md) 和 [最新源码审计](../../docs/audits/20261024/AUDIT.md) 为准。下文约30%为早期名称粗匹配，不能作为当前功能覆盖率；Z1–Z8的“完成”仅指当时明确的适配范围。

目标：先把 TypeScript 引擎对齐 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`）的引擎层（`apps/zcode-cli/packages/{contracts,core,adapters,bootstrap,dynamic-workflow}`），再按需吸收 Codex 的执行与沙箱能力。界面层的 ZCode 对齐已在 `zcode-alignment-roadmap.md` 完成，本文件只管引擎。

## 1. 现状与规模

- ZCode 引擎约 27.8 万行；按名字粗匹配，Xueness 已覆盖约 30%（多为工具契约、权限、提示词、压缩、回合循环）。
- Xueness 引擎：`packages/*` 约 2.65 万行（engine-tools 6.4k、permissions 5k、agent 4k、providers 3.4k、contracts 2.6k、sessions 2.35k、kernel 1.8k、tool-bridge 0.9k），插件约 3.9 万行，测试约 2.3 万行。
- 未移植的大块：bootstrap/app 2.3 万；zcode-protocol(-v4) 约 3.7 万；core/runtime/methods 1.6 万（会话分叉、消息/文件回退、压缩持久化、命令队列等）；adapters/model 1.2 万（模型执行层）；core/tool/handlers 1.1 万；dynamic-workflow 约 1.4 万；adapters/storage 0.6 万（SQLite 会话库）；core/tool/executor 0.56 万；adapters/mcp 0.56 万；adapters/exec 0.43 万；contracts/events 0.26 万。

## 2. 阶段

### Z1 模型执行层（adapters/model，3–4 轮）

- 第 1 轮（已完成，HANDOVER §39）：ZCode 失败分类（ModelErrorCode / ModelFailureReason / ModelRetryReason、`classifyModelFailure`）、供应商业务码表（Z.AI/BigModel 1302/1113/1261/1234…、insufficient_quota 等）、重试策略（默认 10 次重试，2 s 起翻倍到 60 s，50–100% 抖动，5 分钟内的 Retry-After 优先，`XUENESS_MODEL_RETRY_*`，default / unbounded / single-attempt 预算）；驱动层按 ZCode runner 语义在“未提交输出”前重发同一请求，发出 `model_request_failed` / `model_retry_scheduled`；传输层保留业务码、未截断的 Retry-After 和 TLS/代理提示；运行活动记录 `retrying` 阶段，网页端和 TUI 显示自动重试。
- 第 2 轮（已完成，HANDOVER §40）：异常结束且零输出、零用量的空补全最多额外重试一次；部分工具输入暂存，正文或思考文字产生后不再重放；SSE data 事件空闲超时默认 10 分钟、每次重试增加 30 秒；开始/完成/失败事件记录每次请求 ID、耗时及已报告用量；最终失败分类写入会话，CLI/TUI 与网页暂停原因显示中文提示。
- 第 3 轮（已完成，HANDOVER §41）：工具参数与名称规范化、同 ID 工具错误闭合；显式 strict 工具的 Anthropic 子集转换；兼容协议开头 system 合并；思考签名历史投影、跨模型过滤与签名拒绝后一次恢复；Anthropic 起始签名/内部 tool_result 兼容；原生流按结束事件提交工具，未闭合输入不合成执行。损坏 JSON 保留既有普通工具错误语义，详见本轮有意适配说明。
- 第 4 轮（已完成 Xueness 适配，HANDOVER §42）：按尝试获取/释放并发名额、固定 FIFO 排队、队列取消与状态展示、可选本地计数诊断、只读执行快照。主会话/子代理/工作流已接入；没有移植 AIMD、前台调度和原始 I/O 记录，直接辅助模型调用仍不在准入范围，见 `../../docs/model-execution-round19.md`。

### Z2 回合运行时与工具执行器（阶段交付）

`core/runtime/methods` 的回合/流式/事件、`core/agent` 的 turn-machine、turn-state、session-history-hydrator、read-file-state-hydrator；`core/tool/executor` 的 call-runner、后台任务、结果展示与序列化；`runtime-command-queue`。

2026-10-22 已完成本阶段的 Xueness 适配，见 HANDOVER §43 与 `../../docs/engine-z2.md`。覆盖回合状态、冷恢复配对/文件快照、授权后执行和保存后结果事件、后台状态/丢失恢复/通知、结果字节预算及分页、当前回合指导收口。命令调度沿用已有持久 FIFO、CAS、推广租约和进程 lease；没有另建参考的进程内优先队列。逐帧持久事件/通用事件 reducer 留在 Z3，外部命令协议留在 Z7。此处“完成”指明确记录的适配范围，不是逐文件或所有产品策略照搬。

### Z3 会话事件与存储（阶段交付）

`contracts/events`（会话事件、reducer、流恢复）；`adapters/storage/session-store` 用 `node:sqlite` 做可选会话库与迁移；`session-fork`、`rewind-message`、`file-rewind`、`compact-persistence`。

2026-10-23 完成本阶段的 Xueness 适配，见 HANDOVER §44 和 `../../docs/engine-z3.md`。包含独立持久事件 ledger/分页与 SSE 恢复、纯 reducer、可选 SQLite 完整快照库和 JSON/修订链导出、分叉身份与稳定边界、对话回退、文件工具前后状态及核验后回退、压缩 operation/boundary 和冷恢复。JSON 活动 journal、修订链及现有媒体/归档文件协议仍为权威；SQLite 是可重建的辅助库，没有将所有产品状态迁成参考库的多表模型，也没有替换旧事件协议。下一阶段为 Z4。

### Z4 执行适配与工具深度（阶段适配已完成）

`adapters/exec`（shell 初始化快照、bash provider、node 执行适配）、`webfetch-network`、文件系统适配。2026-10-23 完成上述 Xueness 适配，见 HANDOVER §45 和 `../../docs/engine-z4.md`。Windows/Git Bash 有真实执行证据；Linux/macOS 原生仍待实机或 CI，不能把 Git Bash 当成 Linux 原生验收。

### Z5 MCP、插件、配置与 hooks（阶段适配已完成）

`adapters/mcp`、`adapters/config`、`core/hooks`（工作区信任）、`contracts/interfaces` 中尚未对应的接口。

2026-10-23 完成本阶段的 Xueness 适配，见 HANDOVER §46 和 `../../docs/engine-z5.md`。覆盖激活内连接lease/运行端口、取消零重放、工具目录通知、资源订阅、持久脱敏活动、shell/MCP数据分层及精确项目摘要trust、逐次hook信任与输出控制。原MCP资源、手动OAuth与独立hook信任保留；没有跨run/session池、官方身份/自动DCR、遥测或shell字符串hook。Windows真实Node MCP/hooks、Git Bash与loopback应用验收通过，其他原生平台待验证。

### Z6 动态工作流（适配范围已完成，2026-10-23）

沿用 `plugins/workflows` 归属。在现有 JSON DAG 与 Python 式 DSL 旁加入原生 TypeScript AST 子集、纯共享编译/校验/解释器、动态运行、API、工具、CLI 与 TUI。适配范围、运行边界及未覆盖的上游能力见 HANDOVER §47 和 `../../docs/engine-z6.md`。这不是完整 TypeScript 类型检查或完整 dynamic-workflow 上游兼容。Windows 构建、搬迁空 PATH 检查，以及 source/built 版各 4 场景、7 次 loopback 运行验收均已通过；详见 Z6 工作总结与验证日志。

### Z7 Xueness 原生 app-server 与 headless（阶段范围已交付；早期估算 4–5 个内部工作块；2026-10-23）

本阶段把外部客户端协议与单任务 headless 命令适配到 Xueness 现有 owner：默认 `xueness.app-server.v1` 保留旧 remote manager 所需方法，显式协商 `xueness.app-server.v2` 后增加投影订阅；headless 复用 AgentRunner 和现有权限/provider 路径。命令回执、会话/媒体/历史/问题/指导/工作流能力继续由原 HTTP owner 提供。ZCode v3.15.1（commit `aac4755666d09fdcd70272fcf063c077a639015f`）是行为参考，不代表完整上游兼容；其 V4 `wireVersion=3` 的 topic frame 没有在 Xueness 中实现。协议、安全边界和 CLI 用法见 HANDOVER §48 与 `../../docs/engine-z7.md`。Windows source 回归按身份去重为 39 项（29 pass、10 项历史 Python oracle skip、0 未解决失败/取消）；typecheck、30/422 插件门禁、1001 TS/最大400 行门禁通过。source 与 built runtime 真实子进程各 7 场景和 5 次 loopback 请求通过；build 706 JS，`test:built` 搬迁 smoke 通过。Z6 基线 Web 审计为 166 个 dist 哈希一致、源码零改动、零删除。额外 shutdown drain source 与 built 各覆盖 EOF、remote disable 两场景，且各有 2 次 loopback provider 请求；此项独立于 runtime 的 7 场景验收。阶段范围与归档见 [Z7 工作摘要](../../WORK-SUMMARY-20261023-Z7.md)、[Z7 说明](../../docs/engine-z7.md) 和 [HANDOVER §48](../HANDOVER.md)。

### Z8 guarded 权限、goal 与 project-memory dream（阶段范围已完成；早期估算 1–2 个内部工作块；2026-10-23）

完成 planning.guarded 的有限危险命令确认、planning.session_goal 的跨轮目标与可控预算，以及 memory 的显式 dream 草稿、单次 JSON 整理、候选审阅和 KEY.md CAS 应用。Guarded matcher 是逐次确认提示，不是 OS 沙箱或自动安全保证；goal 没有自动 resume runner；memory dream 没有自动调度或完整上游工具循环。使用方式、生命周期和保留边界见 [Z8 guarded、goal 与 memory 说明](./z8-guarded-goal-memory.md)、[Z8 源码验收记录](../../验收资料/验证记录/z8-memory-source.json) 与 [架构审查增量](../../docs/xueness-plugin-architecture.md)。

### 之后：Codex 部分

OS 级沙箱（Linux landlock/seccomp、macOS seatbelt、Windows 受限令牌）、Responses API、apply_patch 语义、执行策略等，等 ZCode 部分完成后再排。参照 Codex（Apache-2.0）移植的代码在 `NOTICE.md` 记来源。

## 3. 顺序与工作量

| 阶段 | 早期内部工作量估算 | 验证范围 |
| --- | --- | --- |
| Z1 模型执行层 | 4（本轮规划适配已完成） | 能（脚本化服务端） |
| Z2 回合运行时 | 阶段适配已完成 | 能 |
| Z3 会话事件与存储 | 阶段适配已完成 | Windows 实测，其他平台待验证 |
| Z4 执行适配 | 阶段适配已完成 | Windows/Git Bash 实测；Linux/macOS 原生待验证 |
| Z5 MCP/配置/hooks | 阶段适配已完成 | Windows 本地进程/HTTP 实测；其他原生平台待验证 |
| Z6 动态工作流 | 适配范围已完成 | Windows source/built 验收通过 |
| Z7 原生 app-server / headless | 4–5（历史估算） | 阶段范围已交付；source/built runtime、额外 shutdown drain、build 与搬迁 smoke 均有记录 |
| Z8 guarded / goal / memory dream | 1–2（历史估算） | 阶段范围已完成；源码验收记录见 Z8 memory source record |

早期总体估算为 21–26 个内部工作块，此数字不再作为交付轮次。

以上数字仅保留为早期估算，不表示仍有相应数量的待办工作。按阶段推进、汇报和交付；内部任务拆分不单独交付。Z1–Z8 各自明确记录的适配范围均已完成；跨平台实测、上游未适配能力与后续 Codex 子集仍按各阶段说明保留边界。Z7/Z8 估算合计约 5–7 个内部工作块是历史数字，不是当前剩余计划。

## 4. 共同规则

- 每个 `.ts` 不超过 400 行；功能归插件，共享逻辑放 `packages/*`；按阶段执行相关回归、类型/插件/行数门禁、必要构建和集成验证，更新 HANDOVER，统一交付 patch、完整 zip 和文件清单。不重复无关全套测试。
- 参照 ZCode（Apache-2.0）的代码在 `NOTICE.md` 记来源；去掉品牌、账号、遥测和官方网关逻辑。
- Python 兼容的对外形状（如 `ProviderRequestError.toJSON()`、0–2 s 的 `retry_after`）保持不变；ZCode 语义作为新增字段和新增层接入。
- 不加遥测，可观测性只写本地。

第 17 轮按本次用户要求减少非必要测试：执行相关回归、类型/插件/行数门禁、后端构建和本地 HTTP 验收，不重复运行后端/前端全套；后续验证记录须区分本轮实测与历史结果。

第 18 轮沿用相关验证方式：78 项回归、源码/构建版各 6 场景本地 HTTP 验收、结构与类型门禁、构建及搬迁后运行验证。第 4 块并发准入/本地调试仍是可选未完成项，之后进入 Z2 回合运行时；没有把本轮适配称为整个引擎完成。

第 19 轮完成上述第 4 块的适配，具体数量见 HANDOVER §42。随后 Z2 整阶段适配完成，验收与有意保留的边界见 HANDOVER §43。下一阶段为 Z3 会话事件与存储；早期规模数字不能代替逐项范围核对，也不是固定工期。

Z6 适配范围已完成，见 HANDOVER §47 与 `../../docs/engine-z6.md`；Z7 与 Z8 的已记录适配范围亦已交付/完成，具体证据和保留边界见各阶段说明。Z7/Z8 的早期工作量数字仅为历史估算；Z8 源码验收见 `../../验收资料/验证记录/z8-memory-source.json`。整个引擎仍有“之后：Codex 部分”所列项目及各阶段记录的平台验证边界，不能据此称为全引擎或全上游兼容。
