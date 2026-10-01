# Xueness 工作台契约（第三批冻结）

> 第二十三批扩展（2026-09-30）：本文件下文保留第三批基线。原生首页现为 Xueness 工作台；公开运行只接受配置模型。`createSession` 追加可选 `{root, prepared_token}` 与 `onCreated`，`sendTurn` 追加可选准备 token，原有参数顺序兼容。两者在保存成功、后续运行失败时返回 `{ok:false,error,accepted:true,id?}`：界面应清空已接收的草稿并刷新记录，通过“重试运行”恢复，不能再次追加相同消息。会话详情增加模型选择、权限、浏览器与远程连接摘要；输入准备的新接口见 [开始界面说明](xueness-start-interface.md)。

日期：2026-09-27。本文件冻结**第三批**的接缝：Xueness 自有的工作台数据层，以及
UI 层依赖的接口。UI 与数据层由不同子代理并行实现，因此本契约是双方唯一真源。

目标闭环（每个控件都要有真实往返）：
**任务列表 → 选中 → 时间线（v1 事件）→ 审批待办 → 发送新回合 → 刷新**。

不改动既有 `main.tsx` 的 ZCode `Root` 装配；工作台作为 Xueness 自有组件挂在旁侧，
`RunControls` 保留。第三批结束后 ZCode 壳仍可共存。

## 1. 真实 API（已存在，不得改动后端）

| 用途 | 方法/路径 | 请求 | 响应要点 |
|---|---|---|---|
| 会话列表 | `GET /api/sessions` | — | `{ sessions: [{id, task, status}] }` |
| 会话详情 | `GET /api/sessions/{id}` | — | `WorkbenchSession`（见 §3） |
| 时间线 v1 | `GET /api/sessions/{id}/events.v1?cursor&limit` | — | `{events, cursor, nextCursor, head, hasMore}` |
| 审批 | `POST /api/sessions/{id}/approvals` | 见 §4 | `{approved:{...}}` 或 `400 {error}` |
| 追加回合 | `POST /api/sessions/{id}/messages` | `{text}` | `{...session}` 或 `400/409 {error}` |
| 运行 | `POST /api/sessions/{id}/run` | `{provider, mode, steps, allow_*?}` | run 结果信封 |
| 回答问题 | `POST /api/sessions/{id}/answer` | `{answer}` | `{...session}` 或 `400/409` |
| 新建会话 | `POST /api/sessions` | `{task, root?}` | `{id, ...}` |
| 文件列表 | `GET /api/sessions/{id}/files` | — | `{files:[{path,size}], truncated, count}` |
| 文件预览 | `GET /api/sessions/{id}/file?path=…` | — | `{path,size,truncated,text}` |

所有 POST 需要同源 `X-CSRF-Token`（`GET /api/csrf` 取），`credentials: "same-origin"`。

## 2. 数据层接口（`webapp/src/xuenessWorkbench.ts` 必须逐字导出）

```ts
import type { RunChoices } from "./xuenessBridge";
import type { XuenessEventV1 } from "./xuenessEvents";

export type PendingApproval = {
  tool_call_id: string;
  name: string;     // "write" | "edit" | "exec" | "mcp__*"
  subject: string;  // 相对路径 | exec 的 canonical argv JSON | mcp subject
  preview: string;
};

export type WorkbenchSession = {
  id: string;
  task: string;
  root?: string;
  status: string;
  steps: number;
  mode: string;
  completion?: { verified?: boolean; summary?: string; evidence?: unknown[] } | null;
  todos?: unknown[];
  pending_question?: string | null;
  pending: PendingApproval[];
  approved: { write: string[]; edit: string[]; exec: string[]; mcp: string[] };
  changed_files: string[];
};

export type SessionSummary = { id: string; task: string; status: string };

export type TimelinePage = {
  events: XuenessEventV1[];
  cursor: number;
  nextCursor: number;
  head: number;
  hasMore: boolean;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
```

函数（全部 async，全部在失败时返回 `{ok:false,error}` 而**不抛**，除了 `toTimelineRows` 这类纯函数）：

