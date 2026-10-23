# 第 7 轮接口契约：workflows 与 automation

本文件是并行开发的唯一接口依据。**不要修改本文件**；发现契约问题用 `send_message` 报告 lead。

## 0. 硬约束

- 每个 `.ts` 文件 ≤ 400 行（`npm run check:lines`）。
- 插件源码只能 import：`node:` 内建、`@xueness/contracts`、`@xueness/kernel`、`@xueness/engine-tools`、`@xueness/sessions`、`@xueness/providers`、`@xueness/agent`、本插件目录内的相对路径。**禁止跨插件 import。**
- Python 语义要逐字对齐：错误消息原文、状态码、JSON 字段名与类型。用 `@xueness/contracts` 的 `py*` 助手（`isDict`、`pySlice`、`pyStrip`、`pyLen`、`pyTruthy`、`pyEquals`、`pyJsonDumps`、`pyFloatValue`、`isPyIntValue`、`pyCodeCompare`、`PyValueError`）。
- Python 的 `ValueError` → `PyValueError`；`FileNotFoundError` → 由 `node:fs` 抛出，用 `isMissing()` 判定。
- 只写自己名下的文件。

## 1. 文件归属

### workflows（`ts/plugins/workflows/`）

| 文件 | 归属 | 状态 |
| --- | --- | --- |
| `src/plan.ts` | 已有，**冻结** | 137 行 |
| `src/store.ts` | 已有，**冻结** | 216 行 |
| `src/state-file.ts` | 已有，**冻结** | 36 行 |
| `src/governor.ts` | 已有，**冻结** | 114 行 |
| `src/dsl.ts` | 子代理 A | 待写 |
| `src/saved-library.ts` | 子代理 B | 待写 |
| `src/dynamic-runs.ts` | 子代理 C | 待写 |
| `src/execute-command.ts` | 子代理 D | 待写 |
| `src/drive.ts` | 子代理 E | 待写 |
| `src/execute-agent.ts` | 子代理 E | 待写 |
| `src/expert.ts` + `src/expert-phases.ts` | 子代理 F | 待写 |
| `src/tools.ts` | 子代理 G | 待写 |
| `src/http.ts` | 子代理 G | 待写 |
| `src/index.ts` | lead | 待写 |

### automation（`ts/plugins/automation/`）

| 文件 | 归属 | 状态 |
| --- | --- | --- |
| `manifest.json` / `package.json` | lead | 已写 |
| `src/cron.ts` | 子代理 H | 待写 |
| `src/store.ts` | 子代理 H | 待写 |
| `src/off-peak.ts` / `off-peak-queue.ts` / `off-peak-settings.ts` | 子代理 I | 待写 |
| `src/scheduler.ts` / `src/http.ts` / `src/tool.ts` | 子代理 J | 待写 |
| `src/index.ts` | lead | 待写 |

## 2. 已有模块的导出（不得改动）

