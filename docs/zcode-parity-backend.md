# 后端相对 ZCode 的架构差距（BE-Z1）

日期：2026-10-10。只读对照，本文件不改协议、不改接口。

对照基线是本机只读树 `/workspace/refs/ZCode`，公开版本 **v3.14.3**，提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。Xueness 侧以当前分支 `opt/grok-be-20261010` 的 `f05a380` 为准，范围是 `xueness/`（含 `bundled_plugins/`）、`desktop/entrypoint.py`、`desktop/scripts`、`tools/`、`tests/`。前端 `webapp/` 不在本轮修改范围内。

上游协议与传输是 Apache-2.0，版权归 Z.AI Co., Ltd.（见上游 `LICENSE`、`NOTICE.md`）。本文只记录结构与行为差距，不摘录上游实现，不使用上游产品名作为 Xueness 的界面文案。仓库既有归属说明见 [NOTICE.md](../NOTICE.md)。若以后直接移植大段代码，必须在文件头保留来源与许可证，并更新 NOTICE。

## 读过的上游材料

| 材料 | 它实际规定什么 |
|---|---|
| `AGENTS.md` | 桌面用 stdio 与 Agent 通信；Main 不保存 task/session 业务状态。每个窗口一个 window-scoped Local Host。手机远控附着已有 Host，不为手机再起一套 Agent。`desktop-continuous` 与 `web-remote-replayable` 必须分开。外部 relay 只做鉴权、配对、心跳、转发和 attachment 调度。已接受的运行中输入由 CLI `CommandInbox` 串行准入。`workspaceIdentity` 用于隔离，`workspacePath` 用于文件与命令。 |
| `CONTEXT.md` | 插件商店词汇（官方市场、内置插件、CDN 插件、生命周期）。不定义会话、审批或远程执行协议。 |
| `architecture-policy.yaml` | 架构检查策略。只有 `storage` 标成 `managed: true` 并分 domain/app/adapters。`rpc`、`server`、`services`、`session` 仍是 legacy。全局上限是单文件 400 行、契约 300 行、公开方法 12 个、禁止环和深层导入，且 `managedOnly: true`。这是仓库治理，不是产品能力。 |
| `packages/rpc` | 六层：基础设施（含取消令牌）、帧、Channel RPC、IPC、服务代理、Remote。`SocketProtocol` 只分帧。`PersistentProtocol` 才有 ACK、心跳、有界重放和拥塞水位。 |
| `packages/server` | HTTP/WebSocket 入口、一次性 host capability、stdio Agent 宿主，以及 SSH/WSL/Docker 远端部署与握手。 |
| `packages/services` | `IZCodeAgentService` 是会话与 v4 通道的服务面。连接作用域按角色裁剪能力。进程树回收在 `process/`。实时端口把停止、审批回复和队列命令交给租约所有者。 |
| `packages/shared/src/zcode-protocol/` 与 `zcode-protocol-v4/` | server/services 的类型真源。v4 是 schema 与纯函数（snapshot、delta、交付画像、命令、wire），运行时不放在这个包。legacy 协议与 v4 并存，wire 版本是 3，投影 snapshot 仍是 protocolVersion 1。 |
| `apps/zcode-cli/packages/core/src/permission/service.ts` | 工具批准的优先级在 CLI，不在 HTTP server。本文只引用它来说明审批差距，因为服务层的 `permission.request` 和 `respond_permission` 最终落到这里。 |
| `harness/remote/README.md` | 只有一条本地 SSH 容器示例，没有产品协议。远程产品行为以 `packages/server/src/remote/` 为准。 |

`DESIGN.md` 是界面规范。本轮不把它当作后端行为依据，也不建议为对齐去改 Xueness 默认外观。

## 排序

价值按这个顺序估：先保证本机一次运行不会丢事件、重复执行或停不下来，再考虑多端附着和远程机器。远程 harness 的实现量和攻击面最大，排在最后。

下面每一节都先写 Xueness 已经有的行为，再写相对上游弱的部分。2026-09-30 的 [功能复查](zcode-feature-audit-2026-09-30.md) 和 2026-09-24 的 [路线图](../reviews/zcode-parity-roadmap.md) 有多处已被后续插件补上，不能把那里的「缺失」直接当成今天的后端结论。

## 已经有、不必再建成「对齐项」

这些是共享内核或已登记插件，保持即可。

