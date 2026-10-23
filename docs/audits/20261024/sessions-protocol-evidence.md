# 会话存储、事件与协议：根代理证据

基线：ZCode main `3c5b227649371507ddc4eb46ac5133afe6db1cab`，package 3.16.2；Xueness 0.2.1。这里只读源码，没有运行测试或改动实现。

路径缩写：`Z/` = `E:/models/apps/_stage-z8/reference-ZCode-latest-20261024/`；`X/` = `E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project/`。

## S01：会话主存储架构不同（旧基线已有）

- Z `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:273`：启动时使用 `options.sessionStore ?? openStartupSessionStore(...)`。
- Z `apps/zcode-cli/packages/bootstrap/src/app/session-store.ts:90`：`openStartupSessionStore` 打开 `SqliteSessionStore.openStartup`；`:120` 为 protocol 的对应入口。
- X `ts/apps/server/src/application-api.ts:86`：真实服务调用 `createSessionsStore`；CLI、child、workflow actor 也调用该工厂。
- X `ts/plugins/sessions/src/session-storage.ts:30`：仅 `XUENESS_SESSION_SQLITE === "1"` 时启用库镜像；`:55-64`：先使用常规 JSON journal store，再挂 post-publication save hook。`:43-49`：SQLite upsert 是独立 commit。
- 事实：Xueness 已有 SQLite 能力，但它是可选镜像，不能说“没有 SQLite”。它没有上游默认主 SQLite 的同一事务/表模型。此项是架构选择，不等于已证实的数据丢失或性能缺陷。

## S02：事件保留与分页策略不同（旧基线已有）

- Z `apps/zcode-cli/packages/contracts/src/events/in-memory-session-event-store.ts:39-40`：默认 `turn-window`。
- Z `apps/zcode-cli/packages/contracts/src/events/session-event-retention.ts:8-13,22,30-45,72-115`：瞬态事件类型、sealed turn 120 秒 grace、model_request 驻留元数据瘦身，以及按后继 turn/时间驱逐的策略。
- Z `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:843`，`bootstrap/src/zcode-protocol/server.ts:289`：生产创建默认 event store。
- X `ts/plugins/sessions/src/runtime-event-log.ts:93`：持久 append-only JSONL；`:137-156`：`readPage` 每次 `readLedger` 读取账本，再 filter/reduce 获得页与 snapshot。append 元数据有签名缓存（`:108-135`），不能误说每次 append 都全量重扫。
- 事实：Xueness 没有同一 turn-window 机制，历史分页也采用不同算法。上游主要裁剪内存瞬态副本，Xueness 保留持久事件；不能把“不删除账本”直接描述为同一种内存泄漏。大历史下的 I/O 与峰值开销是源码层的关注点，尚无本次性能测量。

## P01：外部协议不互换（旧基线已有）

- Z `packages/shared/src/zcode-protocol-v4/core.ts:7`：`V4_WIRE_PROTOCOL_VERSION = 3`。
- Z `packages/shared/src/zcode-protocol-v4/wire.ts:19-44`：`complete` / `fragment`，逻辑帧身份、顺序、topic、subscription、字节数和 checksum。
- Z `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:545-555,3704-3705`：实际 publisher 经 `encodeTopicWireFrames` / `emitWireFrame` 发出。
- X `ts/apps/server/src/cli/app-server.ts:14,167-177`：协商 `xueness.app-server.v1/v2`，使用自己的 projectionVersion、回执保留与订阅限制。
- X `ts/plugins/remote/src/app-protocol-subscriptions.ts:42-55`：自己的 conversation/controller/workflow 订阅及 200ms polling；`:57` 后校验 protocol v2。
- X `ts/plugins/remote/src/app-protocol-transfers.ts:78`：`xueness.remote-fragment.v1`。
- 事实：已有投影、订阅、fragment、回执能力，但没有 ZCode V4 的 schema/wire/投影兼容。此项需要明确“行为对齐”与“现有 ZCode 客户端可以直连”的不同验收目标。

## P02：自有远端客户端能力范围（内部差异，合并到 P01 讨论）

- X `ts/plugins/remote/src/manager-ops.ts:78-85`：`acceptHello` 只接收 v1；原生服务本身支持 v2。
- 这说明 v2 的投影订阅存在于服务端，但不能以服务端支持推断当前自有 remote manager 已使用 v2；也不能把它算成“完全没有订阅”。

## 不能按新增目录直接计为缺失

- 最新新增 `bootstrap/src/session-execution/residency-lease.ts`。文件 `:4-7` 明确 residency lease 只保护 detached runner 收尾，prompt busy/idle 已由 Core 掌管。`:22-33` 统一 acquire/finally-release。
- 生产接线位于 `bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts:263`、`handlers/goal-compact.ts:138,451`。
- 这是新边界抽取和生命周期语义。Xueness 已有文件 lease、运行注册表、cancel/drain；本次未证明同一收尾竞态，因此只记录审查目标，不单独认定缺失能力。

## 当前已有的对应能力

Xueness 已有持久事件序号/epoch、事件分页和恢复投影、会话分叉、对话回退、文件 before/after 与 CAS 回退、压缩 operation 持久化、durable command 收据与 native v2 订阅。以上不能继续按早期路线图记为尚未实现。这里的存储/协议差异不否定这些已接线能力。