```ts
// src/plan.ts
export type Row = Record<string, unknown>;
export const ID: RegExp;                 // /^[a-f0-9]{32}$/
export const NODE: RegExp;               // /^[A-Za-z0-9_-]{1,64}$/
export const ACTIVE: ReadonlySet<unknown>;  // queued/running/stopping/pausing
export function nowSeconds(): number;
export function stamp(): unknown;        // pyFloatValue(nowSeconds())
export function resolvePath(path: string): string;
export function isDirectory(path: string): boolean;
export function isInside(root: string, path: string): boolean;
export function validatePlan(value: unknown, rootPath: string): Row;
export function workflowPlanDigest(record: Row): string;
export function workspaceFingerprint(rootPath: string, stateDir?: string): string | null;

// src/store.ts
export type WorkerLauncher = (store: WorkflowStore, wid: string) => void;
export function setWorkerLauncher(launcher: WorkerLauncher | null): void;
export class WorkflowStore {
  constructor(state: string, options?: { launcher?: WorkerLauncher });
  readonly state: string;
  readonly directory: string;
  readonly launcher: WorkerLauncher | null;
  path(wid: unknown, suffix?: string): string;
  lock(wid: unknown, suffix?: string, options?: { blocking?: boolean; shared?: boolean }): HeldFileLock;
  withLock<T>(wid: unknown, suffix: string, options: { blocking?: boolean; shared?: boolean }, body: () => T): T;
  load(wid: unknown): Row;
  loadUnlocked(wid: unknown): Row;
  save(record: Row): void;
  saveUnlocked(record: Row): void;
  update(wid: unknown, change: (record: Row) => void): Row;
  event(record: Row, kind: string, fields?: Row): void;
  create(planValue: unknown, rootPath: string, reuse?: unknown, ownerSession?: unknown): Row;
  amend(wid: unknown, planValue: unknown, rootPath: string): Row;
  actorAwaiting(wid: unknown, nodeId: unknown, answer: unknown): { record: Row; sessionId: string };
  actorAnswered(wid: string, nodeId: string, answer: string): Row;
  list(): Row[];
  launch(wid: unknown, approved?: boolean, allowReal?: boolean, expectedDigest?: string | null): Row;
  control(wid: unknown, action: unknown, concurrency?: unknown): Row;
  log(wid: unknown, node: unknown): { output: string; truncated: boolean };
}
export function isMissing(error: unknown): boolean;

// src/state-file.ts
export function isSymlink(path: string): boolean;
export function ensurePrivateDirectory(path: string, message: string): void;
export function writeJsonAtomic(directory: string, prefix: string, destination: string, value: unknown): void;
export function readJson(path: string): unknown;
export function lockPath(path: string, options?: SyncLockOptions): HeldFileLock;
export const RECORD_LOCK_SECONDS = 60;

// src/governor.ts
export class ProviderGovernor {
  constructor(state: string, defaultLimit?: number);
  enqueue(key: string, owner: string, ticket: string): void;
  tryAcquire(key: string, ticket: string): boolean;
  finish(key: string, ticket: string, success?: boolean | null, options?: { congestion?: boolean; retryAfter?: number | null }): void;
  cancel(key: string, ticket: string): void;
}
```

## 3. 新增模块契约

### 3.1 `src/dsl.ts`（子代理 A）

```ts
export function compileWorkflowScript(source: string, root: string, defaultName?: string): Row;
```

返回 `{ name, nodes }`，`nodes[i]` 形如 `{ id, kind: "agent", prompt, needs?, cwd?, timeout?, provider_id?, model?, writable?, phase? }`。
移植 `xueness/bundled_plugins/workflows/dsl.py`。Python 用 `ast.parse`，TS 必须手写递归下降解析器，只接受该 DSL 子集（`phase()` 语句、`agent()`/`parallel()`/`pipeline()`、简单赋值、裸名字引用、可选的 `await` 前缀）。
**错误消息必须与 Python 逐字一致**（见 `dsl.py` 全文）。

### 3.2 `src/saved-library.ts`（子代理 B）

```ts
export const NAME: RegExp;
export const MAX_DESCRIPTION = 500;
export function validateName(value: unknown): string;
export function templatePlanDigest(plan: Row): string;
export function sourcePlan(stateDir: string, workflowId: unknown, workspace: string): Row;
export function latestRunPlan(stateDir: string, workspace: string): Row;
export class SavedWorkflowLibrary {
  constructor(state: string);
  readonly state: string;
  path(name: unknown): string;
  save(plan: Row, name: unknown, root: string, options?: { description?: unknown; overwrite?: unknown; source?: Row }): Row;
  load(name: unknown): Row;
  list(): Row[];
  view(record: Row): Row;
}
```

移植 `saved_library.py`（195 行）。目录布局、保留名、原子写、锁必须与 Python 一致，以便两边互读。

### 3.3 `src/dynamic-runs.ts`（子代理 C）