| 能力 | Xueness 现在 | 不要为了对齐拆掉 |
|---|---|---|
| 冻结事件投影 | `xueness/events.py` 的 `xueness.events.v1`：从 journal 纯函数派生，载荷只有截断摘要。契约见 [事件协议 v1](xueness-event-protocol-v1.md)，黄金文件 `tools/protocol-v1-golden.json`。 | 不要改已发布字段，不要把上游 snapshot 当成真源。`events.py` 文件头写明上游会话快照是降级消费者。 |
| 模型正文增量 | `xueness/bundled_plugins/sessions/deltas.py`，schema `xueness.model-delta.v1`。偏移指向一条不可变 stream id 里的正文；完成或中断后的流留在 journal 里，重连按偏移续读。SSE 最长约 30 秒，之后客户端用 cursor 再连。 | 这是正文流，不是会话操作日志。 |
| 单写入者 | `xueness/session_lease.py`：打开锁文件后再确认它是普通文件。Windows 上 `O_NOFOLLOW` 为 0，所以不能把打开前的路径检查当边界。同进程还有 `running` 集合，忙时 HTTP 409。 | 这是文件租约，不是可跨 Host 路由的 run lease。 |
| 批准 | `xueness/web.py` 的 `WebGate`：默认拒绝，一次性批准绑到 tool-call id 和规范化 subject，带审计。权限模式 `build` / `edit` / `yolo` / `plan` 的取值在 `sessions/plan_mode.py` 的 `PERMISSION_MODES`。plan 只允许本会话计划草稿。`yolo` 对远程 SSH 仍然一次性批准。 | 启用插件不等于授权执行。 |
| 停止当前运行 | `POST /api/sessions/<id>/stop` 把 id 放进 `stop_requested`，并取消该会话在 task registry 里仍为 running 的任务。`core.py` 在步骤之间和流式回调里看这个标志，把流标成 `interrupted`，会话落到 `stopped`。stdio app-server 的 `turn/cancel` 走同一条 HTTP stop。 | 见下文第 3 节：标志到不了仍堵在子进程或整包 HTTP 里的调用。 |
| 本机桌面宿主 | `desktop/host.py` 校验父进程给出的 64 位十六进制 `XUENESS_DESKTOP_TOKEN`，弹出环境变量后放进上下文。`web.py` 用 `X-Xueness-Desktop-Token` 做常量时间比较。Web 仍要 loopback Host/Origin 和 POST CSRF。 | 这是进程级共享密钥，不是一次性升级票据。 |
| 本地 stdio 控制面 | `remote` 插件默认关闭。`app_server.py` 是行分隔 JSON-RPC，stdout 只写帧，不监听端口。信任边界是拉起它的父进程，因此这里故意没有 Host/Origin/CSRF；Gate、插件开关、工作区边界和会话租约仍在。 | 不要把它说成已有 WebSocket RPC。 |
| 命名 SSH 执行 | 同一插件的 `remote_exec`：配置摘要绑定、POSIX `shlex` 引用、`BatchMode` 与严格主机密钥。`system=windows` 在批准和 SSH 之前拒绝。 | 这是一次批准过的 argv，不是远端 Agent。 |
| 问答幂等 | `sessions/answer_question.py` 对实验中的 `ask_user` 回答使用幂等键。队列在崩溃恢复时避免把已完成项再执行一次（`sessions/http_routes.py` 里对 `current_queue_item_id` 的注释）。 | 只覆盖这两类写入，不是通用命令表。 |

## 1. 会话事件日志：有水位的快照与增量，以及两种交付画像

这是后面重连、多端和取消确认的前提，所以排第一。

上游把「现在会话长什么样」和「刚才发生了哪几步」分成可重放的日志，而不是每次从整本 journal 重新编号。

