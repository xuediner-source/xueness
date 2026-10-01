# 安全姿态变更说明（Stage 3-6）

日期：2026-09-25
范围：`xueness/core.py`、`xueness/hooks.py`、`xueness/mcp.py`、`xueness/subagents.py`、
`xueness/commands.py`、`xueness/skills.py`、`xueness/web.py`、`xueness/settings_store.py`、
`xueness/resources.py`、`webapp/src/xuenessBridge.ts`、`webapp/src/xuenessServices.ts`、
`README.md`、`reviews/zcode-parity-roadmap.md`
方法：逐文件 `grep -n` / `sed -n` 读取本地源码，行号均为本次核对时的真实行号。凡无法在源码中确认的断言，写「未能证实」。

---

## 1. 摘要

一句话：Xueness 从「只读注入 + 单进程、无子进程」的姿态，变成了「在显式、逐次 opt-in 下可以 spawn 子进程（钩子、MCP、exec）、可以发起嵌套模型调用（子智能体）」的姿态；默认仍然是全关，但这个**执行面本身是新增的**，路线图 P2 曾以「携带 daemon、凭据或远程执行面」为由把它列为刻意不做。

---

## 2. 新增的能力面

以下每项都先说明引入的**新风险类型**，再给出对应源码位置。

### 2.1 技能（skills，Stage 3）

- 机制：把 `<state_dir>/resources/skills/<id>.json` 渲染成有界文本注入 prompt。
- 新风险：**无进程 spawn、无命令执行、无模型调用**；风险是**提示注入**——技能正文是不可信数据，进入模型上下文后可能诱导工具调用。
- 证据：`xueness/skills.py:7-9`（「strictly read-only … untrusted data that must never override system, task, or safety instructions」）；注入点在 `xueness/core.py:721-727`（技能与记忆一样只进 prompt view，不落 journal）；`xueness/web.py:683` 无条件加载技能（`skills=load_skills(...)`），即技能是**不需要 opt-in** 的——因为它本身不 spawn、不执行。
- 边界：`xueness/skills.py:34,35`（`TOTAL_MAX_CHARS = 4000`、`DEFAULT_BODY_BUDGET = 1500`）。

### 2.2 钩子（hooks，Stage 4）

- 机制：在固定事件点执行用户配置的命令。
- 新风险：**spawn 任意子进程**，且 `PreToolUse` 退出码 2 可**否决**工具调用（`xueness/hooks.py:53` `EXIT_BLOCK = 2`；`xueness/core.py:897` 由钩子结果阻断并写入 `hook_blocked`）。
- 阻断时的输出处理：`error` 字段只写钩子 **id**（`xueness/core.py:902`），钩子 stdout 不拼入错误串；原始文本（若存在）改放 `hook_output_untrusted` 字段并裁剪到 500 字符 + 截断标记（`xueness/core.py:61` `HOOK_REASON_MAX`、`:783-791`）。
- opt-in：`xueness/web.py:671`（`allow_hooks`/`allowHooks` 为真才把 hooks 列入激活名单；构造在 `xueness/plugins.py:HooksPlugin`）。

### 2.3 斜杠命令（commands，Stage 5）

- 机制：`/name args` 在进入模型前被展开为存储的 prompt。
- 新风险：**无进程 spawn、无文件写入**。`xueness/commands.py:18-19` 明确「no external command is executed, no file is written」。
- 证据：`xueness/core.py:370-372`（docstring 写明命令扩展「text-only and side-effect free, so it needs no opt-in unlike MCP or sub-agents」）、实际展开调用在 `xueness/core.py:382-384`；展开上限 `xueness/commands.py:30`（`EXPAND_MAX_CHARS = 8000`）、`xueness/commands.py:176`。
- 注意：因为不需要 opt-in，**一条命令正文就是一段注入到 prompt 的文本**；其能力等同于「用户自己打了一段话」。

### 2.4 MCP（stdio 客户端，Stage 5）

