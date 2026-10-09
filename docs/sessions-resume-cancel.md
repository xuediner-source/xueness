# 取消、重连与事件续传

实验功能，默认全部关闭。只接受设置里的布尔值 `true`。sessions 插件停用后，这些 HTTP 路由与其它会话路由一样返回 403。不修改已发布的 `xueness.events.v1` 字段，也不改 `POST /api/sessions/<sid>/stop` 在开关关闭时的响应。

思路来自 ZCode v3.14.3（只读树 `/workspace/refs/ZCode`，`29628c9`）的订阅水位、取消令牌和有界重放，没有移植其品牌或源码：

- `packages/shared/src/zcode-protocol-v4/transport.ts`：只有客户端确实持有该时刻的一致状态，才允许带 `base: { logEpoch, seq }`；否则走 snapshot。
- `packages/shared/src/zcode-protocol-v4/core.ts`：快照尾窗 60 行；`continuous` 与 `replayable` 两套交付画像，被滤掉的增量必须由后来的完整行收口。
- `packages/rpc/src/channelServer.ts`：进行中的调用持有取消令牌，对端取消时令牌触发。
- `packages/rpc/src/persistent-protocol.ts`：未确认帧有界重放，超过字节或时间上限就放弃会话，改走订阅层恢复。浏览器 `/ws` 本身不用这层 ACK。

界面开关尚未接到「设置 → 通用 → 会话实验功能」。在那之前用 `POST /api/settings/general`（沿用 Host、Origin 与 CSRF）写入下面的键。

## 事件续传 `sessions.event_resume`

设置键 `general.sessionsEventResumeEnabled`。

`GET /api/sessions/<sid>/events.resume`

| 查询 | 含义 |
| --- | --- |
| 不带 `log_epoch` 与 `seq` | 快照。默认尾部 60 条，`limit` 可加大到 500 |
| `log_epoch`（或 `logEpoch`）与 `seq` 一起 | 从该水位续传。默认每页 200，上限 500 |
| `profile` | `replayable`（默认）或 `continuous` |
| `Last-Event-ID` | 与查询水位二选一或完全相同。形式为 `<seq>.<64 位小写十六进制>` |

`logEpoch` 是「序号 1 之后、直到 `seq` 为止」的派生事件前缀哈希。序号 1 的 `session.status` 会原地变化，不进入哈希；当前 `status`、`steps`、`mode` 每次都在信封里。只追加事件时，旧水位仍然有效。压缩、编辑或缩短已读前缀则返回 **409**，`errorCode` 为 `sessions.event_resume.resync_required`，正文同时是一份新快照（`resync: true`）。序号超过当前头部同样 409，而不是空页。

`replayable` 不把 `session.status` 放进 `events`。`continuous` 仅当这条状态事件落在本页窗口里时才带上。两种画像的 `logEpoch` 相同，收口后的会话状态以信封为准。

成功正文的 `schema` 是 `xueness.events.resume.v1`。`resumeMode` 为 `snapshot` 或 `resume`。`gapBefore: true` 表示快照只是尾部，更早的行没有出现在 `events` 里。`originEpoch` 是序号 0 的水位（只取决于会话 id）。用 `seq=0` 和 `originEpoch` 可以从头分页，不把尾部快照误当成完整历史。

`Accept: text/event-stream` 时每条事件的 `id` 是该序号的水位，最后一条 `event: resume.cursor` 的 `id` 是本页的 `nextCursor`。重同步仍是 JSON 409，不会伪装成一条成功的事件流。

开关关闭时，格式合法的会话 id 也只得到 400 `sessions.event_resume not enabled`，不先查会话是否存在。`events.v1` 仍按原契约忽略超前 cursor。

## 取消回执 `sessions.cancel_receipt`

设置键 `general.sessionsCancelReceiptEnabled`。

`POST /api/sessions/<sid>/stop`（沿用 CSRF）。开关关闭时正文只有 `id`、`stopping`、`status`、`cancelled_tasks`。开关打开时在这四个字段之外增加：

