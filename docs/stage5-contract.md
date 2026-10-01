# Xueness Stage 5 契约：命令 / MCP / 子智能体

三个能力一次性接入执行链路。共同原则沿用 Stage 3/4：

- **只走标准库**，不引入第三方依赖。
- **不落盘的不可信内容**：注入模型的内容进 prompt 视图；工具输出进 journal 时按上限截断。
- **有副作用的能力默认关闭**：MCP 会 spawn 进程、子智能体嵌套 run 会烧 token，都必须显式开关。
  命令是纯文本展开，无副作用，不需要开关。
- **symlink 防护**：条目级与目录级都拒绝，读文件用 `O_NOFOLLOW`。
- **审计只记元数据**，绝不写不可信 stdout。

## 一、命令（`xueness/commands.py`）

用户在聊天里发 `/name args`，把它展开成预先存好的 prompt。

```python
def load(state_dir) -> list[dict]
def expand(commands, text) -> tuple[str, dict | None]
```

### 数据来源
`<state_dir>/resources/commands/*.json`。

### `load` 过滤
1. 跳过 symlink 条目与 symlink 目录。
2. 跳过 `enabled == False`（缺失视为启用）。
3. 跳过 `id` 非字符串/空/非法（`^[A-Za-z0-9._-]{1,64}$`，排除 `.` 与 `..`）。
4. 跳过 `prompt` 与 `content` 都非字符串或都为空的条目。
5. 按 `id` 升序稳定排序。

### `expand` 规则
- 仅当 `text` **以单个 `/` 开头**且紧跟合法名字时才尝试展开。
  名字：`^/([A-Za-z0-9._-]{1,64})(?:\s+([\s\S]*))?$`。
- 找不到对应命令（或命令未启用）→ 原样返回 `(text, None)`。
- 命中 → 取命令正文（`prompt` 优先，否则 `content`）：
  - 正文含 `$ARGUMENTS` → 用 args 替换（args 缺失则替换为空串）。
  - 否则 args 非空 → 正文 + `"\n\n" + args`。
- 展开结果裁剪到 `EXPAND_MAX_CHARS`（默认 8000），超出加截断标记。
- 返回 `(expanded_text, {"command": <id>, "args": <args or "">})`。

### 安全
不执行任何外部命令；不写文件；`load` 只读。

### 常量
`EXPAND_MAX_CHARS = 8000`、`TRUNCATION_SUFFIX`

## 二、MCP（`xueness/mcp.py`）

连接 stdio MCP 服务器，把它们的工具暴露给模型。

```python
def load(state_dir) -> list[dict]
def namespaced(server_id, tool_name) -> str
def parse_namespaced(name) -> tuple[str, str] | None
def tool_schema(server_id, tool) -> dict

class McpClient:
    def __init__(self, server: dict, *, cwd, timeout=10, output_cap=2000)
    def start(self) -> None            # spawn + initialize 握手
    def list_tools(self) -> list[dict]
    def call_tool(self, tool_name, arguments) -> dict
    def close(self) -> None            # 终止进程，幂等
    def __enter__/__exit__
```

### 数据来源 / `load` 过滤
`<state_dir>/resources/mcp/*.json`；跳过 symlink、`enabled == False`、`command` 非字符串或空、
`id` 非法；按 id 升序。

### 协议（stdio，换行分隔 JSON-RPC 2.0）
1. 启动：`subprocess.Popen([command] + args, stdin/stdout=PIPE, stderr=PIPE, cwd=cwd, text=True)`
   —— **`shell=False`**。
2. `initialize` 请求：`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"xueness","version":"0.1"}}}`。
3. 发 `notifications/initialized` 通知（无 id）。
4. `tools/list`（id=2）→ `result.tools`。
5. `tools/call`（id 递增）`params={"name":..., "arguments":...}` → `result`。
6. 每条消息一行 JSON，以 `\n` 结尾。

### 环境
子进程 env 只用最小集 `PATH` + `HOME`（**绝不正向 `os.environ`**）。

### 命名空间
`namespaced("srv", "read")` → `"mcp__srv__read"`。
`parse_namespaced` 只接受该形状（server/tool 各匹配 `[A-Za-z0-9._-]{1,64}`，排除 `.`/`..`），
否则返回 `None`。

### 结果形状
`call_tool` 返回 `{"ok": bool, "content": <裁剪后的文本>, "error": <str|None>}`。
文本由 `result.content` 里 `type == "text"` 的项拼接（`text` 字段），裁剪到 `output_cap`。
`isError == True` → `ok=False` 并把文本放 `error`。

### 超时与失败
- 每次请求有 `timeout`（默认 10s，可被 server 的 `timeout` 覆盖但**上限 `timeout_cap`**）。
- 读超时 → 关闭该 server 的进程，`call_tool` 返回 `ok=False` + 错误原因。
- 任何异常都**不得冒泡**：记为该次调用失败。
- `close()` 必须幂等，且超时也要杀进程。

### 常量
`MCP_PREFIX = "mcp__"`、`DEFAULT_TIMEOUT = 10`、`TIMEOUT_CAP = 30`、`DEFAULT_OUTPUT_CAP = 2000`

## 三、子智能体（`xueness/subagents.py`）

```python
def load(state_dir) -> list[dict]
def select(agents, name) -> dict | None
def build_system_prompt(agent, base_system) -> str
def task_tool_schema() -> dict
```