```ts
export class DynamicRunError extends PyValueError {
  readonly reason: string; readonly detail: string; readonly status: number;
  payload(): Row;
}
export function ownerSessionId(session: Row | null | undefined): string | null;
export function listRuns(stateDir: string, sessions: SessionStore, sid: string): Row;
export function cancelRun(stateDir: string, sessions: SessionStore, sid: string, runId?: unknown): Row;
export function resumeRun(stateDir: string, sessions: SessionStore, sid: string, runId: unknown, options?: { approved?: boolean; allowReal?: boolean }): Row;
export function invoke(stateDir: string, sessions: SessionStore, action: string, sid: string, runId?: unknown, options?: { approved?: boolean; allowReal?: boolean }): Row;
export function parseInvocation(argument: string): [string, string | null];
export function chat(stateDir: string, sessions: SessionStore, session: Row, argument: string): Row;
export interface DynamicHttpOptions { stateDir: string; sessions: SessionStore; allowedRoots(): readonly string[]; allowReal?: boolean; }
export function dispatchDynamicRuns(method: string, parts: readonly string[], query: Row, data: Row, options: DynamicHttpOptions): [number, unknown] | null;
```

移植 `dynamic_runs.py`（279 行）。`dispatchDynamicRuns` 只处理 `parts[2] === "dwf"` 的路径，其它返回 `null`。

### 3.4 `src/execute-command.ts`（子代理 D）

```ts
export interface RunControl {
  /** 当前 control 字段：run | pause | cancel。 */
  control(): string;
  /** 桌面宿主已消失（POSIX）。 */
  ownerGone(): boolean;
}
export function executeCommandNode(store: WorkflowStore, record: Row, spec: Row, control: RunControl): Promise<Row>;
```

移植 `workflows.py` 的 `_execute` 命令分支 + `_terminate` + `windows.py`（85 行）。要点：工作区租约（`store.directory/.workspaces` 下的祖先共享锁 + 自身独占锁）、`PATH/HOME/TMPDIR/LANG/LC_ALL/SYSTEMROOT` 环境裁剪、日志上限 2 MB、超时与取消、Windows `taskkill /T /F`。返回行含 `status`、`exit_code`、`error`、`duration`、`log_capped`，失败时 `status: "failed"`。

### 3.5 `src/drive.ts` + `src/execute-agent.ts`（子代理 E）

```ts
// drive.ts
export type NodeExecutor = (store: WorkflowStore, record: Row, spec: Row, control: RunControl) => Promise<Row>;
export function drive(store: WorkflowStore, wid: string, execute: NodeExecutor, control: RunControl): Promise<void>;

// execute-agent.ts
export interface AgentNodeHost {
  /** 跑一个只读/可写 actor，返回 Python `run()` 的结果行。 */
  run(request: {
    prompt: string; root: string; sessionId: string | null; writable: boolean;
    providerId: string | null; model: string | null; context: string | null;
    timeoutSeconds: number; shouldStop(): boolean;
  }): Promise<Row>;
  /** 打开或新建 actor 会话，返回会话 id。 */
  ensureSession(prompt: string, cwd: string, existingId: string | null): Promise<string>;
  enabled(id: string): boolean;
}
export function executeAgentNode(store: WorkflowStore, record: Row, spec: Row, control: RunControl, host: AgentNodeHost): Promise<Row>;
```

`drive` 移植 `workflows.py` 的 `drive()`（697–774 行）：持有 `.runner` 锁、按 `concurrency` 派发、节点完成即写回、结算状态（`paused`/`cancelled`/`awaiting_user`/`completed`/`failed`）、失败时把 pending 标成 blocked、结算时重算 `cache_fingerprint`。
`executeAgentNode` 移植 `_execute` 的 agent 分支 + `_owner_permission_ceiling` + `workflow_child_writable` + `workflow_command_allowed` + governor 槽位等待。

### 3.6 `src/expert.ts`（子代理 F）