- 传输外壳在 `packages/shared/src/zcode-protocol-v4/transport.ts`。`hello` 同时带 `clientMode`（`desktop-continuous` 或 `web-remote-replayable`）和 `deliveryProfile`（`continuous` 或 `replayable`），并且两者必须匹配。订阅参数是 topic 加上可选的 `base: { logEpoch, seq }`。注释写明：只有客户端真的持有该时刻的一致状态，才允许带 base。
- 两套画像在 `zcode-protocol-v4/core.ts` 的 `DELIVERY_PROFILES`。continuous 约 30ms 刷新，流式正文、工具输入和摘要都开，工具进度关。replayable 约 150ms，只流式 `text`，工具进度开，并且没有桌面专有行。`profiles.ts` 要求：被画像滤掉的增量，必须被后来一条不可过滤的完整行收口，这样断线重放后两种画像的终态一致。
- 限额在 `PROTOCOL_V4_LIMITS`：单帧 1MiB、逻辑帧组装 16MiB、订阅缓冲 500 条或 1MiB、每会话保留 2000 条事件、快照尾窗 60 行、命令幂等表每会话 512、命令待处理 TTL 24 小时。
- 服务方法在 `packages/services/src/zcode-agent/zcodeAgent.ts` 的 `IZCodeAgentService`：`subscribeConversationV4`、`resyncConversationV4`、`sendConversationCommandV4`、`queryConversationCommandsV4`，以及 sessions-index、workspace-config 两条平行通道。旧的 `onDynamicSessionEvent` 标明为废弃读路径。
- 后台流会合并。`zcodeSessionEventCoalescer.ts` 只合并 `text_delta`、`reasoning_delta`、`tool_input_delta` 和工具 progress，避免每块增量都占一条日志。

Xueness 的时间线真源仍是 `derive_events`：

- 第一条永远是 `session.status`，内容来自当前 `status` / `steps` / `mode`。同一次运行里这条的 `seq` 仍是 1，载荷会变。信封里另有当前状态，所以只拉 `seq > cursor` 的客户端看不到「状态事件本身变了」，只能看到信封。
- `page_events` 规定 cursor 超过 `head` 不是错误，返回空页，`nextCursor` 等于请求 cursor，`hasMore` 为 false。压缩、编辑消息或截断历史之后，旧的大 cursor 会看起来像「已经追上」，实际前缀已经换过。
- `sessions/events_cursor.py` 把这个问题写在实验开关 `general.sessionsEventsCursorEnabled` 上，默认关闭，而且只加在旧路由 `GET /api/sessions/<id>/events`。非零数字 cursor 直接 409，要求 `resync_cursor: 0`；opaque token 绑定已消费前缀的哈希，前缀被改写则 409。v1 路由没有这个保护。
- 模型增量是另一条 `GET .../deltas`。它按字符偏移切片，不记录操作序号，也不和工具事件共用一个 epoch。
- `GET /api/sessions/<id>/conversation` 能从同一份 journal 一次给出 detail、timeline 和完成信息（见 [会话对齐记录](zcode-conversation-parity.md)）。那是点读一致性，不是可订阅日志。队列文件仍是另一次采样。

差距：没有 `logEpoch`，没有「快照 + 此后增量」的订阅，没有按客户端种类过滤后再合并的交付画像，也没有「过滤掉的流必须被完整行收口」这种不变量。v1 作为审计投影是对的；把它当成手机重连或第二个窗口的水位就会在编辑、压缩和状态更新上错位。

若以后做：新路由、新 schema，默认关闭。不要改 `xueness.events.v1` 的字段和黄金文件。事件日志格式属于 AGENTS.md 里的共享 journal/事件协议；「哪个客户端收到哪类增量」是产品行为，应放在 sessions 插件的实验开关后面，例如设置键默认 false。桌面连续流和可重放流必须是两种画像，不能靠前端自己丢事件来假装。需要前端配合时再增加订阅与 resync 的读接口；本轮没有新接口。

## 2. 命令面：和事件流分开的幂等准入

紧挨着第 1 节。只有事件日志、没有命令回执时，客户端会把「没看到事件」理解成「再 POST 一次」。

上游写路径是命令，不是把 HTTP 请求直接推进模型循环。

- `zcode-protocol-v4/command.ts` 的命令包括 `sendText`、队列改写、`resolveInteraction`（`accept` / `decline` / `cancel`）、`switchCollaborationMode`（`build` / `edit` / `plan` / `yolo`）、`cancelBackgroundWork`、`resumeWorkflowRun` 等。需要比较并交换修订号的命令必须带 `baseRevision`。
- 取消、恢复、启动已保存工作流如果被拒绝，回的是带原因的 fault，而不是一个假装成功的 accepted。取消拒绝前缀是 `fault.command.backgroundWorkCancelRejected.`，原因来自「没有取消任何东西」（不存在、已结束、类型不支持）。
- `sendConversationCommandV4` 返回 `CommandAck`。`queryConversationCommandsV4` 用来在超时后询问命令落没落，而不是重放业务。`zcodeAgentConnectionScope.ts` 拒绝未握手或 `clientId` 不一致的命令：静默改写 clientId 会破坏幂等归属。连接作用域把可信的 `clientMode` 从宿主注入，调用方信封里的同名字段不能把手机说成桌面。
- `AGENTS.md` 规定已接受的 busy/running 输入由 CLI `CommandInbox` 串行准入。Renderer 只留未提交草稿。Host 的 owner/lease 负责把命令送到持有运行的那一侧。
- `session/sessionRealtimePort.ts` 的所有者命令包括 `stop_generation`、`respond_permission`、`respond_elicitation`、队列入队、插队和取消。这些都带请求 id，结果另行发布。

