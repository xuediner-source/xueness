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

## 尚未在本文登记的开关

阻塞读取上的取消传播，以及 stdio 帧重放，见后续提交。它们同样默认关闭。