| 字段 | 含义 |
| --- | --- |
| `schema` | `xueness.cancel-receipt.v1` |
| `feature` | `sessions.cancel_receipt` |
| `outcome` | `stop_requested`（会话正在跑）、`cancelled`（至少取消了一个任务）、`rejected`（有任务看起来在跑但 `cancel` 返回 false）、`idle`（没有可取消的东西） |
| `reason` | 仅 `rejected` 时为 `not_running`，仅 `idle` 时为 `nothing_running` |
| `works` | 先是会话一行（`kind: session`），再是每个当时状态为 `running` 的任务 |

会话正在跑时，总结果是 `stop_requested`，即使同时取消了任务。每个任务行仍写自己的 `cancelled` 或 `rejected`。`cancelled_tasks` 仍是注册表里的原始 id，回执里的 `workId` 只保留可打印字符并截到 80。回执不包含任务摘要或提示词。

找不到会话仍是 404。插件停用仍是 403，缺 CSRF 仍是 403。状态码不因这张回执改变。

## 取消传播 `sessions.cancel_propagate`

设置键 `general.sessionsCancelPropagateEnabled`。sessions 插件停用时视为关闭。

模型调用卡在响应体上时，停止原先要等到下一个文本增量、步骤边界，或套接字自己超时。开关打开后，运行循环在这一次 `request_model`（包括同一次调用的溢出重试）周围安装探针。探针约每 0.2 秒看一次停止标志；为真时，用 providers 里已有的套接字关闭助手关掉本次响应的副本，读操作以 `ProviderCancelled` 返回。这个异常带有与协作停止相同的标记，会话落到 `stopped`，并且不会被当成传输失败再请求一次。

探针回调自己抛错时，原异常回到读取线程，不包装成供应商错误，也不重试。

开关关闭时不创建探针线程，`stream` / `complete` 的参数也不变。响应头仍由原来的打开超时限制（普通请求 40 秒，轻量请求走它自己的截止时间）；这次补上的是头已经返回、正文却不再前进的情况。

`providers/cancel_watch.py` 只提供这次传输中断，不表示新的模型能力。功能登记在 `sessions.cancel_propagate`。

## stdio 帧重放 `remote.frame_replay`

设置键 `general.remoteFrameReplayEnabled`。remote 插件默认关闭；本开关再默认关闭。服务器把设置缓存最多一秒，避免每个事件都读盘。

只影响 `xueness app-server` 的 stdio JSON-RPC。不改 `protocolVersion`。浏览器 `/ws` 没有这层确认。开关关闭时帧里没有 `xuenessSeq`，方法表也不含 `transport/ack`、`transport/replay`、`transport/status`。

开关打开后，每条写出的帧带整数 `xuenessSeq`（从 1 递增）。对端用入站对象上的 `xuenessAck`，或 `transport/ack` 的 `ack`，确认已经拿到的序号。布尔值不是整数，会被拒绝。序号超过已发送的最大值也会被拒绝。`transport/replay` 把尚未确认的帧按原序号再写一遍。`transport/status` 返回当前水位。

未确认字节超过 1 MiB 时，事件泵暂停新的 `session/event`，并且不推进游标。确认降到高水位的四分之一以下后继续。`turn/started` 和 `turn/finished` 在饱和或放弃之后仍然写出，包括刚好触发放弃的那一次发送。硬上限是 8 MiB，最老的未确认帧超过 45 秒也会放弃。放弃会清空队列，只发一条 `transport/abandoned`（`reason: replay_limit`）。触发放弃的那条 `session/event` 以及之后的 `session/event` 都不写出、不再重放，事件泵也不把游标移过没送达的序号。没有 5 秒心跳，也没有独立的确认超时线程；45 秒是在下一次发送或接收时检查的。放弃之后要从事件日志恢复，而不是继续要这一段帧。

## 本轮没有做的相邻缺口

- 命令幂等（同一次调用重复提交不执行第二次）。
- 进程创建时间身份。回收已退出的组长 pid 不能用来寻找孙进程，查不到也不能当成已经退出。见 `xueness/process_runtime.py` 的 `terminate_process_tree`。
- Host capability 票据，以及向远程机器部署 Agent。
- 冻结的 `xueness.events.v1` 在 cursor 超过头部时仍返回空页。续传要用上面的实验路由。