Xueness 的写入是 REST 加租约：

- 同进程重复 `run` 得到 409；跨进程拿不到 flock 也是 409。租约覆盖的是「现在不能再开一轮」，不是「这一次用户提交的 command id 已经接受过」。
- 响应在运行结束才返回整段结果。客户端在响应丢失后重试，若上一轮已经结束，会再开一轮，而不是查到上一轮的回执。
- app-server `turn/start` 的返回值里有 `accepted` 和 `cursor`，但那个 cursor 是 worker 的起始时刻，不是日志水位，也不能用来查询同一提交。
- 消息编辑走 `PATCH .../message-actions`，带 journal 的 SHA-256 版本，过期版本拒绝。这是单接口的乐观并发，没有推广到发送、批准和停止。

差距：没有每会话有界的幂等表，没有命令查询，没有 baseRevision 覆盖「改队列 / 改模式 / 重试某一轮」这一族写操作。租约和 409 已经挡住了并发双开，挡不住「响应丢了之后的第二次成功提交」。

若以后做：实验开关默认关闭，命令类型放在 sessions 插件，持久化复用现有私有 journal 写入。幂等键必须绑定会话和调用方，不能接受客户端自报的角色。停止和批准若进入这张表，仍走现有 Gate，不能因为命令被接受就跳过 subject 比对。本轮没有新接口。

## 3. 取消：要到达正在跑的模型请求和已拥有的进程树

现有停止对「会回调的流式请求」和「步骤之间」有效。弱的是阻塞段和子进程。

上游：

- 会话级停止是所有者命令 `stop_generation`，后台工作停止是 `cancelBackgroundWork(workId)`。拒绝必须显式，避免界面以为已经停下。
- `packages/services/src/process/processTreeTerminator.ts` 的 `terminateProcessTree` 按平台回收整棵树。Windows 走带所有权的 taskkill 路径；POSIX 先优雅信号，到时再强制。等待函数会拿进程创建身份核对，注释写明查询失败不等于进程已退出，并且要防止 PID 被复用后误杀。没有 pid 时只对 `ChildProcess` 本身 `kill`，不强行扫系统。
- 插件安装等长时间操作有 `cancelPluginOperation`，并接受 `AbortSignal`。远程连接建立也可被 `AbortSignal` 打断（`server/src/remote/connect.ts` 的 `throwIfRemoteConnectAborted`）。
- 流合并器不负责取消。取消是命令和进程所有权，不是把增量事件丢掉。

Xueness：

- `sessions/http_routes.py` 的 stop 只在进程内 `running` 集合里时把 id 加入 `stop_requested`，并让 task registry 取消该会话仍在跑的任务。空闲会话也返回 200，`stopping` 为 false。
- `core.py` 的 `should_stop` 在循环和 `on_delta` / `on_reasoning_delta` 里生效：回调里抛 `_StreamStopped`，流记录写成 `interrupted`。没有新 token 的阻塞 `provider.complete`，或流已经发出去但套接字不再回调时，这个标志要等到该调用返回。
- `shell/tooling.py` 的 `exec` 使用 `subprocess.run(..., timeout=30)`。停止标志不能提前结束这 30 秒。到点后 Python 会杀掉直接子进程并返回 `command_timeout`；调用没有新建进程组，也没有按创建身份核对孙进程。上游的进程树回收补的是这一段，而不是超时数字本身。
- 终端中断在 `terminal/windows_interrupt.py`，只管终端会话，不管 Agent 的 `exec`。
- 单个子任务取消是 `subagents.cancel_one`，设置键 `agent.subagentCancelOneEnabled`，默认关闭，到下一个 provider/工具边界才停。工作流取消在 workflows 插件里，用 ticket，和会话 stop 不是同一条命令。
- 模型流被打断后，`deltas.py` 把该 stream id 标成 interrupted，续读不会把下一轮正文拼进来。这一段是对齐的，缺的是打断本身的到达范围。