```ts
export function listSessions(): Promise<Result<SessionSummary[]>>;
export function loadSession(id: string): Promise<Result<WorkbenchSession>>;
export function loadTimeline(id: string, cursor?: number, limit?: number): Promise<Result<TimelinePage>>;
export function approvePending(id: string, pending: PendingApproval): Promise<Result<string>>;
export function createSession(task: string, choices?: RunChoices): Promise<Result<string>>;
export function sendTurn(id: string, text: string, choices?: RunChoices): Promise<Result<void>>;
export function answerQuestion(id: string, answer: string): Promise<Result<void>>;
export function runSession(id: string, choices?: RunChoices): Promise<Result<void>>;
export function loadFiles(id: string): Promise<Result<{ files: { path: string; size: number }[]; truncated: boolean; count: number }>>;
export function loadFilePreview(id: string, path: string): Promise<Result<{ path: string; size: number; truncated: boolean; text: string }>>;

// 纯视图模型，无 IO
export type TimelineRow =
  | { kind: "user"; seq: number; turnId: string; text: string }
  | { kind: "assistant"; seq: number; turnId: string; text: string }
  | { kind: "tool"; seq: number; turnId: string; toolCallId: string; name: string; subject: string;
      status: "running" | "ok" | "error"; error: string; errorCode: string }
  | { kind: "completion"; seq: number; verified: boolean; summary: string }
  | { kind: "pending_question"; seq: number; question: string };

export function toTimelineRows(events: XuenessEventV1[]): TimelineRow[];
```

## 3. `WorkbenchSession` 形状

直接来自 `GET /api/sessions/{id}`，字段名逐字对应（`pending_denials` 的每一项都带
`tool_call_id / name / subject / preview`）。`approved` 是四个字符串数组的字典。

## 4. 审批请求构造（易错，单测必覆盖）

`approvePending` 按 `pending.name` 构造请求体：

| name | 请求体 |
|---|---|
| `write` / `edit` | `{ kind: name, subject, tool_call_id }` |
| `exec` | `{ kind: "exec", argv: JSON.parse(subject), tool_call_id }` |
| `mcp__*` | `{ kind: "mcp", tool_call_id }`（subject 由服务端从 journal 取，客户端不得发送） |
| 其它 | 返回 `{ok:false, error:"unsupported approval kind"}`，不发请求 |

`subject` 为空、`exec` 的 subject 不是合法 JSON 数组、或 `tool_call_id` 为空 → 返回
`{ok:false, error}` 且**不发请求**。

## 5. 时间线视图模型（易错，单测必覆盖）

`toTimelineRows` 把 v1 事件投影为行：

- `turn.user` → `{kind:"user", turnId, text: preview}`
- `assistant.text` → `{kind:"assistant", turnId, text: preview}`
- `tool.call` → `{kind:"tool", status:"running", ...}`
- `tool.result` → 若存在同 `toolCallId` 的 tool 行则**就地升级**该行
  （`status = ok ? "ok" : "error"`，带上 `error`/`errorCode`），不新增行；
  找不到配对就新增一行并直接给终态。
- `session.completion` → `{kind:"completion", verified, summary}`
- `session.pending_question` → `{kind:"pending_question", question}`
- `session.status` → **不产生行**（它描述会话而非时间线内容）

行顺序 = 事件 seq 升序。纯函数，不改入参。

## 6. UI 层（`webapp/src/XuenessWorkbench.tsx` 等）

- 只依赖 §2 的导出，不直接 `fetch`，不自己拼 URL。
- 组件必须是可 `renderToStaticMarkup` 的纯渲染（首屏数据作为 props 注入），
  这样无 DOM 的 node 也能验证渲染；副作用（拉取/提交）放在容器组件或 hook 里。
- 每个交互都要有真实往返：审批按钮调用 `approvePending`，输入框调用 `sendTurn`，
  时间线调用 `loadTimeline`。
- **不得**放无实现的占位按钮。

## 7. 验收口径

- 数据层：单测覆盖 §4/§5 全部易错分支；`tsc` 新文件零错误。
- UI 层：`renderToStaticMarkup` 断言关键文本；`npm run build` 成功；
  `tsc` 新文件零错误。
- 集成（父代理负责）：真实 Python 服务 + Playwright，走完 §1 闭环。
- 不因单项通过宣称全量 parity；不改后端；不部署。