移植 `expert.py`（489 行）。必须拆成 `expert.ts` + `expert-phases.ts`，每个 ≤ 400 行。

```ts
export function validateTask(task: unknown): string;
export function expertPlan(task: string, permissionMode: string | null): Row;
export function start(stateDir: string, task: unknown, root: string, options?: Row): Row;
export function load(stateDir: string, runId: string): Row;
export function listRuns(stateDir: string, sessionId?: string | null): Row[];
export function resolveTarget(stateDir: string, options?: { sessionId?: string | null; runId?: string | null }): Row;
export function resume(stateDir: string, runId: string, options?: { answer?: unknown; allowReal?: boolean }): Row;
export function stop(stateDir: string, runId: string): Row;
export function formatStatus(record: Row): string;
export function handleSlash(argument: string, options: Row): Row | null;
export function dispatchExpert(method: string, parts: readonly string[], query: Row, data: Row, options: Row): [number, unknown] | null;
```

`start`/`resume` 需要建工作流运行；通过 `options.bridge` 拿到 `WorkflowBridge`（见 §4），不要 import workflows 的代码。

### 3.7 `src/tools.ts` + `src/http.ts`（子代理 G）

```ts
// tools.ts
export interface WorkflowToolsOptions {
  store(): WorkflowStore;
  library(): SavedWorkflowLibrary;
  stateDir: string;
  session(): Row | null;
  allowReal(): boolean;
  /** 宿主 ceiling：web 的 real provider 开关。 */
  allowRealHost(): boolean;
  /** 通过宿主回答 actor 会话；返回更新后的 workflow 行。 */
  answerActor(wid: string, nodeId: string, answer: string): Promise<Row>;
}
export function workflowTools(options: WorkflowToolsOptions): ToolDefinition[];

// http.ts
export interface WorkflowHttpOptions {
  stateDir: string;
  store(): WorkflowStore;
  sessionStore: SessionStore;
  allowedRoots(): readonly string[];
  allowReal(): boolean;
  allowRealHost(): boolean;
  answerActor(wid: string, nodeId: string, answer: string): Promise<Row>;
  expert(options: Row): [number, unknown] | null;
  dynamicRuns(method: string, parts: readonly string[], query: Row, data: Row): [number, unknown] | null;
}
export const WORKFLOW_ROUTES: readonly string[];
export function createWorkflowHttp(options: WorkflowHttpOptions): {
  routes: readonly string[];
  owns(method: string, parts: readonly string[]): boolean;
  dispatch(method: string, parts: readonly string[], query: Row, data: Row): Promise<[number, unknown] | null>;
};
```

`tools.ts` 移植 `tools.py`（243 行）的 12 个工具。注意 `gate` 必须是 `planning` 或 `exec`，`mutating`/`concurrencySafe` 必须与 `manifest.json` 一致，否则 kernel 拒绝注册。
`http.ts` 移植 `operations_api.py`（88 行）。

### 3.8 `src/cron.ts` + `src/store.ts`（automation，子代理 H）

```ts
// cron.ts
export function cronField(text: string, lo: number, hi: number): Set<number>;
export function cron(schedule: unknown): Set<number>[];
export function nextRun(schedule: string, tz: string, after: number): number;
export function validZone(tz: unknown): string;

// store.ts
export class Automations {
  constructor(state: string);
  readonly state: string;
  readonly path: string;
  list(): Row[];
  save(data: unknown, aid?: string): Row;
  delete(aid: string): Row;
  approve(aid: string, allowReal?: unknown): Row;
  run(aid: string, options?: { due?: boolean; now?: number; allowRealHost?: boolean; bridge?: WorkflowBridge }): Row | null;
}
```

移植 `scheduler.py` 的 `cron`/`next_run`/`Automations`（134 行）。`ZoneInfo` 用 `Intl.DateTimeFormat` 实现，DST 行为要对齐。

### 3.9 `src/off-peak.ts` 等（automation，子代理 I）

移植 `off_peak.py`（606 行），拆成三个文件，每个 ≤ 400 行：

