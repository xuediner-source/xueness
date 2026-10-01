# ZCode 对齐复审（Stage 3-6 之后）

日期：2026-09-25
方法：以 `zcode-parity-roadmap.md` 的 capability inventory 为基准，**逐条对照当前源码**，
不采信既有文档的结论。发现的问题当场修掉，不留在报告里当"已知项"。

## 结论摘要

| 维度 | 结论 |
|---|---|
| P0（Harden） | **5/5 完成**，验收项逐条核实通过 |
| P1（daily-use gap） | **6/6 完成**，验收项逐条核实通过 |
| P2（刻意不做） | 5 项**被做成默认关闭的窄适配器**（用户明确要求），其余按原计划未做 |
| 复审新发现 | **3 个真缺口**，全部已修 + 已锁回归测试 |

**没有"完全对齐 ZCode"**。这是定位差异，不是完成度问题：Xueness 是 stdlib 单进程本地
harness，ZCode 是带桌面端/远程执行/多 provider 网关的产品。见文末「不对齐且不应强求」。

## 复审发现并修复的 3 个真缺口

### 缺口 1：两个钩子事件声明了但从不触发（最严重）

`HOOK_EVENTS` 声明 7 个事件、加载时也校验白名单，但 `UserPromptSubmit` 与
`PermissionRequest` **在运行循环里从未被 fire**。决定性实验（每个事件配一个写标记文件的钩子）：

```
修复前: SessionStart PreToolUse PostToolUse Stop        ← 只有 4 个
修复后: SessionStart UserPromptSubmit PreToolUse PermissionRequest
        PostToolUse PostToolUseFailure Stop             ← 全部 7 个
```

为什么危险：**一个能配置、能被校验、能显示为已启用、却永远不会运行的钩子，比没有这个功能更糟
——它看起来是支持的。** 原测试只断言常量存在（`test_constants_match_contract`），所以没抓到。

修法：`core.py` 在开工前 fire `UserPromptSubmit`（带上该轮 prompt 文本），调用被拒时 fire
`PermissionRequest`。

**`PermissionRequest` 是纯观察性的**：钩子 exit 2 记入审计，但**绝不允许授予访问**。
若钩子能批准，它就静默架空了它所观察的那个 Gate。已加专门测试锁定这条语义。

### 缺口 2：P0-1 要求的审批审计未实现

路线图 P0-1 原文要求 `add expired/consumed approval audit in session journal`。
实际情况：审批被 `WebGate.check` 静默消费，**journal 里查不到谁批了什么**。

这是事后第一个要问的问题——「谁授权了这个调用？」——而当时答不出来。

修法：`core.record_approval()` 记录三种动作（`granted` / `consumed` / `cleared`），
上限 100 条、subject 裁剪到 200 字符（MCP subject 内嵌参数，可能极大）。审计失败不得中断 run。

端到端证据：`granted` → `consumed`，且文件真被写入。

### 缺口 3：文档行号大面积失效

我的修复让 `security-posture-change.md` 里的 `file:line` 引用失效。**手工同步已经失败过三次**
（每次代码一改，文档就静默开始撒谎）。

修法：写 `tools/check_doc_citations.py`——按**内容**而非仅按范围校验引用：
检出引用行附近声称的代码符号是否真的存在，而不是只检查行号是否越界。

它自己开发期间抓出了我三次写错（首版把中文散文当 token、切段切掉配对反引号导致**假通过**、
跨引用串染）。现已记录已知假阳性类型，按「需要人看一眼」而非「自动判定错误」使用。

## P0/P1 验收项逐条核实