差距：停止是协作标志，不是带所有权的进程树回收。一次 `exec` 最多让停止晚 30 秒；非流式模型请求晚一个完整往返。多个表面（HTTP、app-server、工作流、子任务）各有各的取消入口，没有一条带 workId 的回执说明「取消了什么 / 为什么没取消」。

若以后补：让既有 stop 在流式与非流式、以及已启动的 argv 上同样结束，属于现有语义的补全，应附回归，而不是新开一种默认开启的模式。进程身份核对要复用已有平台 helper（`process_runtime`、终端里的 Windows 中断），不要再写一套按裸 PID 扫描全机的逻辑。单子任务取消保持实验开关和默认关闭。需要前端时，stop 响应里区分「已请求、已结束、没有正在跑的工作」即可；本轮响应不变。

## 4. 重连：帧级有界重放，加上按 epoch 的重新订阅

排在命令面之后。没有第 1 节的日志水位时，先做一条会重放字节的 WebSocket，只会把过期帧再送一遍。

上游其实是两层，而且 HTTP 入口只用了其中一层：

1. 会话层。客户端带 `base.logEpoch + seq` 订阅；对不上就 `resync`。画像过滤是纯函数，重放和直播走同一条。订阅缓冲和保留条数有上限。Agent 进程被换代时，`onAgentRuntimeRestarted` 要求订阅方重新 subscribe，因为 v4 订阅活在 CLI 进程内存里，进程没了订阅就没了。
2. 套接字层。`packages/rpc/src/persistent-protocol.ts` 的帧头是 13 字节：type、id、ack、length。类型包括 Regular、Ack、Disconnect、ReplayRequest、Pause、Resume、KeepAlive。未 ACK 消息入队；`replaceSocket` 把未 ACK 帧再写一遍。默认高水位 1MiB、低水位四分之一、重放缓冲 8MiB 或最老消息 45 秒，超过就放弃整个协议会话，让上层改走 `subscribe(base)`。心跳 5 秒，20 秒无 ACK 则断开。注释明确：进了 `send()` 的帧不丢；丢弃发生在进 RPC 之前。
3. 自动重连在 `packages/rpc/src/remote.ts` 的 `RemoteAgentConnection`：延迟序列 `0,5,5,10,10,10,10,10,30` 秒，成功后 `replaceSocket`。这是远程 authority 的连接，不是浏览器 `/ws`。
4. `packages/server/src/http.ts` 的 `setupChannelServer` 使用的是 `SocketProtocol`，没有 `PersistentProtocol`。`/ws` 固定 `web-remote-replayable`，`/ws/host` 固定 `desktop-continuous`。浏览器这条链路的恢复靠会话订阅，不靠帧 ACK。stdio Agent（`server/src/stdio.ts`）同样是 `SocketProtocol`，stdout 只承载帧。

Xueness：

- v1 SSE 的 `id` 是派生 `seq`。文档写了可用 Last-Event-ID 语义，但第 1 节的 cursor 规则使「带着旧 seq 回来」在 journal 被改写时并不安全。实验 cursor token 把前缀哈希放进 SSE id，默认关闭，且不在 v1 路由上。
- 模型 delta 的 SSE id 是 `streamId:nextCursor`。cursor 超过该流长度是 400，不是静默空页。连接最多约 30 秒，这是短轮询式续传，没有未 ACK 帧重放。
- app-server 父进程断开后，`_Frames.send` 把管道关闭记下来并停止再写；已经启动的 turn 会继续跑到路由返回。没有替换管道并重放未确认帧的协议。
- 会话租约是本机文件锁。进程崩溃后锁会随关闭释放，但没有「订阅在另一个进程里，进程重启必须重订」的通知。

差距：不缺「断线之后还能把正文读完」——delta 偏移和 journal 已经能做到。缺的是与直播同一语义的重放，以及传输层在远程套接字上的有界重放。也不应把上游 HTTP `/ws` 误读成已经有 ACK；那条路径故意把可靠性放在日志层。

若以后做：先做第 1、2 节的订阅与命令查询，再考虑要不要给远程套接字加 ACK。重放缓冲必须有字节和时间上限，超限放弃会话并要求 resync，避免锁屏期间内存无界增长。新行为默认关闭。本轮没有新接口。

