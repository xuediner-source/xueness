# Xueness Event Protocol v1（冻结契约）

日期：2026-09-27。本文件是**第二批**的冻结合同：Xueness 自有的会话/工具事件协议。
它是 Xueness 的**真源**，ZCode V4 `ConversationSnapshot` 降级为 legacy adapter 的投影目标。

> 原则：不改动既有 legacy 路由 `/api/sessions/{id}/events`。新协议挂在**新路由**上，
> 两个消费者可以并存；旧协议字段（`__zcodeSessionActivity` 等）不得被当作真源。

## 1. 版本与命名

- 协议名：`xueness.events`
- 协议版本：`1`
- 事件 schema 标识：`xueness.event.v1`
- 响应 schema 标识：`xueness.events.v1`

新增字段只能追加；已发布字段的名字、类型、语义不可变。破坏性变更必须升 `v2`。

## 2. seq 语义（可恢复 cursor 的基础）

- 派生事件列表从 1 开始连续编号：第 i 个事件 `seq = i`。
- `seq` 对**未变动的 journal 前缀**是稳定的：同一份 session journal 反复派生，同一位置的
  `seq` 不变。这不是持久化计数器，不引入后端新状态。
- `head` = 完整派生列表的最大 `seq`（无事件时为 0）。
- 请求携带 `cursor` 时，只返回 `seq > cursor` 的事件。
- `nextCursor` = 本次返回事件的最大 `seq`；本次没有事件时等于请求的 `cursor`。
- `hasMore` = 在 `seq > cursor` 的集合里，是否还有超出 `limit` 的未返回事件。

## 3. 事件类型（v1，共 7 种）

每个事件信封的公共字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | string | 恒为 `"xueness.event.v1"` |
| `seq` | int >= 1 | 见第 2 节 |
| `sessionId` | string | 会话 id |
| `type` | string | 下表的类型名 |

类型与专属字段：

### 3.1 `session.status`
| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | 会话状态，原样透传 |
| `steps` | int | 已执行步数 |
| `mode` | string | `"build"` / `"plan"`，缺失时 `""` |

### 3.2 `turn.user`
| 字段 | 类型 | 说明 |
|---|---|---|
| `turnId` | string | 该用户轮次的稳定 id |
| `preview` | string | 截断摘要，不含文件正文 |

### 3.3 `assistant.text`
| 字段 | 类型 | 说明 |
|---|---|---|
| `turnId` | string | 同上 |
| `preview` | string | 截断摘要，最多 500 字符 |

### 3.4 `tool.call`
| 字段 | 类型 | 说明 |
|---|---|---|
| `turnId` | string | 同上 |
| `toolCallId` | string | 工具调用 id |
| `name` | string | 工具名 |
| `subject` | string | 短路径/argv 标签，最多 200 字符，**绝不含文件正文** |

### 3.5 `tool.result`
| 字段 | 类型 | 说明 |
|---|---|---|
| `turnId` | string | 同上 |
| `toolCallId` | string | 与对应 `tool.call` 配对 |
| `name` | string | 工具名；无法解析时 `""` |
| `subject` | string | 与对应调用一致（继承），可能是 `""` |
| `ok` | bool | 结果是否成功 |
| `errorCode` | string | 成功时 `""`，失败见第 4 节 |
| `error` | string | 截断错误文本，最多 120 字符 |

### 3.6 `session.completion`
| 字段 | 类型 | 说明 |
|---|---|---|
| `verified` | bool | 完成是否带证据 |
| `summary` | string | 截断摘要，最多 500 字符 |
| `evidenceCount` | int | `completion.evidence` 的条目数，缺失时 0 |

### 3.7 `session.pending_question`
| 字段 | 类型 | 说明 |
|---|---|---|
| `question` | string | 待回答的问题，最多 1000 字符 |

## 4. 错误码（稳定枚举）

`errorCode` 取值只能是下列之一，由 legacy 的 `ok` / `error` 字符串**确定性**派生：

| 条件 | errorCode |
|---|---|
| `ok == true` | `""` |
| `error`（去空白、小写）等于 `"denied"`，或以 `"denied"` 开头 | `xueness.error.denied` |
| `error` 含 `"cancel"`（覆盖 cancelled/canceled） | `xueness.error.cancelled` |
| `error` 含 `"not found"` 或 `"no such"` | `xueness.error.not_found` |
| `error` 含 `"invalid"` 或 `"required"` | `xueness.error.invalid_argument` |
| 其他非空 `error` | `xueness.error.tool_failed` |

判定顺序自上而下，先命中先返回。请求参数非法时（见第 6 节）响应体的 `errorCode`
用 `xueness.error.invalid_argument`。

## 5. 响应信封

`GET /api/sessions/{id}/events.v1`

非 SSE（默认）返回 JSON：

```json
{
  "schema": "xueness.events.v1",
  "protocolVersion": 1,
  "sessionId": "…",
  "status": "…",
  "steps": 0,
  "mode": "…",
  "events": [],
  "cursor": 0,
  "nextCursor": 0,
  "head": 0,
  "hasMore": false
}
```

`Accept: text/event-stream` 时返回 SSE，每条事件三行，块间空行：

```
id: 3
event: tool.call
data: {"schema":"xueness.event.v1","seq":3,…}

```

`id` 即该事件的 `seq`（前端断线重连可用 `Last-Event-ID` 语义，对应 `cursor`）。

## 6. 查询参数与错误

| 参数 | 默认 | 约束 |
|---|---|---|
| `cursor` | `0` | 整数，`>= 0` |
| `limit` | `200` | 整数，`1..500`，越界钳到区间内 |

- 会话不存在 → `404`，`{"error": "session not found"}`。
- `cursor`/`limit` 非整数 → `400`，`{"error": "invalid cursor" / "invalid limit", "errorCode": "xueness.error.invalid_argument"}`。
- `limit` 是数字但越界 → **不报错**，钳位（与 legacy 行为一致）。
- `cursor` 是数字但越界（大于 `head`）→ **不报错**，返回空事件列表，`nextCursor == cursor`，`hasMore == false`。

## 7. 安全不变量（不得回归）

1. 事件载荷只含截断摘要、路径/argv 标签、ok/error 标志；**绝不含文件正文**。
2. **绝不含 memory 文本**：memory 只注入 prompt，从不写入 journal。
3. 只读派生：本协议不写 journal、不改会话状态。
4. 输出由 session journal 纯函数派生，不依赖请求方提供的可执行内容。