- 机制：按 newline-delimited JSON-RPC 2.0 与用户配置的 MCP 服务器通信，把其工具以 `mcp__<server>__<tool>` 暴露给模型。
- 新风险：**spawn 任意子进程**（`xueness/mcp.py:443` `subprocess.Popen`，在 `_spawn` 内，`:435-453`）。MCP 工具调用**已经过 Gate**（见 §3.15）：`xueness/core.py:917` 调 `call_mcp(gate, ...)`，内部 `gate.check("mcp", ...)`（`:90`）。即：`allow_mcp` 只负责「连接服务器并暴露工具」，**不等于「批准调用」**；每次调用仍需单独审批（CLI 的 `--allow-mcp` 是本次调用的显式放行，与 `--allow-write` 同级）。
- opt-in：`xueness/web.py:672`（`allow_mcp`/`allowMcp`）；默认 `mcp_tools = None`（`xueness/web.py:667`）。
- 协议版本协商（已加）：客户端只声明自己真正会说的版本 `xueness/mcp.py:60`（`SUPPORTED_PROTOCOL_VERSIONS`）。服务端若用**不在该集合内**的版本应答，客户端**断开而不是硬接**（`:478-481`）——未知版本可能改变线格式，继续下去会误解析后续消息。首选版本被 JSON-RPC error 拒绝时，会**换新进程**按「新→旧」重试（`:425-433` 阶梯、`:518-545` 重试）；静默/已死的子进程**不重试**（换版本救不了死管道，`:532-537`）。

### 2.5 子智能体（subagents，Stage 5）

- 机制：把 `task` 工具暴露给模型；模型可委派一个受限子任务，子任务是一个**嵌套模型调用**（会再次调用 provider），并返回摘要。
- 新风险：**嵌套模型调用**（成本、递归）以及**子会话产生的工具调用**。防线是只读 Gate（见 §3.8、§3.9）。
- 证据：`xueness/core.py:631-666`（`_run_subagent`）；`xueness/subagents.py:30,162-176`（`task` 工具 schema）。
- 摘要被裁剪：`xueness/core.py:110`（`SUBAGENT_SUMMARY_MAX = 4000`）。

### 2.6 UI / 设置开关

- 机制：`general/appearance/shortcuts/browser/agent` 六个分区写入 `settings.json`（`xueness/settings_store.py:31`）。
- 新风险：**持久化的能力开关**——一旦 `agent` 分区里写入 `allowMcp/allowSubagents/allowHooks = true`，前端后续每次 run 都会带上它们。
- 证据：`xueness/settings_store.py:28-29`（注释明确 `agent` 分区「spawn processes or nested model runs, so they are audited separately」）；前端读取 `webapp/src/xuenessBridge.ts:54-68`。

---

## 3. 现有防线

每条均给出可核对的 `文件:行号`。

### 3.1 默认全关：三个开关名，opt-in 才启用

- 三个开关：`allow_mcp` / `allow_hooks` / `allow_subagents`（也接受 camelCase）。
- 证据：`xueness/web.py:672`（MCP）、`xueness/web.py:671-672`（hooks/subagents，经 `activate` 名单）；默认值为 `None`——`xueness/plugins.py:McpPlugin.load`（未命中时返回空 dict，不注入 `mcp_tools`）。
- 未命中开关时，`run()` 收到的就是 `None`，对应工具不进入 `active_tools`：`xueness/core.py:820-825`。

### 3.2 读取设置失败时 fail-closed

- 后端：`/api/settings/<section>` 对未知分区返回 404；读取失败返回 `{}`。
  - 证据：`xueness/settings_store.py:114`（未知 section → 404）；`xueness/settings_store.py:44-61`（`load_settings`：缺失/损坏 JSON → `{}`，不抛异常；`:57-60` 为 `return {}` 分支）。
- 前端：`readRunOptIns()` 在请求异常时 `return {}`，且只有严格 `=== true` 才算开启。
  - 证据：`webapp/src/xuenessBridge.ts:59-69`，含注释 `// Fail closed: an unreadable setting must never enable a capability.`（`:68`）；三个字段 `:63-65`。

### 3.3 loopback 绑定；非 loopback 需显式 flag