## 5. 工具执行与审批：协议回合和规则优先级

Xueness 的默认拒绝和一次性批准应当保留。这里弱的是「同一次调用如何被回答」，不是「有没有批准」。

上游批准在 CLI `permission/service.ts`，经会话事件和所有者命令露出：

- `zcodeAgent.ts` 的服务事件里有 `permission.request`。回答走 `respond_permission`，交互也可以走 v4 `resolveInteraction`。
- `checkPermission` 的可见顺序：计划模式切换单独处理；要求用户交互的工具先看 disallow 再 ask；声明 `alwaysAsk` 的工具不能被模式放行绕过；然后 `yolo`（且不在 plan）直接 allow；保留的 `auto` 模式一律 deny；之后才是 `disallowedTools`、项目 deny、项目 ask、plan 只读。文件里的注释写明：对非 alwaysAsk 工具，yolo 目前先于 `disallowedTools`。这是上游顺序问题，不要抄。
- 项目规则可以按工具和 subject 做 allow / ask / deny。会话级始终允许和工具自报 alwaysAsk 是另外的层。
- 连接作用域把权限弹窗限制在桌面 continuous 的 terminal-client。replayable 附着只能消费可恢复的对话事实，不能弹出本机权限窗，也不能订阅进程资源、MCP 遥测或 CUA 观察。`http.ts` 还把 Provider Provisioning 的写入从非桌面连接上拿掉，即使对方知道频道名也只能得到一个抛错的桩。

Xueness `WebGate._check`：

- 路径类工具先做工作区 jail；plan 草稿是唯一的工作区外写例外，比较走 `write_lock` 的主机路径身份。
- `disallow` 在模式放行之前。`mode == "plan"` 与 `permission_mode == "plan"` 都在批准查找之前拒绝写、改、执行、MCP 和网页工具。
- `yolo` 放行除远程 SSH 以外的上述种类。远程 SSH 的 subject 必须是带 `connection`、`connection_digest`、`argv` 的 JSON，由 `plan_mode.is_remote_exec_subject` 识别。
- `edit` 放行 write/edit，其它种类仍要一次性批准。
- 批准表是 `session -> kind -> {tool_call_id: subject}`。id 和 subject 都匹配才消费并写审计；消费后从内存表删除。
- 模型看到的是拒绝结果（`approval_required` 或 `plan_mode_denied`）。用户事后对 pending denial 授权，再由 `replay_approved` 在下一轮运行里执行。这不是同一次工具调用上的 accept/decline/cancel。
- 没有项目级 allow/ask/deny 规则文件，也没有「这个 subject 在本会话内始终允许」。hooks 可以在工具前后观察，但不能代替这套规则优先级。
- 桌面和浏览器打的是同一套 HTTP。没有「只有受信宿主能弹原生权限、重放客户端只能看事实」的通道分割。

差距：批准是安全的，但是慢半拍（拒绝、再授权、再跑），并且 `yolo` 除远程命令外没有 alwaysAsk 逃生口。多端以后如果共用这条 HTTP，手机重放会和本机批准按钮看到同一份 pending 列表，没有上游那种角色裁剪。

若以后做：保持一次性 subject 绑定、审计和「远程命令即使完全访问也要单次确认」。可以加实验中的项目规则和 alwaysAsk，默认关闭，规则拒绝必须压过 yolo。不要实现上游那种 yolo 先于 disallow 的顺序。交互回复若要并进同一次调用，必须仍由 Gate 执行，而不是由客户端回传「已允许」。本轮没有新接口。

## 6. Host capability：一次性票据把受信宿主和重放客户端分开

在仍然只绑定 loopback、只有一个本机客户端时，这项的日常价值低于前五项。一旦同一后端要同时服务桌面和另一个表面，它就是安全边界，所以排在远程部署之前。

上游 `packages/server/src/hostCapability.ts`：