```ts
export const QUEUE_FILE = "offpeak.json";
export const SETTINGS_FILE = "offpeak-settings.json";
export function windowSpan(window: Row): number;
export function inWindow(now: number, window: Row, timezoneName?: string | null): boolean;
export function nextWindowOpen(now: number, window: Row, timezoneName?: string | null): number;
export function hostIsIdle(state: string): boolean;
export function planFor(row: Row): Row;
export class OffPeakQueue {
  constructor(state: string, options?: { clock?: () => number; allowRealHost?: boolean; idleCheck?: (state: string) => boolean; bridge?: WorkflowBridge });
  list(): Row[];
  get(taskId: string): Row | undefined;
  settings(): Row;
  overview(): Row;
  add(data: unknown): Row;
  approve(taskId: string, options?: { allowReal?: unknown; confirmed?: unknown }): Row;
  cancel(taskId: string): Row;
  saveSettings(data: unknown): Row;
  tick(now?: number): void;
  runNow(taskId: string, now?: number): Row;
}
export function offPeakHttp(method: string, parts: readonly string[], data: Row, options: OffPeakHttpOptions): [number, unknown] | null;
export function offPeakTool(options: OffPeakToolOptions): ToolDefinition;
```

### 3.10 `src/scheduler.ts` + `src/http.ts` + `src/tool.ts`（automation，子代理 J）

```ts
// scheduler.ts
export class Scheduler {
  constructor(state: string, options?: { allowReal?: boolean; clock?: () => number; idleCheck?: (state: string) => boolean; bridge?: WorkflowBridge });
  close(): void;
}

// http.ts
export const AUTOMATION_ROUTES: readonly string[];
export function createAutomationHttp(options: AutomationHttpOptions): {
  routes: readonly string[];
  owns(method: string, parts: readonly string[]): boolean;
  dispatch(method: string, parts: readonly string[], query: Row, data: Row): [number, unknown] | null;
};

// tool.ts
export function offPeakCreateTool(options: OffPeakToolOptions): ToolDefinition;
```

移植 `plugin.py`（92 行）的 `dispatch` 与 `Scheduler`。

## 4. 跨插件边界：`WorkflowBridge`

automation 与 expert 需要建工作流运行，但不能 import workflows 的代码。统一用这个结构（结构类型，各自本地声明即可）：

```ts
export interface WorkflowBridge {
  create(plan: unknown, root: string, reuse?: unknown, ownerSession?: unknown): Row;
  launch(wid: string, approved?: boolean, allowReal?: boolean, expectedDigest?: string | null): Row;
  control(wid: string, action: unknown, concurrency?: unknown): Row;
  load(wid: string): Row;
  list(): Row[];
}
```

workflows 插件通过 `ctx.provide("workflows.store", bridge)` 提供；automation 通过 `inject: { required: ["workflows.store"] }` + `ctx.get<WorkflowBridge>("workflows.store")` 取得。

## 5. 宿主注入：`workflows.agent`

agent 节点需要跑模型，workflows 插件不持有 agent。宿主（`apps/server`）通过 `ctx.provide("workflows.agent", host)` 注入，结构见 §3.5 的 `AgentNodeHost`。workflows 的 manifest 声明 `inject: { optional: ["workflows.agent"] }`；没有宿主时 agent 节点返回 `status: "paused"`、`error: "real model execution is not enabled"`（与 Python `launch(allow_real=False)` 的拒绝一致）。

## 6. 验证

每个子代理只跑自己的测试：

```powershell
cd E:\models\apps\round7-wip\Xueness-0.1.8-complete-project\ts
node --test plugins/workflows/test/<你的>.test.ts
```

不要跑 `npm run check`（其它模块正在并行开发，会失败）。lead 在全部合并后统一跑。

能用 Python 对照的测试，先读 `ts/test-support/python-oracle.ts`，用 `runPythonAsync` + `pythonUnavailableReason`。