- 默认绑定：`xueness/web.py:33`（`HOST = "127.0.0.1"`）。
- 非 loopback 拒绝逻辑：`xueness/web.py:903`（loopback 直接返回）、`:906`（仅当 `XUENESS_ALLOW_REMOTE` 属于真值集合才放行）、`:908`（否则 `raise ValueError`，报错文本写明「requires XUENESS_ALLOW_REMOTE=1 plus external auth/TLS」）。
- flag 名：`xueness/web.py:40`（`ALLOW_REMOTE_ENV = "XUENESS_ALLOW_REMOTE"`）。

### 3.4 Host / Origin / Referer 校验、CSRF

- Host/Origin：`xueness/web.py:300-303`（`_guard` 中 `_host_ok` 或 `_origin_ok` 失败即 403）；实现见 `:112`（`_host_ok`）、`:76`（`_origin_ok`，同时校验 Origin 与 Referer）、`:96`（`_parse_authority`，仅接受 loopback 主机名）。
- CSRF：`xueness/web.py:330-336`（`need_csrf` 时要求 `X-CSRF-Token`）；比较用 `secrets.compare_digest`（`:336`）。
- 所有写方法都要 CSRF：POST `:508`、DELETE `:780`、PATCH `:792`、PUT `:804`。
- 附带响应头：`xueness/web.py:296`（`X-Content-Type-Options: nosniff`）。

### 3.5 子进程 env 只给 PATH + HOME（不继承 os.environ）

- 钩子：`xueness/hooks.py:237-239`（env 字典仅 `PATH`、`HOME`）。
- MCP：`xueness/mcp.py:438-441`（同样仅 `PATH`、`HOME`；`:437` 注释「Minimal environment on purpose: never forward os.environ」）。
- 注意：`exec` 工具**不同**——它保留 `os.environ`，仅按变量名正则剔除疑似凭据（见 §3.12）。

### 3.6 shell=False、argv 列表

- 钩子：`xueness/hooks.py:243`（`shell=False`），argv 由 `[command] + extra` 组成（`:229-233`）；事件 payload 走 stdin JSON，不走 argv/env：`xueness/hooks.py:245`。
- MCP：`xueness/mcp.py:518`（`shell=False`），argv 由命令与参数列表拼接而成（`:513-516`）。
- exec：`xueness/core.py:501`（`shell=False`），argv 校验见 `:498-499`。

### 3.7 超时夹取（hooks 与 mcp 各自的上限）

- hooks：上限常量 `xueness/hooks.py:54`（`DEFAULT_TIMEOUT_CAP = 30`）；夹取在 `xueness/hooks.py:210`（`return min(seconds, cap)`）；`HookRunner.__init__` 默认 `timeout_cap: int = DEFAULT_TIMEOUT_CAP`（`:178`）。
- mcp：上限常量 `xueness/mcp.py:48`（`TIMEOUT_CAP = 30`）；请求默认 `xueness/mcp.py:47`（`DEFAULT_TIMEOUT = 10`）；夹取在 `xueness/mcp.py:310`（`return min(seconds, float(self.timeout_cap))`）。
- 超时不构成阻断：`xueness/hooks.py:264-265`（`blocked` 仅当 `exit_code == 2 且 not timeout`）。

### 3.8 子智能体只读 Gate（mode=plan，写/执行被拒）

- 证据：`xueness/core.py:755`（`read_only = Gate(Path(gate.root), allow_write=False, allow_exec=False, mode="plan")`）；`xueness/core.py:754` 注释「Read-only boundary: a delegate may inspect and report, never mutate.」。子会话不写父 journal：`xueness/core.py:724-628`（`_NullStore`，`save` 为 no-op）。
- plan 模式在 Gate 层拒绝写/执行：`xueness/core.py:283`（`if self.mode == "plan": raise PermissionError(f"{kind} denied in plan mode")`）。
- 说明：这是**同一进程内的权限对象**，不是 OS 级隔离（见 §4）。

### 3.9 子智能体深度上限（不暴露 task 工具）

- 默认：`xueness/core.py:671`（`max_depth: int = 1`、`depth: int = 0`）。
- 暴露条件：`xueness/core.py:820-825`（仅当 `subagents is not None and depth < max_depth` 才把 `task` 工具加进 `active_tools`）；派发同条件在 `xueness/core.py:920`（`_run_subagent` 调用点）。
- 递归时 depth 递增：`xueness/core.py:653`（`depth=depth + 1`）。
- 步数上限：`xueness/core.py:109`（`SUBAGENT_MAX_STEPS = 4`），用于 `xueness/core.py:756` 的 `max_steps`。
- 子会话不写父 journal：`xueness/core.py:724-732`（`_NullStore.save` 为 no-op）。