- `createHostCapabilityStore` 默认 TTL 30 秒。票据默认是 32 字节随机数的 base64url，只放在该 HTTP 进程的内存 Map 里。
- `issue` 时顺手删过期项。`consume` 在判断之前就 `delete`：成功、过期、重放都先作废，只有第一次且未过期的消费得到 trusted-host。注释写明旧的 mode header 是可重放的长期提权，所以不能再靠它升级。
- `http.ts`：`POST /api/rpc-host-capability` 签发。`GET /ws` 永远是 terminal-client / replayable，浏览器自带的旧 header 不能把自己提升成宿主。`GET /ws/host` 要带 `ZCODE_RPC_HOST_CAPABILITY_HEADER`，消费失败返回 401。
- `GET /api/server-info` 公布 `serverId`、协议版本和能力位：`desktopContinuous`、`websocketRpc`，以及可选的 `processResourceTelemetry`。注释要求旧服务器缺能力时必须先声明再订阅，避免未知事件打进对端读循环。
- 可选鉴权令牌只保护 `/ws`、`/ws/` 和 `/api/`。静态页面可以用 query 里的 token 换 HttpOnly cookie。静态资源本身不在这道令牌后面。路径用 `relative` 判断，拒绝跳出静态根。

Xueness：

- 没有 WebSocket RPC，也没有 capability 票据。
- 桌面令牌在 `desktop/host.py` 启动时检查长度和十六进制，然后整个进程生命周期有效，每个请求都带同一个头。令牌从环境变量弹出，避免子进程继承，但拿到令牌的渲染进程在窗口活着时可以一直用。
- 浏览器模式靠 loopback、Host/Origin 和 CSRF，不靠这张桌面票据。两者能力几乎相同：同一个路由表、同一份批准列表。
- app-server 的 `initialize` 明确回报 `networkListener: false`、`hostOriginCsrf: false`，以及「只有父进程受信」。这和上游 stdio「stdout 只放帧、日志走 stderr」类似，但没有 hello/ack 之后的角色位。

差距：缺少「短时、一次、失败也作废」的宿主升级，也缺少按角色隐藏原生对话框、资源采样和凭据下发。现有桌面令牌加 loopback CSRF 对本机单窗口是够的；它不适合原样拿到局域网或第二个客户端上。

若以后做：票据只能作为桌面插件里的实验入口，默认不签发。消费失败不能降级成普通会话却保留宿主角色。不要用长期 header 代替票据。静态页面与 API 的鉴权边界如果要做，必须比上游更严：Xueness 现在的安全假设是 API 根本不监听非 loopback。本轮没有新接口。

## 7. 远程 harness：在另一台机器上跑同一套 Agent，而不是发一条 SSH 命令

这项成本最高，而且和「默认只信任本机」的安全故事冲突最大，所以排最后。没有第 6 节的角色分离之前，不应当做。

上游 `packages/server/src/remote/`：

- `IRemoteBackend`：`detect`、`upload`、`exec`、`exists`、`readFile`，可选断开事件和运行时代理解析。实现分 Docker、WSL、SSH。
- `connectRemote` 先按白名单挑远程环境变量（产品基址、动态工作流档位等），再部署、握手。部署可跳过。`AbortSignal` 可取消连接。stdio 关闭回调交给上层回收。
- `handshake.ts` 从远端 stdout 里跳过 SSH banner，直到解析到 hello；非法 hello 失败时把截断到 2048 字符的 stdout/stderr 放进错误。然后写 hello-ack。剩余字节交回 RPC，避免握手把后面的帧吃掉。
- 部署侧还有锁、资源缓存、平台支持检查和「远端已经是同一份构建就不要重复上传」的判断。`harness/remote` 只是开发时起 SSH 容器的说明，不是这套逻辑的替代。
- HTTP：`POST /api/connect-remote` 校验 body 后创建连接，返回一次性 id。`GET /ws/remote/:id` 取出后立刻从 Map 删除，只桥接 file、git、system、terminal 四项服务，并用 replayable 模式包成 ChannelServer。一个 id 不能给第二个 WebSocket。
- `AGENTS.md` 要求远程链同时传递 `workspaceIdentity` 和 `remoteSessionId`，不能只按路径匹配。身份 key 是 `workspaceIdentity` 去空白，否则退回路径。

Xueness `bundled_plugins/remote/`（`defaultEnabled: false`）：

- 连接配置是状态目录里的 `remote-connections.json`，拒绝符号链接，上限 100 条。字段只有 id、host、user、port、directory、system。
- 执行是本机 `ssh` 子进程加一条 `cd && exec argv`，超时 40 秒，环境变量按密钥样式剔除。Windows 远端直接拒绝，因为引用规则是 POSIX 的。
- 没有上传 Agent、没有远端进程生命周期、没有 file/git/terminal 服务桥、没有 workspaceIdentity、没有 hello 协议。
- 会话如果带了 `remote_connection`，运行路由会关掉本机 skills/hooks/mcp/subagents 和一组本地工具名。这是「不要在错误的机器上跑本地工具」，不是远端 harness。
- app-server 是给本机 IDE 父进程用的，不会被部署到 SSH 主机上。