### 数据来源 / `load` 过滤
`<state_dir>/resources/subagents/*.json`；跳过 symlink、`enabled == False`、
`id`/`name` 非字符串或空；按 id 升序。

### `build_system_prompt`
`base_system` + 分隔段 + 该 agent 的 `systemPrompt`
（取 `systemPrompt`，否则 `prompt`，否则 `description`；都没有则只返回 `base_system`）。
裁剪到 `PROMPT_MAX_CHARS`（默认 4000）。

### `task_tool_schema()`
返回 OpenAI 风格 function schema：

```json
{"type": "function", "function": {
  "name": "task",
  "description": "Delegate a focused sub-task to a sub-agent (read-only, bounded). Returns a short summary.",
  "parameters": {"type": "object",
    "properties": {"prompt": {"type": "string"}, "agent": {"type": "string"}},
    "required": ["prompt"], "additionalProperties": false}}}
```

### 常量
`PROMPT_MAX_CHARS = 4000`、`TASK_TOOL_NAME = "task"`

## 四、后端接入（主代理独占）

1. **命令**：`core.append_user_turn(session, store, text, commands=None)`
   —— 在追加前展开；把 `{"command": ..., "args": ...}` 记到 `session["command_invocations"]`（上限 50）。
2. **MCP**：`core.run(..., mcp_tools=None, mcp_call=None)`
   —— `mcp_tools` 是额外的 OpenAI 风格工具 schema 列表（追加到 `TOOLS` 之后）；
   `mcp_call` 是 `fn(name, arguments) -> dict`，仅当工具名以 `mcp__` 开头时调用。
   **模型只见 opt-in 后真实存在的工具**；未启用时工具列表与现在完全一致。
3. **子智能体**：`core.run(..., subagents=None, depth=0, max_depth=1)`
   —— 暴露 `task` 工具；嵌套 run 用**只读 Gate**、`max_steps=4`、独立临时 session（不写父 journal）；
   返回 `{"ok", "summary", "steps"}`，summary 裁剪到 4000。
   `depth >= max_depth` 时**不暴露** `task` 工具（防无限递归）。
4. `web.py` / `cli.py`：新增 opt-in
   - CLI：`--allow-mcp`、`--allow-subagents`
   - Web：`allow_mcp`、`allow_subagents`（布尔）
   - 命令展开**无条件启用**（无副作用）。
5. `resources.py`：MCP 服务器配置复用已有 POST/PUT/PATCH/DELETE，无需新语义。

## 五、前端（子代理 D）

1. `webapp/src/xuenessServices.ts`：新增并导出
   `saveMcpServers(servers: unknown[]): Promise<ResourceItem[] | null>`
   —— 调 `putResource("mcp", {items})`，失败 `console.warn` 返回 null。
   新增并导出 `toMcpResourceItem(server, usedIds)`：保留
   `id/name/command/args/enabled`；`id` 归一化（非法字符→`-`、截断 64、空或 `.`/`..` 或重复 → null）。
2. `webapp/src/main.tsx`：
   - `mcpSyncService.saveMcpToUserDirectory` 从桩改为真调用 `saveMcpServers`。
   - `subagentsService.setEnabled` 从 no-op 改为 `setResourceEnabled("subagents", ...)`。

## 六、验收（硬性）

### 子代理 A / B / C
各自跑 `python3 -m unittest tests.test_<模块> -v`，全绿并贴原始 `Ran N` / `OK`。

- A（命令）：无斜杠原样返回、命中展开、`$ARGUMENTS` 替换、args 追加、未知命令原样、禁用命令原样、
  超长截断、symlink 跳过、非法 id 跳过、**不写文件**。
- B（MCP）：**用一个真实的假 MCP 服务器脚本**（写进临时文件，说换行分隔 JSON-RPC）验证
  initialize 握手、`tools/list`、`tools/call` 成功、`isError` → `ok=False`、
  超时不冒泡、server 不存在不抛异常、`close()` 幂等且真的杀进程、
  env 不泄露（`FOO_SECRET` 不出现在子进程宇宙）、namespaced/parse 往返。
- C（子智能体）：加载过滤/排序、`select` 命中与未命中、prompt 拼接与截断、
  `task_tool_schema` 形状正确、symlink 跳过。

### 主代理（端到端）
1. 命令：`/demo hello` 展开后，模型收到的 user 内容含命令正文与 `hello`。
2. MCP：假 server 的工具**真的出现在** `TOOLS` 里，且 `call_tool` 结果进 journal。
3. 子智能体：父 session 里出现 `task` 调用，返回 summary；**父 journal 不含子 session 的完整对话**；
   子 run 用只读 Gate（尝试 write 必须失败）。
4. 三个 opt-in **默认全关**：不开时工具列表与现在逐字节一致。

## 七、冲突规避

| 子代理 | 允许写的文件 |
|---|---|
| A | `xueness/commands.py`、`tests/test_commands.py` |
| B | `xueness/mcp.py`、`tests/test_mcp.py` |
| C | `xueness/subagents.py`、`tests/test_subagents.py` |
| D | `webapp/src/xuenessServices.ts`、`webapp/src/main.tsx` |

**主代理独占**：`xueness/core.py`、`xueness/web.py`、`xueness/cli.py`、`xueness/resources.py`、`xueness/hooks.py`、`xueness/skills.py`。