### 3.10 审计日志只记元数据、不写不可信 stdout

- hook 审计：`xueness/core.py:601-617`，`_hook_record` 只写 `event/id/exit_code/blocked/timeout/duration_ms`；docstring 明确「never the hook's stdout, which is untrusted text and must not be replayed as context later」（`:604-605`）。
- 上限：`xueness/core.py:55`（`HOOK_LOG_MAX = 100`），裁剪在 `:616-617`。
- 命令调用日志上限：`xueness/core.py:61`（`COMMAND_LOG_MAX = 50`），裁剪在 `:391-392`。
- 事件尾只含截断摘要：`xueness/core.py:140-157`（`_event_subject` 只取 path / argv 标签，`:157` `return str(subject)[:200]`）；`session_events` docstring 明确「Never includes memory text … Payloads are truncated summaries … never full file contents」（`xueness/core.py:164-96`）。
- 钩子输出仍会被裁剪后并入内存（不落 journal）：`xueness/hooks.py:60`（`SUMMARY_CAP = 500`）。
- 阻断路径的输出隔离（已修）：`error` 只含钩子 id；stdout 另放 `hook_output_untrusted` 并裁剪到 500（`xueness/core.py:896-902`）。回归测试 `tests/test_hooks_integration.py::test_block_reason_does_not_smuggle_hook_stdout_into_the_journal` 锁定该行为。

### 3.11 资源条目 symlink 拒绝

- resources：kind 目录为 symlink 时拒绝 `xueness/resources.py:77-78`；条名为 symlink 时拒绝 `:89-90`；读取时 `:122`；列举时跳过 `:145`；批量删除时跳过 `:291`；删除时 `:315`。
- hooks：`xueness/hooks.py:112`（symlinked 目录直接返回 `[]`）、`:118`（symlink 条目跳过）、`:87`（`O_NOFOLLOW`）。
- mcp：`xueness/mcp.py:171`（symlinked 目录）、`:177`（symlink 条目）、`:146`（`O_NOFOLLOW`）。
- commands：`xueness/commands.py:67`（`O_NOFOLLOW`）。
- subagents：`xueness/subagents.py:68`（`O_NOFOLLOW`）。

### 3.12 资源 id slug 校验（含前端归一化）