差距：远程今天是「经批准的一条命令」。上游是「把服务端部署到目标环境，再把文件、Git 和终端服务桥回来，会话身份不依赖路径字符串」。WSL 与 Docker 后端、资源包缓存和官方插件在远端的修复逻辑都没有对应物。其中厂商账号、官方插件 CDN 和计费不在 Xueness 的目标里。

若以后做：继续放在默认关闭的 remote 插件里，用实验开关再包一层，未开启时不部署、不上传、不新开端口。Windows 远端在有与 POSIX 等价的安全引用之前保持拒绝。身份要单独的不透明 id，文件操作仍用路径并走现有 jail。不要移植上游的商业端点、设备 id 或官方插件权限修复。本轮没有新接口。

## 建议的实现顺序

只作为后续排期，本轮不实现。

1. 在不改 v1 黄金契约的前提下，为会话增加可选的 epoch 日志和 resync。默认关闭。
2. 为发送、停止、批准回复增加可选的命令 id 和查询。默认关闭。停止的进程树补全可以单独作为现有 stop 的修复，不必等新协议。
3. 有第二个客户端表面时，再加一次性 host capability，并按角色裁剪批准与资源事件。
4. 远程 Agent 部署放在最后，并维持 remote 插件默认关闭。

每一项新行为用 `experimental.*` 或插件设置，默认关，带测试和文档。平台差异只扩展现有 `process_runtime`、`write_lock` 和终端/桌面里的平台 helper。

## 明确不移植

- 上游产品名、账号、组织配额、官方市场 CDN 和计费接口。`CONTEXT.md` 的商店词汇也不直接变成 Xueness 的市场实现。
- `yolo` 先于 disallow 的批准顺序。
- 把 HTTP `/ws` 说成已有帧级 ACK。上游浏览器链路用的是 `SocketProtocol`。
- 无上限的重放队列。上游自己用 8MiB 和 45 秒放弃会话。
- Computer Use 占位、厂商遥测和把任务队列放进 relay。`AGENTS.md` 要求 relay 不保存业务状态。
- 为对齐 `architecture-policy.yaml` 去把现有 Python 模块拆成 400 行。那条策略只管上游 TypeScript 的 managed 模块；Xueness 的结构门禁仍是 `tools/check_plugin_architecture.py`。

## 参考文件

上游（只读，v3.14.3 / `29628c9`）：

- `AGENTS.md`、`CONTEXT.md`、`architecture-policy.yaml`
- `packages/rpc/src/index.ts`、`protocol.ts`、`persistent-protocol.ts`、`remote.ts`
- `packages/server/src/http.ts`、`hostCapability.ts`、`stdio.ts`、`entry-stdio.ts`
- `packages/server/src/remote/index.ts`、`backend.ts`、`connect.ts`、`handshake.ts`
- `packages/services/src/zcode-agent/zcodeAgent.ts`、`zcodeAgentConnectionScope.ts`、`zcodeSessionEventCoalescer.ts`
- `packages/services/src/session/sessionRealtimePort.ts`
- `packages/services/src/process/processTreeTerminator.ts`
- `packages/shared/src/server-remote.ts`
- `packages/shared/src/zcode-protocol-v4/core.ts`、`transport.ts`、`profiles.ts`、`command.ts`
- `apps/zcode-cli/packages/core/src/permission/service.ts`
- `harness/remote/README.md`

Xueness：

- `xueness/events.py`、`docs/xueness-event-protocol-v1.md`
- `xueness/web.py`（`WebGate`、Host/Origin/CSRF）
- `xueness/session_lease.py`、`xueness/core.py`（`should_stop`）
- `xueness/bundled_plugins/sessions/deltas.py`、`events_cursor.py`、`http_routes.py`、`plan_mode.py`、`answer_question.py`
- `xueness/bundled_plugins/shell/tooling.py`
- `xueness/bundled_plugins/subagents/cancel_one.py`
- `xueness/bundled_plugins/desktop/host.py`
- `xueness/bundled_plugins/remote/app_server.py`、`plugin.py`
- `docs/zcode-conversation-parity.md`（点读一致性，不是本文件的订阅协议）
