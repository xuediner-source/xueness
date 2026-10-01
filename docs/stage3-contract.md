# Xueness Stage 3 契约：技能接入执行链路

目标：让「设置页里建的技能」**真的影响模型收到的上下文**。
这是 Stage 2 与真实执行之间的缺口：技能能存盘、能列出，但 agent 跑任务时完全不知道它存在。

## 设计基线（照抄 `xueness/memory.py` 的既有范式，不发明新架构）

`memory.py` 已经解决过同一个问题，技能走它的路子：
- **只注入 prompt 视图**，绝不写进 journal（`core.run` 里用 `prompt = [prompt[0], injected] + prompt[1:]`）
- **有界**：总字符预算 + 单项预算，超了截断并留标记
- **标记为不可信数据**：复用 `memory.UNTRUSTED_PREAMBLE`
- **symlink 安全**：读文件用 `O_NOFOLLOW`，越界读返回空

## 后端模块：`xueness/skills.py`

```python
def load(state_dir, *, budgets=None, total_max_chars=TOTAL_MAX_CHARS) -> str
```
返回可直接拼进 prompt 的字符串；**没有可用技能时返回 `""`**（不留只有标题的空壳）。

### 数据来源
`<state_dir>/resources/skills/*.json`（Stage 2 的 `resources.py` 产物）。

### 过滤与渲染规则
1. 跳过 symlink 条目（`is_symlink()`）。
2. 跳过 `enabled == False` 的技能（缺失视为启用）。
3. 跳过 `id` 或 `name` 非字符串、或为空的条目。
4. 按 `id` 升序稳定排序。
5. 每条渲染为：

```
### <name>
<description>            ← 有才写
<body>                   ← 有才写，内部换行保留
```

6. 单项 `body` 超预算则截断；总长度超 `total_max_chars` 则截断。
7. 有内容时开头写一行 `SKILLS_HEADER`（例如 `# Enabled skills`），**再**由调用方拼 `UNTRUSTED_PREAMBLE`。

### 常量
- `SKILLS_HEADER`
- `TOTAL_MAX_CHARS = 4000`
- `DEFAULT_BODY_BUDGET = 1500`

### 安全要求
- 只用标准库。
- 不跟随 symlink（条目级与目录级都要防）。
- 不写任何文件。
- 任何单条损坏（非法 JSON、非 dict）只跳过该条，不影响其余。

## 后端接入（主代理做，子代理不要碰这些文件）

1. `core.run(...)` 新增关键字参数 `skills: str | None = None`，与 `memory` 同一处注入。
   **两者同时存在时都要注入**，顺序：先 memory 后 skills（各自带自己的 preamble 段落）。
2. `xueness/web.py` 的 run 调用点：若 `<state_dir>/resources/skills` 有内容则传入。
3. `xueness/cli.py` 的 `run` 分支：同上（新增 `--skills-state` 或复用 `--state`）。
4. `resources.py` 新增 **PATCH** 语义：`PATCH /api/resources/<kind>/<id>` 与已有条目**合并**
   （只覆盖请求里出现的键，保留 name/description/body 等），使「切换 enabled」不会抹掉技能正文。

## 前端（子代理 B 做）

- `xuenessApi.ts` 新增 `patchResource(kind, id, body)` → `PATCH /api/resources/<kind>/<id>`。
- `xuenessServices.ts` 的 `toSkillSummary` / 适配层已存在；把 `skillsService.setEnabled(...)`
  接到 `patchResource("skills", skillId, { enabled })`。
- `main.tsx` 里 `skillsService.setEnabled` 从 no-op 改为真调用（子代理 B 只改这一处 + 上面两个文件）。

## 验收（硬性）

### 子代理 A
```sh
cd /Users/xuediner/.openclaw/workspace/xueness
python3 -m unittest tests.test_skills -v
```
必须全绿并贴原始 `Ran N tests` / `OK`。测试至少要覆盖：
空目录返回 `""`、`enabled:false` 被跳过、排序稳定、损坏 JSON 被跳过、
超预算截断、symlink 条目被跳过、**不写文件**（前后文件树快照一致）。

### 端到端证明（主代理）
必须证明「技能真的进了模型上下文」，而不是「模块返回了字符串」：
用一个**录制型 provider**（记录每次收到的 messages）跑 `core.run`，断言 prompt 里：
1. 出现技能的 `name`
2. 出现 `UNTRUSTED_PREAMBLE` 标记
3. **journal 里没有技能正文**（`session["messages"]` 序列化后不含技能 body —— 这是「只注入视图、不落盘」的关键证据）

## 冲突规避

| 子代理 | 允许写的文件 |
|---|---|
| A | `xueness/skills.py`、`tests/test_skills.py` |
| B | `webapp/src/xuenessApi.ts`、`webapp/src/xuenessServices.ts`、`webapp/src/main.tsx` |

**主代理独占**：`xueness/core.py`、`xueness/web.py`、`xueness/cli.py`、`xueness/resources.py`、`xueness/memory.py`。