| 项 | 要求 | 现状 |
|---|---|---|
| P0-1 | argv join 碰撞 + 已消费审批审计 | ✅ `test_exec_pending_subject_preserves_argv_boundaries`、`test_approval_audit.py` |
| P0-2 | `--mode plan\|build` + `--disallow-tools` | ✅ 10 项 web 测试覆盖 |
| P0-3 | `run --prompt` + `--output-format json` | ✅ 均在 `cli.py` |
| P0-4 | provider 响应形状校验 | ✅ `validate_message()`；畸形载荷 → `provider_error` 且不写 intent |
| P0-5 | journal 卫生 | ✅ `journal` 子命令带警告；`show` 不含 memory 块 |
| P1-1 | glob/grep/edit | ✅ 三工具全部注册，workspace jail |
| P1-2 | todo_read/todo_write/ask_user | ✅ 全部注册，web `answer` 端点闭环 |
| P1-3 | 模式转换记录 | ✅ `mode_history` |
| P1-4 | resume / title / turnCount / tokenChars | ✅ 均在 `cli.py` |
| P1-5 | SSE/events + 409 busy | ✅ `events` 端点 + 并发 409 测试 |
| P1-6 | token 感知压缩建议 | ✅ `estimatedTokens = chars // 4`，无模型调用 |

测试总量：**486 通过**（本轮 +12）。

## 能力面对照（vs 路线图 §3）

### 已具备（Stage 3-6 建成）

| 能力 | 实现位置 | 默认 |
|---|---|---|
| 技能注入 | `skills.py` | 关闭（`--inject-skills`） |
| 生命周期钩子（7 事件） | `hooks.py` | 关闭（`--allow-hooks`） |
| 斜杠命令 | `commands.py` | 文本展开，无需 opt-in |
| MCP stdio 客户端 | `mcp.py` | 关闭（`--allow-mcp`） |
| 子智能体 | `subagents.py` | 关闭（`--allow-subagents`） |
| UI 运行时开关 | `settingsPageHelpers.tsx` | 默认全关 |
| 权限模式 plan/build | `core.Gate` | — |
| 逐次审批 + 审计 | `web.WebGate` | — |

### 与 ZCode 的**真实差异**（有意为之）

| 维度 | ZCode | Xueness | 说明 |
|---|---|---|---|
| 权限模式 | build/edit/plan/yolo | build/plan | **缺 `yolo`**（无审批全放行）——刻意不做 |
| 工具数 | ~35 个 handler | 10 内置 + `task` + `mcp__*` | 无 WebFetch/WebSearch、无 Node REPL、无 workflow 工具簇 |
| 工作流 | dynamic-workflow 工具簇 | 无 | P2 明确不做 |
| 记忆 | 提取 + recall + FTS | 只读注入 3 轨道 | 无提取、无 FTS、无衰减 |
| 压缩 | 模型摘要 | 确定性字符截断 + token 估算 | 不调模型 |
| 桌面 | Electron | 无 | P2 明确不做 |
| 远程 | SSH/WSL 桥 | 无 | P2 明确不做 |
| 多 provider | 注册表 + OAuth 网关 | 单个 OpenAI 兼容 | P2 明确不做 |
| Provider 家族迁移 | `providerFamilyDomain` | 后端不读该键 | 纯 UI 状态 |

### 不对齐且**不应强求**的部分

- **`yolo` 模式**：ZCode 有，但它的 NOTICE 自己承认「yolo 无只读规划约束时允许普通工具」。
  Xueness 的证据门 + 逐次审批是相反的取舍，加 `yolo` 等于放弃本项目的定位。
- **workflow / cron / off-peak**：需要常驻调度与持久队列，与「单进程 stdlib」矛盾。
- **远程执行 / 桌面**：需要 daemon 与凭证面，P2 原文点名「carries daemon, credential, or
  remote-execution surface」。
- **Computer Use**：ZCode 自己的实现是占位符（`return "Computer Use is not available in this build."`），
  连上游都没做。

## 本轮新增

| 文件 | 说明 |
|---|---|
| `tests/test_hook_events_complete.py` | 7 事件全部触发的回归；`PermissionRequest` 不可授权 |
| `tests/test_approval_audit.py` | granted/consumed 审计、上限、裁剪、不抛异常 |
| `tools/check_doc_citations.py` | 内容级引用校验器（可重复运行，非一次性） |

## 仍未验证 / 诚实的空白

- **MCP 第三方的工具调用**只测到 `tools/list`，未真实调用（会打真实 GitHub API）。
- **`2025-11-25` 协议版本**仅有行为证据（握手+tools/call 通过），无规范符合性证明。
- **UI 端到端**只覆盖设置页 13 分区渲染与资源 CRUD，未覆盖审批面板的鼠标交互。
- **`favicon.ico` 返回 404**：装饰性问题，非功能缺陷。
