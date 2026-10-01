# Xueness Stage 4 契约：钩子接入执行链路

目标：让「设置页里配的钩子」**真的在任务执行的关键节点触发**——包括能**拦截**工具调用。

## 语义基线（沿用上游 7 个事件，不发明新事件）

`HookEvent`：`SessionStart` | `UserPromptSubmit` | `PreToolUse` | `PermissionRequest` | `PostToolUse` | `PostToolUseFailure` | `Stop`

本harness 的挂载点（`core.run`）：

| 事件 | 触发时机 |
|---|---|
| `SessionStart` | run 进入循环前，一次 |
| `PreToolUse` | 每个 tool_call **执行前**；可**拦截** |
| `PostToolUse` | tool_call 执行成功（`ok=True`）后 |
| `PostToolUseFailure` | tool_call 执行失败（`ok=False`）后 |
| `Stop` | run 结束（含 completed / paused / provider_error）前，一次 |

`UserPromptSubmit` / `PermissionRequest` 本轮**不挂载**（前者属于 `append_user_turn` 路径，后者被本 harness 的 Gate 取代）。`hooks.py` 仍要能按事件筛选，但 `core.run` 只触发上表 5 个。

## 退出码约定（沿用 Claude Code 约定，便于用户迁移）

- `0` → 通过
- `2` → **拦截**（仅对 `PreToolUse` 有意义）
- 其它非 0 → 不拦截，但记一条 warning

## 后端模块：`xueness/hooks.py`

```python
def load(state_dir) -> list[dict]
def select(hooks, event, subject=None) -> list[dict]

class HookRunner:
    def __init__(self, hooks, root, *, enabled=True, timeout_cap=30, output_cap=2000)
    @property
    def active(self) -> bool                    # enabled 且至少有一条 hook
    def fire(self, event, payload) -> list[dict]
    def pre_tool_use(self, tool_name, arguments) -> tuple[bool, str]
```

### 数据来源
`<state_dir>/resources/hooks/*.json`（Stage 2 `resources.py` 产物）。

### 过滤规则（`load`）
1. 跳过 symlink 条目、目录级 symlink（照 `skills.py` 写法）。
2. 跳过 `enabled == False`（缺失视为启用）。
3. 跳过 `event` 不在 7 值白名单、`command` 非字符串或为空的条目。
4. 按 `id` 升序稳定排序。
5. 单条损坏只跳过该条。

### 匹配规则（`select`）
- `event` 必须相等。
- `matcher` 缺失/空/`*` → 匹配全部。
- 否则当**正则**匹配 `subject`（`re.search`）；**非法正则 → 不匹配**并计入 diagnostics（不抛异常）。
- `PreToolUse` 传 `subject=tool_name`；其它事件不传 subject（matcher 若存在则按空串匹配）。

### 执行规则（`HookRunner.fire`）
1. `enabled=False` → 直接返回 `[]`，**不执行任何子进程**。
2. argv 构造：`[command] + (args or [])`；**绝不用 shell 字符串拼命令**（`shell=False`）。
3. `cwd` = `root`（必须存在且是目录，否则不执行该条）。
4. 事件载荷以 **JSON 写到子进程 stdin**（不塞环境变量，避免注入）。
5. 子进程环境只用最小集：`PATH` + `HOME`（不继承 `os.environ`，避免把服务端密钥泄给 hook）。
6. 超时：`min(hook.timeout or timeout_cap, timeout_cap)` 秒；超时按「非 0、非 2」处理并标记 `timeout: True`。
7. 输出捕获有上限（stdout+stderr 合并截断到 `output_cap`）。
8. 返回每条 hook 的结果 dict：
   `{"id", "event", "exit_code", "blocked": bool, "timeout": bool, "duration_ms": int, "output": str}`
   ——`blocked` 仅 `exit_code == 2` 时为 True。
9. 任何异常（OSError 等）都不得冒泡：记为该条 `exit_code: -1` 并 `output` 带错误原因。

### `pre_tool_use`
- 无匹配 → `(True, "")`。
- 有匹配：**任一** hook `exit_code == 2` → `(False, <该 hook 的 output 摘要>)`。
- 否则 `(True, <warning 摘要，可能为空>)`。

### 常量
- `HOOK_EVENTS`（7 值元组，顺序同上）
- `EXIT_BLOCK = 2`
- `DEFAULT_TIMEOUT_CAP = 30`
- `DEFAULT_OUTPUT_CAP = 2000`

