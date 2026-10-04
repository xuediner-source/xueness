# 会话消息队列 / Session message queue

当会话正在运行时，可以把后续消息加入该会话的 FIFO 队列。当前轮次结束后，运行器按提交顺序把每条消息作为独立用户轮次执行。队列只保存用户输入与安全的已准备上下文元数据；它不会授予工具权限，也不会把排队文本当作工具结果或完成证据。

## HTTP 接口

- `POST /api/sessions/{sessionId}/queue`，请求体为 `{"text":"..."}`，或 `{"text":"...","prepared_token":"..."}`。成功返回 `202` 和新队列项。Composer prepared token 是一次性令牌；提交时消费并保存准备好的输入。
- `GET /api/sessions/{sessionId}/queue` 返回按顺序排列的 `queued_messages` 和最近的 `queue_history`。会话详情响应也包含这两个字段。
- `DELETE /api/sessions/{sessionId}/queue/{queueId}` 只能取消尚未被运行器领取的队列项。已领取的输入已经成为会话中的用户轮次，不能通过删除队列项撤回。

每项有稳定的队列 ID、原始用户文本、状态、提交时间和当前等待位置。成功排队的状态码为 `202`；格式或大小不合法返回 `400`，会话不存在返回 `404`，运行器已领取该项或会话状态不允许排队/取消时返回 `409`。队列最多保存 20 条待处理消息、单条 UTF-8 文本最多 6 MiB，待处理文本总量最多 12 MiB。

会话停止、等待工具批准、等待用户回答、暂停或遇到提供方错误时，运行器不会启动下一条消息。已排队消息仍保存在会话状态中；用户显式恢复运行后，未领取的队列项按原顺序继续。已领取但被停止打断的轮次通过原用户消息 ID 恢复，不会重复追加。会话归档/删除会在持有会话租约和队列锁时一并移除其队列文件；恢复会话时，已归档的队列项不会重新出现。

Tool status, evidence verification, and delivery checks are settled independently for each assistant turn. A later queued turn cannot change an earlier turn's completion from unverified to verified. The active run's provider, remote connection, and permission context stay fixed; a prepared message requesting a different model or remote connection is rejected.

验证未通过的轮次会进入 `needs_review` 并暂停队列，普通 `/run` 不会跳过这个边界。用户点击“继续执行队列”后，客户端发送 `POST /api/sessions/{sessionId}/run` 与 `{"continue_queue":true}`，允许执行下一条排队消息；此前轮次仍保留未验证状态。尚未执行的暂停项可以取消，已成为当前用户轮次的项须通过停止/恢复控制。存在未完成队列时，普通新消息接口返回 409，以保持 FIFO 顺序和已领取轮次的关联。

## English

While a session is running, the client can add follow-up messages to its FIFO queue. After the current turn settles, the runner appends each queued message as a distinct user turn and executes them in submission order. Queue entries never grant tool permissions and are never treated as tool results or completion evidence.

The API is `POST /api/sessions/{sessionId}/queue`, `GET /api/sessions/{sessionId}/queue`, and `DELETE /api/sessions/{sessionId}/queue/{queueId}`. A Composer prepared token is one-use and is consumed when the queue request is accepted. Session details include `queued_messages` and recent `queue_history`. Delete succeeds only before the runner claims an item.

The queue holds at most 20 pending messages, up to 6 MiB of UTF-8 text per item and 12 MiB across pending items. Stop, pending approval, pending user question, pause, or provider failure stops draining. Pending items remain durable for an explicit resume; an interrupted claimed turn resumes from its existing user message and is not appended twice. Archiving or deleting a session removes its queue file while holding the session lease and queue lock; restoring the session does not restore archived queue entries.