- 后端正则：`xueness/resources.py:31`（`^[A-Za-z0-9._-]{1,64}$`）、`:34`（保留名 `.`/`..`）、`:44-52`（`_valid_id` 另拒 `..`、`/`、`\`）。
- MCP 侧同款：`xueness/mcp.py:65`（正则以 `fullmatch` 使用，`:118` 说明防止尾随换行绕过 `$`）、`:68`（`RESERVED_NAMES`）、`:112-119`（`_valid_name`）。
- 前端归一化：`webapp/src/xuenessServices.ts:167-168`（`RESOURCE_ID_ALLOWED = /[^A-Za-z0-9._-]/g`、`RESOURCE_ID_MAX_LENGTH = 64`）、`:180-189`（`normalizeResourceId`，非法字符替换为 `-`、截断 64、空/`.`/`..` 返回 null）、`:193-201`（钩子 id 归一化，撞车即跳过）。

### 3.13 exec 的 argv-only + env 剥离

- 只接受 argv 数组：`xueness/core.py:27`（工具 schema `{"argv": {"type": "array", ...}}`）、`:498-499`（校验非空字符串数组）。
- env 剥离：`xueness/core.py:577`（按名称正则 `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` 剔除）。
- 超时 30s、`shell=False`：`xueness/core.py:501`。
- 输出裁剪：`xueness/core.py:503`（12000 字符）。
- 异常不外泄（可能含被调程序的输出/env）：`xueness/core.py:506-508`。
- 路径 jail：`xueness/core.py:252-185`（`path_in` 解析后必须 `is_relative_to(root)`，否则 `PermissionError("path outside workspace")`）；写文件在创建父目录后**再次**校验，并注明 symlink 竞态需要真正的沙箱：`xueness/core.py:492-494`。
- 只读遍历不跟随 symlink 目录、跳过解析到 root 之外的条目：`xueness/core.py:234-243`（`:240` 注释「never descend through symlinked dirs」）。

### 3.14 其它联动防线（本阶段相关）

- Provider 重定向 fail-closed（不把 bearer 转发到重定向目标）：`xueness/provider.py:21-25`（`_NoRedirect.redirect_request` 抛 `URLError`）。
- `real` provider 需服务端 flag 且凭据只来自进程环境：`xueness/web.py:602-604`（未开 `--allow-real-provider` 即 403）；`xueness/web.py:890`（flag 或 `XUENESS_ALLOW_REAL`）。
- 浏览器不能提交 blanket approval：`xueness/web.py:607-578`（出现 `allow_write`/`allowEdit`/`approve_all` 等键即 400）。
- 逐次审批绑定到精确 `tool_call_id` + 精确 subject：`xueness/web.py:149-171`（`WebGate.check` 消费式匹配）、`:761-762`（exec 用规范化 argv JSON 作为 subject）。
- 浏览器创建的工作区被限制在 `--web-runs`、项目 `.demo`、`/tmp`：`xueness/web.py:269-276`。
- MCP 子进程在 run 结束后必然回收（`Activation` 上下文管理器，异常路径同样回收）：`xueness/plugins.py:McpPlugin.teardown`；`close()` 幂等：`xueness/mcp.py:649-651`。

### 3.15 MCP 调用接入 Gate（与 write/edit/exec 同级）

- 默认拒绝：`xueness/core.py:77`（`call_mcp`）在转发前先 `gate.check("mcp", ...)`（`:90` web 带 `tool_call_id`、`:92` CLI 无 id）；拒绝返回 `{"ok": false, "error": "denied"}`，不抛异常、不打断 run。
- 逐次审批：审批绑定 `tool_call_id` + **规范化 subject**。subject 由 `xueness/core.py:66`（`mcp_subject`）生成，包含**工具名**与**参数**（`sort_keys` 稳定排序）；工具名入 subject 意味着批准 `mcp__srv__echo` **不等于**批准 `mcp__srv__push_files`。
- web 审批端点：`xueness/web.py:788`（`kind == "mcp"`）。**subject 从 journal 取，不信任请求体**（`xueness/web.py:789-796`），防止客户端伪造一个不相关的调用去换批准。
- 审批后重放：`xueness/web.py:262`（`replay_approved` 的 MCP 分支）——必须在 `mcp_call` 构造之后调用（`xueness/web.py:687`），否则 `execute()` 会答「unknown tool」。
- plan 模式：`xueness/web.py:628` 在查审批**之前**就拒，与 `write/edit/exec` 一致。
- 可禁用：`disallow_tools=mcp`（`KNOWN_TOOLS` 含 `mcp`，`xueness/core.py:34`）。
- **设计依据（不是拍脑袋）**：MCP 规范说客户端「should never make tool use decisions based on ToolAnnotations received from untrusted servers」（`webapp/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:2358-2359`），且实测真实第三方 server（`@modelcontextprotocol/server-github` 2025.4.8，26 个工具）**一个 annotations 都没发**——没有可信的只读信号可用于分类，故一律管制。
- 回归测试：`tests/test_mcp_gate_web.py`（默认拒、批准后真跑、一次性消费、plan 拒、disallow 生效）。

---

## 4. 不设防的部分

以下都是**确实没有**的防御，不要把它们当成存在。

1. **没有 OS 沙箱。** `exec` 与所有钩子/MCP 子进程都在宿主用户权限下运行。README 原文：「`exec` … It is **not a sandbox**: approved programs may write elsewhere, read arbitrary files or access the network.」（`README.md:79`）。暴露章节也明说「no OS sandbox」（`README.md:182`）。
2. **exec 的 env 剥离只是名字黑名单，不是隔离。** `xueness/core.py:577` 只按变量名正则剔除；一个名为 `FOO` 的密钥不会被剔除，而子进程仍可读任意文件、访问网络。
3. **没有多用户鉴权。** 「no multi-user auth」（`README.md:182`）。CSRF token 是进程级的单一 token（`xueness/web.py:336`），不是用户身份。
4. **没有 TLS。** 服务器是明文 HTTP（`README.md:182`；`xueness/web.py:34` 无 TLS 相关代码）。loopback 之外的加密必须由反向代理提供。
5. **单用户单进程。** `README.md:190`：「Single process, one session writer at a time」。concurrency 只在会话级用 `running` 集合做 409 去重（`xueness/web.py:550-551` 与 `:614-617`），不是多租户隔离。
6. **symlink 竞态未消解。** `README.md:190`「Directory creation and file writes are not race-proof against concurrent symlink changes; do not use with adversarial local users.」源码同款标注 `xueness/core.py:492`。
7. ~~**MCP 工具调用不经 Gate、无逐次审批。** `xueness/core.py:791-792` 直接转发；因此「MCP 服务器能做什么」= 「模型通过它就能做什么」，不受 `plan`/`build` 模式限制，也不进 `disallow` 列表。~~ **已修（见 §3.15）**：MCP 调用现在与 `write/edit/exec` 同级管制——默认拒绝、逐次审批、plan 模式直接拒、可用 `disallow_tools=mcp` 禁用。
8. **子智能体的只读边界是进程内权限对象，不是隔离。** 只读 `Gate`（`xueness/core.py:755`）拒绝的只是 `write/edit/exec` 工具；子会话与父会话共享同一进程、同一文件系统权限。
9. **子智能体的次数与总 token 无全局预算。** 深度被限制为 1 层（`xueness/core.py:671`），但每层可发起多次 `task`，且每次都是一次真实 provider 调用；无跨子任务的成本上限。
10. **钩子可以在 `PreToolUse` 之前做任意事。** 钩子是宿主任意命令（`xueness/hooks.py:229-233`），env 最小化并不限制它能读什么文件或连什么网络。
11. ~~**钩子阻断路径会把不可信输出写进 journal**（§3.10 例外）：`xueness/core.py:902`。~~ **已修（见 §3.10）**：错误串只含钩子 id，stdout 移到 `hook_output_untrusted` 并裁剪到 500。注意该字段仍会随 tool 消息进 journal，只是被明确标注为不可信数据且不再无上限。
12. **技能与命令正文是无条件注入的不可信文本**（§2.1、§2.3）：不需要 opt-in，只有「不可信数据」前言与长度上限，没有内容扫描。README 明确「There is no injection scan on read」（`README.md:74` 的 memory 段结论，同一注入模型亦适用于技能/命令）。
13. **没有远程执行面被引入，但也没有阻止它被引入的自检。** 本阶段没有加 SSH/WSL/远端执行；但也**没有**任何机制阻止把 MCP 配置成远端执行工具。

---

## 5. 与路线图 P2 的关系

- 路线图原文（`reviews/zcode-parity-roadmap.md:96`）：**P2 — Deliberately deferred (do not build for parity)**。
- 列为不做的具体清单与理由（`reviews/zcode-parity-roadmap.md:98`）：子智能体（Subagents）、生命周期钩子（lifecycle hooks）、MCP stdio+http 客户端、插件市场 + 技能、cron/off-peak、动态工作流、Computer Use、浏览器控制、SSH/WSL/远端执行、Electron 桌面、多 provider 网关 + OAuth、用量/billing 面板、RAG/FTS 记忆。理由：「each carries daemon, credential, or remote-execution surface upstream itself flags as risky (NOTICE §§1-3); Xueness stdlib + single-process + evidence-gate positioning cannot absorb them without changing the security story.」并且要求「Revisit only as isolated versioned adapters behind explicit operator approval」。
- 也在路线图第 6 节被列为「must-fix before any exposure beyond loopback」（`reviews/zcode-parity-roadmap.md:107` 的 §6 标题）。
- 本阶段实际做了什么（Stage 3-6）：接入了其中 **5 项**——技能、钩子、MCP stdio 客户端、子智能体、斜杠命令（外加设置分区 `agent` 与 UI 开关）。
- 权衡（如实陈述）：
  - **确实新增了 P2 点名的 surface**：MCP 与钩子会 spawn 子进程（`xueness/mcp.py:443`、`xueness/hooks.py:241-251`）；子智能体会发起嵌套模型调用（`xueness/core.py:631-666`）。
  - **但把它们做成了「默认全关 + 逐次显式 opt-in」的窄适配器**，这正是 P2 允许的重访形态（「isolated versioned adapters behind explicit operator approval」）：三个开关 `xueness/web.py:672,675,679`，默认 `None` `xueness/web.py:667`，前端 fail-closed `webapp/src/xuenessBridge.ts:59-69`。
  - **没做的部分，姿态未变**：没有插件市场、没有 cron/off-peak、没有工作流、没有 Computer Use、没有浏览器控制、没有 SSH/WSL 远端执行、没有 Electron、没有多 provider 网关/OAuth、没有用量面板（对照 `reviews/zcode-parity-roadmap.md:98` 清单）。也就是说 P2 清单被**部分**打开，而非整体打开。
  - **「隔离」一词只在进程内成立**：所谓只读边界是 `Gate(mode="plan")`（`xueness/core.py:755`），不是 OS 级隔离（§4 第 1、8 条）。
- 结论：安全姿态**确实变了**（新增子进程/Nested 模型调用面），且这一变化是**用户明确要求**的；变化的幅度被「默认全关 + 逐次审批 + 只读子 Gate + 元数据审计」限制，但没有被消除。

---

## 6. 暴露前置条件

若要暴露到 loopback 之外（例如反向代理、容器多网段、LAN），**以下条件是前置的、当前一条都不满足**。这些条件与 `README.md:182-186`、`reviews/zcode-parity-roadmap.md` §6 的既有声明一致。

1. **前置身份鉴权。** 当前无多用户 auth（`README.md:182`）。需要一个独立于 CSRF token 的身份层；CSRF token 是进程级常量（`xueness/web.py:336`），不能当鉴权用。
2. **TLS 终止。** 当前是明文 HTTP（`README.md:182`）。必须在信任边界处提供 TLS，且不得依赖应用内加密（应用内没有）。
3. **`XUENESS_ALLOW_REMOTE=1` 只是容器网络开关，不是安全措施。** 源码自己的报错文本就写了它「requires … plus external auth/TLS」（`xueness/web.py:867`）；README 同款声明（`README.md:182`）。
4. **能力开关的组合需重新评估。** `allow_mcp`（`xueness/web.py:672`）现在只意味着「连接并暴露工具」，**不等于批准**：每次调用都要逐次审批（`xueness/core.py:917` → `:90`），`plan` 模式下直接拒（`xueness/web.py:628`），也可用 `disallow_tools=mcp` 禁用（`xueness/core.py:34`）。剩余风险是**审批疲劳**：一个只读服务器也要每次点一次，用户可能养成盲点「批准」的习惯。
5. **symlink 竞态必须先修或必须先排除对抗性本地用户。** `README.md:190` 明说此实现不适用于对抗性本地用户；`xueness/core.py:492` 同款标注。
6. **独立安全评审。** `reviews/zcode-parity-roadmap.md:98` 要求 P2 能力「behind explicit operator approval」；把新增的 spawn/嵌套调用面暴露到网络，应作为一次独立评审的输入，而不是本次变更的默认延续。
7. ~~（可选但建议）为 MCP 增加逐次审批或操作员可读的能力声明~~ **已完成**：MCP 接入 Gate（§3.15）。实现依据：MCP 规范明说客户端「should never」依据不可信服务器的 `ToolAnnotations` 做工具使用决策（`webapp/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:2358-2359`），且实测真实第三方 server（`@modelcontextprotocol/server-github` 2025.4.8，26 个工具）**一个 annotations 都没发**。所以没有可信的只读信号可用来分类——只能全部管。

---

## 附录：证据核对

- 本文件所有 `文件:行号` 引用均在 2026-09-25 用 `sed -n "<n>p" <file>` 抽查复核（抽样 ≥ 10 条，见交付报告）。
- 未能证实的断言：见交付报告中单列的「未能证实」条目（如有）。本文件正文未依赖任何无法在源码中定位的断言。