### 安全要求
- 只用标准库（`json`/`os`/`re`/`subprocess`/`pathlib`）。
- 不写任何文件。
- 不跟随 symlink。
- **默认不执行命令**：只有 `enabled=True` 且 `root` 有效才跑子进程。

## 后端接入（主代理独占）

1. `core.run(...)` 新增关键字参数 `hooks=None`（`HookRunner | None`）。
   - `None` → 完全不触发钩子（默认关）。
   - `SessionStart` 在循环前；`Stop` 在**每个** return 分支前触发（含 `completed` / `needs_review` / `paused` / `awaiting_user`）。
   - `PreToolUse` 拦截时：该 tool_call **不执行**，结果记
     `{"ok": False, "error": "blocked by hook <id>", "hook_blocked": True}`，并照常写进 journal。
   - `PostToolUse` / `PostToolUseFailure` 在结果写入 journal 后触发。
   - 钩子审计写入 `session["hook_log"]`，**上限 100 条**，每条只含
     `{event, id, exit_code, blocked, timeout, duration_ms}` —— **绝不写 hook 的 stdout**（避免不可信文本落盘）。
2. `xueness/web.py` run 调用点：**仅当** 请求体显式 `allow_hooks: true` 时才构造 `HookRunner`。
   理由：钩子会执行命令，等价于预批准 `exec`，不能由浏览器静默开启。
3. `xueness/cli.py`：新增 `--allow-hooks`，同理。
4. `xueness/resources.py`：新增 **PUT 整体替换**语义 `PUT /api/resources/<kind>`，
   请求 `{"items": [...]}`，供 UI 的 `saveHooks({hooks})` 使用（上游契约是全量保存）。
   - 仅替换该 kind；`items` 里每项必须有合法 `id`；非法 → 400 且**不做任何改动**（先全量校验再落盘）。
   - 列表里不存在的旧条目被删除。
   - 需要与 `_LOCK` 配合，避免与 PATCH/POST 竞争。

## 前端（子代理 B）

1. `xuenessApi.ts` 新增并导出：
   `putResource(kind, body: {items: unknown[]}): Promise<{items: ResourceItem[]}>` → `PUT /api/resources/<kind>`。
2. `xuenessServices.ts` 新增并导出：
   `saveResourceItems(kind, items): Promise<ResourceItem[] | null>`（失败 console.warn 返回 null）。
3. `main.tsx` 的 `hooksService.saveHooks` 从 no-op 改为真调用：把入参 `hooks` 转成资源项后 `saveResourceItems("hooks", ...)`。
   转换：上游 `Hook` → 资源项需保留 `id/event/matcher/type/command/args/enabled/timeout`。
   注意 `id` 可能是 `hook-<uuid>` 或 `glm:` 前缀 → 必须先归一化成合法 slug
   （正则 `^[A-Za-z0-9._-]{1,64}$`），非法字符替换为 `-`；若归一化后为空或重复，跳过该条并 console.warn。

## 验收（硬性）

### 子代理 A
```sh
cd /Users/xuediner/.openclaw/workspace/xueness
python3 -m unittest tests.test_hooks -v
```
全绿并贴原始 `Ran N tests` / `OK`。必须覆盖：
空目录、disabled 被跳过、非法事件被跳过、matcher 正则匹配/不匹配/非法正则、
排序稳定、symlink 跳过、**不写文件**、`enabled=False` 时**不执行子进程**（用哨兵文件证明）、
退出码 2 → `blocked=True`、超时被 `timeout_cap` 夹住、输出被截断、非法命令不抛异常。

### 主代理（端到端，必须真跑子进程）
1. `PreToolUse` 钩子 `exit 2` → 工具**真的没执行**（workspace 里没有产物），journal 里该 tool 结果是 `ok: False` 且含 `hook_blocked`。
2. `PreToolUse` 钩子 `exit 0` → 工具正常执行。
3. `PostToolUse` 钩子被触发（哨兵文件被创建）。
4. `session["hook_log"]` 有条目，且**不含 hook stdout**。
5. `hooks=None` → 一个子进程都不跑。

## 冲突规避

| 子代理 | 允许写的文件 |
|---|---|
| A | `xueness/hooks.py`、`tests/test_hooks.py` |
| B | `webapp/src/xuenessApi.ts`、`webapp/src/xuenessServices.ts`、`webapp/src/main.tsx` |

**主代理独占**：`xueness/core.py`、`xueness/web.py`、`xueness/cli.py`、`xueness/resources.py`、`xueness/skills.py`、`xueness/memory.py`。
