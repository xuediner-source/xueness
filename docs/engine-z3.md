# Z3 会话事件与存储

本阶段于 2026-10-23 交付，基于 Z2，参考 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`）。实现遵循 Xueness 现有插件、权限、文件 journal 和修订链。SQLite 是可选的完整会话快照辅助库；**JSON 活动 journal 与原修订链继续作为执行和恢复依据**。

## 持久运行事件

sessions 在 AgentRunner 的观察回调前同步写入运行事件，包含流式正文、已开启显示的思考、模型请求阶段、工具状态、回合结束、压缩、对话/文件回退。主、子代理、workflow actor 及手动模型压缩均接入。它不采集隐藏思考正文、工具输入、工具结果正文或 `_read_state`；可见文字保留在本地日志供断点恢复，和 Z1 的纯计数诊断用途不同。

日志位于 `<state>/session-events/<sid>.jsonl`。固定 schema 为 `xueness.session-runtime.v1`，envelope 带事件 ID、sessionId、时间、单调 sequenceNumber、可选 turnId/traceId 和白名单 payload。初始 RunStarted 在新 trace 建立前不沿用上次 trace。每次 append 经独立原生文件锁、写入和 fsync 后才返回；缓存文件签名/head，正常逐帧 append 不重复全量扫描。冷实例完整验证；只修复未完成尾行，完整损坏记录明确失败。epoch 只在新建日志时改变，跨服务重启保留。

`GET /api/sessions/:id/events.runtime?after=0&limit=200` 返回 `epoch/head/events/next/hasMore/snapshot`；单页最多 500 条。`after>0` 需同一 epoch，超前或 epoch 改变返回 409。SSE 使用同一路由和 `Accept: text/event-stream`，事件 ID 为 `re1.<epoch>.<seq>`；支持 Last-Event-ID，查询游标与 header 冲突会拒绝。响应为有限分页，不是常驻实时流；旧事件协议保持原形状。所有读取检查 sessions 与工作区授权。

contracts 的纯 reducer 按序归约、跳过重复/倒序，显式记录序号缺口。`recoverRuntimeProjection` 可跨页恢复；每页 snapshot 为游标之前的投影。展示投影保留最多 200 条记录/100 个工具，正文每条 16000、流 24000 个 JS 字符；原 ledger 保留完整事件，不把投影上限当作原始记录截断。当前没有参考实现的 turn-window 自动淘汰策略；永久删除会话时清理对应 ledger。

## 可选 SQLite 会话库

启动前设置 `XUENESS_SESSION_SQLITE=1`，主宿主、CLI、子代理和 actor 的 store 工厂会在 JSON/修订链发布后同步 `<store.directory>/session-library.sqlite`。sessions 禁用或开关关闭时不新增库写入。每个操作单独打开/关闭连接，使用 Node 内置 SQLite、WAL、外键、busy timeout；迁移有 ID/checksum，批量导入为事务。payload 使用无损 Python 兼容编码，保留大整数、整数样式浮点和负零。

API：`GET /api/sessions/storage` 查看状态/授权根内的计数，`GET /api/sessions/storage/list?root=...` 查询授权根，`POST /api/sessions/storage/reindex` 从可访问的现有 JSON 重新建立快照。归档保留最后快照；恢复更新其记录；永久删除清理该行。SQLite 提交失败会使 save 返回错误，但 JSON 可能已经发布；查询原 journal 后可 reindex，不能据此重新执行旧工具。库不作为副作用执行判据。

也可运行插件拥有的管理脚本（检查该状态目录的 sessions 有效状态）：

```powershell
node ts/scripts/session-storage.ts --state C:/path/to/state import
node ts/scripts/session-storage.ts --state C:/path/to/state list
node ts/scripts/session-storage.ts --state C:/path/to/state export --out C:/path/to/new-empty-directory
```

import 不删除或改写源 JSON；export 将库内完整 journal 快照及可用的 history sidecar 写到明确的新空目录，最多 10000 个快照。导出后能用 SessionStore 加载并续写修订链。它不是全部运行状态的克隆：媒体、文件回退 artifact、事件 ledger、队列和模型配置仍在原状态目录。迁移完整环境需一并保留这些资料。

## 分叉与对话回退

封闭轮次分叉继续使用已有 boundary token/revision；guidance 和后台系统通知不再被当作新的人类回合。child 的 message/turn/tool-call/results 身份重新生成，媒体从原 owner 转移到 child 精确 owner，读取权限快照不复制。完成后记录最近 64 份连续消息 ID 的稳定边界，原前缀不再连续就不采用。分叉不改变共享工作区或重放工具。

`GET /api/sessions/:id/rewind-targets` 列出当前保留的真实 user prompt 及 revision；`POST .../rewind` 接受 `{messageId,revision,confirmed:true}`。它持有 session lease，拒绝运行中、过期 revision 或失效工作区；保留目标 prompt 之前的闭合前缀、清除被移除工具的结果和活动状态、暂停会话，并保存最多 24 条 branch-cut 元数据和递增 generation。原修订链保留旧历史。保存成功后才写 HistoryReset，不自动运行模型或重跑命令。

这是对话回退；真实文件不随此接口变化。已移除分支的后台事实标记 branch_removed，不把旧任务重新执行；活跃会话必须先由操作者停止，不能借回退接口绕过运行租约。

## 文件回退

files 在授权通过、Write/Edit/ApplyPatch handler 开始之前记录实际 before 字节、mode、存在状态；结果落地后记录 after hash/存在状态。artifact 位于 `<state>/file-history/<sid>/`，session 只保存关联 ID 和路径等元数据。捕获与结果状态分别持久保存，未取得 committed after 的操作不会被猜测成成功。shell/exec、MCP 或其它外部副作用不属于这些文件工具快照。

`GET /api/sessions/:id/file-rewind?messageId=...` 返回该 prompt 起已记录文件变化的预览和 revision。重复修改合并为最早 before / 最新 after；应用前逐个核验当前 hash，外部修改会阻止整个回退。`POST .../file-rewind` 接受 `{messageId,revision,confirmed:true}`；要求 files/sessions 有效、工作区可访问、会话空闲且不处于 plan 或远程模式。恢复原字节/权限，删除此前不存在的文件；失败时补偿已触及的文件，保存成功后发布 FileRewound。

先文件回退、再对话回退，可以保留精确目标和预览。此接口只处理明确捕获的文件工具变更，不承诺还原整个工作区、目录结构、shell 或网络副作用。永久删除会话同时清理这些 artifact。

## 压缩持久化

模型压缩和手动确定性压缩在开始请求/改写前保存 operation ID、阶段和状态；摘要、checkpoint、source message IDs 与 completed 状态在同一 session 快照中发布。重试、失败和中断留存明确状态。下次运行对 started/retrying 记录，只在存在匹配 operationId 的 checkpoint 时恢复 completed，否则收敛为 interrupted；不因为“附近有摘要”就补成功。timeline 最多 64 条，既有原文归档与修订链保留。

## 本阶段验证与边界

Windows / Node v24.19.0：19 个受影响测试文件的 runner 汇总为 75 tests、74 pass、1 skipped、0 fail；另有 3 个整体跳过的历史 Python 对照 suite，均因已退役后端不存在，不能算通过。类型检查、插件门禁（30 插件 / 393 源文件）、行数门禁（939 TS 文件 / 最大 400 行）、构建（659 JS 模块）、搬迁后空 PATH 运行检查通过。

`tools/verify-z3-runtime.mjs` 的源码与构建版各 4 场景、3 次 loopback 模拟模型请求通过：实际 HTTP 主入口事件分页/SSE冷恢复、SQLite 无损迁移后续写、指导/系统通知下的 child 独立身份、真实文件 handler 快照及文件/对话回退且零重放。原始记录为 `验收资料/验证记录/z3-*`。无前端源码改动，166 个 Web dist 文件与基线逐项哈希相同；没有重复无关全套或前端构建。

本阶段为 Xueness 适配，不逐表移植参考库全部 22 项产品迁移，也不替换活动 journal、原媒体/归档协议、旧事件客户端或执行租约。没有跨 SQLite/JSON/artifact 的通用分布式事务；各操作以既有持久边界和明确恢复状态为准。外部协议层仍归 Z7。无真实/收费模型、提交、推送或发布；安装器、Docker、CI 和其它操作系统未在本阶段验证。下一阶段为 Z4 执行适配与工具深度。
