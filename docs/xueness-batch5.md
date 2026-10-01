# Xueness 第五批：多 Agent 协作与上下文/记忆（冻结契约）

日期：2026-09-28。本文件冻结**第五批**。路线图四项：任务 id 与进度镜像；停止/恢复；
工具级与命令级一致的写冲突约束；上下文压缩保留工具调用配对与用户原文。

## 0. 已实证的现状缺陷（必须修）

`core.compact()` 只保 `messages[:2]`（system + 原始 task）与尾部 4 条，中间**整段丢弃**。
实测：一个含后续用户轮次的长 journal，压缩后 `user turns kept: ['ORIGINAL TASK']` ——
**后来的用户轮次被静默删除**。工具配对当前恰好保住（尾部对齐到非 `tool` 行），但这是
尾部切片的副产品，不是被保证的不变量。

## 1. `xueness/task_registry.py`（新建）

子代理运行注册表 + 进度镜像。**进程内、线程安全**；持久镜像写入父会话 journal。

```python
class TaskRegistry:
    def record(self, task_id, *, parent_session, agent, prompt, root) -> dict
    def update(self, task_id, **fields) -> None          # steps/status/summary/...
    def finish(self, task_id, *, ok, summary="", error="") -> dict
    def get(self, task_id) -> dict | None
    def list(self, parent_session=None) -> list           # started 升序
    def cancel(self, task_id) -> bool                     # 置 cancelled, 返回是否命中
    def is_cancelled(self, task_id) -> bool
    def forget(self, task_id) -> None                     # 运行结束后从活跃表移除
```

记录字段（稳定）：

| 字段 | 说明 |
|---|---|
| `id` | `sub-<32hex>`，创建时生成 |
| `parent` | 父会话 id |
| `agent` | 子代理 id，未指定为 `None` |
| `promptChars` | 提示长度（**不存提示原文**，避免把未信任文本扩散进镜像） |
| `status` | `running` / `completed` / `failed` / `cancelled` |
| `steps` | 已执行步数 |
| `startedAt` / `endedAt` | epoch 秒；未结束为 `None` |
| `summary` / `error` | 截断摘要，最多 4000 / 500 字符 |

**安全不变量**：注册表只存**元数据与截断摘要**，不存子代理提示原文或工具输出正文。
`promptChars` 是长度而非内容。

`mirror(session, registry, parent_session)` 返回当前父会话的子运行快照列表，供 UI 进度镜像；
纯函数式投影，不写 journal。

## 2. 停止/恢复（`core.run` 新增 `should_stop`）

```python
def run(..., should_stop: Callable[[], bool] | None = None) -> dict
```

- 在每个 step 开头检查 `should_stop()`。为真时：`session["status"] = "stopped"`，
  触发 Stop 钩子，落盘，返回。**不丢弃已完成的工具结果，不自动重放任何副作用。**
- 恢复 = 再次 `run()`（`status="stopped"` 必须被接受为可继续的状态；当前只接受
  `completed`/`awaiting_user` 的早退，其余会继续跑）。
- `registry.is_cancelled(task_id)` 接入 `_run_subagent`：子代理运行中每步检查父取消标记，
  被取消则子运行以 `cancelled` 收束，父得到 `{"ok": False, "error": "cancelled", "task_id": ...}`。

## 3. 写冲突约束（`xueness/write_lock.py` 新建）

工具级（`write`/`edit`）与命令级（`exec` 里的重定向目标不解析——只做工具级）统一由
**按解析后绝对路径**的进程内锁保护。

```python
class WriteLocks:
    def acquire(self, path: str, owner: str) -> bool   # False = 已被 other owner 持有
    def release(self, path: str, owner: str) -> None
    def holder(self, path: str) -> str | None
```

- 键是 `Path(path).resolve()` 的字符串，因此符号链接与相对路径都归一到同一把锁。
- `owner` 用会话 id。**同 owner 重入视为已持有**（一次 run 内多次写同一文件不算冲突）。
- `builtin_tools` 的 `_write`/`_edit` 在**任何磁盘写入之前**获取锁；拿不到 →
  返回 `{"ok": False, "error": "path busy: held by <owner>", "conflict": True}`，**不写盘**。
- 锁在 handler 返回前释放（`try/finally`），异常路径同样释放。

## 4. 上下文压缩修复（`core.compact`）

保留规则改为：

1. **system（第 0 条）与原始 task（第 1 条）永远保留**。
2. **所有 `role == "user"` 的消息原文永远保留**（它们是人说的话，不能进摘要）。
3. **工具调用配对不可断**：任何保留下来的 `tool` 消息，其对应 `tool_calls` 必须也在；
   反之，保留的 `tool_calls` 必须有其 `tool` 结果。裁剪只发生在**整组边界**上。
4. 其余（assistant 正文、tool 正文）可进摘要或裁剪。
5. 摘要必须记入 `archived_messages`，`compactions` 追加一条含 `removed` / `previous_chars` /
   `estimatedTokens`，并**新增 `kept_user_turns`** 计数，便于断言。

**不变量**：压缩后 `messages` 里同时满足 —— 无孤立 `tool` 结果、无缺结果的 `tool_calls`、
所有 user 原文都在、system 与原始 task 都在。

## 5. 验收

- `task_registry`：record/update/finish/get/list/cancel/forget 全路径；cancel 后
  `is_cancelled` 为真；**记录里不含提示原文**（用哨兵字符串构造并断言不出现）。
- `should_stop`：为真时状态变 `stopped`、已完成的 `results` 保留、Stop 钩子只触发一次；
  `stopped` 会话可再次 `run()` 继续。
- `write_lock`：同 owner 重入、跨 owner 拒绝、resolve 归一（相对/绝对/软链同锁）、
  异常路径释放；`_write`/`_edit` 冲突时**不写盘**（断言文件未变）。
- `compact`：四条不变量逐条断言（孤立配对、user 原文、system/task 保留、摘要归档）。
- 既有 Python 638 项、前端 85 项、golden 校验器 **零回归**。
- 不改部署；不执行外部代码。
