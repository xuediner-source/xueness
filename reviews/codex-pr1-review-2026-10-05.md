# PR #1 独立审查、问题修复与插件档位界面调整

审查时间：2026-10-05。PR：https://github.com/xuediner-source/xueness/pull/1。

审查基线为 `origin/main`（`1c30fbad`），被审查版本为 `opt/zcode-parity` 的 `fc614e9c2a7eeb084fafc2ca7c62d0f38b47dbd4`，共 39 个提交。开始时新源码目录 `/Users/xuediner/code/xueness` 干净。审查未合并、提交、推送或替换已安装应用。三个审查子代理均使用 GPT-6 Luna MAX。

## 修复结果

项目所有者随后授权「修问题，修完合并后上传」。本轮已修复下述全部 10 项，恢复 AGENTS.md 中 GPT-6 Luna MAX 的协作要求，并重新生成仓库内的正式 Web 构建。产品实现继续放在对应插件；共享层只增加已授权工具执行前的通用观察事件，权限决定仍由 Gate 完成。

| 编号 | 最终行为 | 验证 |
|---|---|---|
| R1 | 恢复只作用于当前工作区，真实 index 不变；无法备份的忽略文件冲突在写入前拒绝 | 嵌套工作区、外部暂存和未暂存内容、恢复快照往返、忽略文件及强制暂存后的新修改 |
| R2 | 创建/启动过程中取消会停止对应 workflow；延迟结果不能重新排队 | 屏障控制创建、launch 和失败竞态 |
| R3 | remote 禁用后拒绝新请求和 worker 工作，并清理运行中的 stdio 服务 | 真实空闲管道、活动假模型轮次及执行边界 |
| R4 | 发送失败保留原草稿；成功只清空尚未被编辑的提交版本 | Chrome 中 false、异常、重复发送和发送中新输入 |
| R5 | 打开项目入口要求 settings 与 sessions 同时生效 | 正式构建中禁用 settings 后无入口、无工作区请求，插件管理仍可打开 |
| R6 | 父目录与手动目标分开保存，URL 后填仍推导仓库子目录 | Chrome 父目录先选、手动固定、旧选择器延迟返回 |
| R7 | 所有子代理请求有取消信号和所属会话代次；过期结果不更新面板 | Chrome 旧数据、错误、loading、取消结果及卸载/禁用 |
| R8 | 模型选择使用实际输入框 ref 恢复焦点 | Chrome 轻量输入框焦点；容器三处接线 |
| R9 | Git 快照在 Gate 成功之后同步完成，拒绝/待批准调用不产生快照 | plan 拒绝、审批重放、延迟观察回调与既有 PreToolUse 拦截 |
| R10 | MCP 前后端都按 Unicode 码点计数，原生输入允许 emoji | 单元回归与 Chrome 表单提交 |

修复后门禁：后端全套 **2079 项、零失败、41 项跳过**；前端 **614 项全部通过**；typecheck、正式 build、插件结构检查及 26 项架构测试通过；桌面宿主 55 项全部通过。两个新增 Chrome 交互回归和插件披露浏览器回归均通过。使用修复后的源码重新构建 Mac 冻结后端，独立 smoke 验证时区、认证 HTTP、27 插件、真实 PTY、workflow worker、开关和关闭清理通过。

原全套中的 4 项 Mac 临时路径断言改为规范化路径，Anthropic 用量断言保留实际返回的原始与归一化字段；没有改写生产指标或把 fixture 当作性能测量。正式构建复查 1440px 中文亮色、420px 中文暗色及 1440px 英文暗色：档位卡片无横向溢出，桌面等高，无运行时错误。全部状态、会话与工作区检查都使用临时目录，不调用真实或收费模型。

Windows 原生环境、真实模型和真实 MCP 服务的端到端复测仍需对应环境；本轮没有替换已安装的 0.1.2 应用或发布新的客户端安装包。

## 原始审查结论（修复前）

暂不建议合并。确认了 1 项 P1、8 项 P2、1 项 P3；最需要先处理的是回滚越过会话工作区并丢失未提交内容，其次是取消/插件禁用的生命周期漏洞与轻量模式草稿丢失。测试通过并不能覆盖这些边界行为。

## 发现

### R1 / P1：子目录工作区回滚会覆盖工作区外的未提交文件

位置：`xueness/bundled_plugins/git/turn_checkpoints.py:174`（创建快照入口为 `:106`）。新入口直接复用旧 `actions.restore`。旧 helper 在子目录中用 `git add -A -- .` 创建快照，但恢复时用 `read-tree --reset -u` 替换整个仓库树，快照与恢复范围不一致。

隔离复现：建立仓库 `repo`，提交 `outside.txt` 与 `project/inside.txt`；会话工作区设为 `repo/project`。把两文件都改成未提交内容，调用新 `record_turn(..., gate_kind='write')`，再改动两文件，调用 `rewind(..., latest=True, confirmed=True)`。`inside.txt` 正确回到快照，`outside.txt` 却变回 HEAD。返回的 recovery checkpoint 也只有外部文件的 HEAD 内容，不能找回丢失的外部修改。合法工作区可以是仓库子目录；确认回滚选定工作区不代表允许改写其外部文件。

修复应让快照和恢复使用一致的范围，并覆盖嵌套工作区、外部已暂存/未暂存修改及恢复快照的回归。

### R2 / P2：闲时任务显示取消后，底层工作流仍会启动

位置：`xueness/bundled_plugins/automation/off_peak.py:331`、`:405`、`:427`。

`_claim` 把任务设为 RUNNING，但 `workflowId` 暂时为空。若 `cancel` 在 `WorkflowStore.launch` 尚未返回时发生，它只能标记任务取消，拿不到底层工作流 ID；随后 `_settle(status='started')` 填入 ID，却不处理已经取消的队列项。用临时状态和屏障控制的 fake launch 复现：队列项为 `cancelled`，其工作流仍为 `queued`。这不是实际模型性能测试，也未调用收费模型。

需要在启动/落盘交接时重新检查取消状态，并取消已经创建或启动的工作流，保留取消状态而非重置为可运行。

### R3 / P2：关闭 remote 插件后，已启动的 app-server 仍接受新任务

位置：`xueness/bundled_plugins/remote/app_server.py:670`、`:321`。

remote 开关只在进程启动时检查；后续请求只检查被转发接口的插件归属。临时状态中启动 AppServer 后禁用 remote，再发送 `session/create`，仍成功创建会话。sessions 等目标插件的权限检查还在，因此不是无条件绕过 Gate，但违反所属功能关闭后不得启动新工作这一生命周期约束。

应逐请求检查 remote 的有效状态，并在禁用时释放本功能服务；恢复/关闭响应可以作为受限生命周期入口保留。

### R4 / P2：轻量模式发送失败时丢失输入草稿

位置：`webapp/src/plugins/providers/LightweightWorkbench.tsx:868`。

组件先清空输入，只在回调抛异常时恢复。容器的正常失败路径会返回 `false`，而不是抛异常；完整 Composer 会保留这些失败草稿。用 Chrome 渲染真实 LightweightComposer，回调设为 `async () => false`，输入并按 Enter 后文本变成空字符串，独立复现了丢失。

应在明确接受发送后清空，或按完整 Composer 的返回值约定恢复，同时避免异步结果覆盖发送后新输入。

### R5 / P2：关闭 settings 后，起始页仍提供不可用的打开项目按钮

位置：`webapp/src/XuenessWorkbenchContainer.tsx:1483`。

`open-project` 无条件加入动作清单，但工作区选择接口要求 settings 和 sessions 均生效。在真实构建的隔离状态中禁用 settings 后独立复现：按钮仍显示，点击后 `/api/workspaces/native-picker` 与 `/api/workspaces` 都返回 403，选择器显示 `plugin disabled or dependency unavailable: settings`。此入口应检查全部归属插件；插件管理恢复入口仍须独立可用。

### R6 / P2：先选择克隆父目录、后填写 URL，会把父目录本身当作目标

位置：`webapp/src/plugins/git/XuenessCloneDialog.tsx:106`、`:92`。

URL 为空时选父目录，代码将该父目录写入 dest 并设置 `pinnedDest=true`；之后输入仓库 URL，自动追加仓库子目录的 effect 已被禁止。界面明确把原生选择器称为「选择上级文件夹」，后端却要求最终目标为空目录。常见的已有 Projects 父目录因此导致克隆失败，空父目录还会成为错误的实际克隆目标。

应分别保存父目录选择与最终目标手动编辑状态，只有用户编辑最终目标才停止仓库名推导。

### R7 / P2：子代理面板可被上一会话的延迟轮询覆盖

位置：`webapp/src/plugins/subagents/SubagentSidePane.tsx:107`、`:160`。

effect 只给首次请求传 AbortSignal，周期刷新调用 `loadTasks(false)` 不带 signal；响应没有校验请求所属的 sessionId。保持面板挂载并切换会话时，旧会话慢响应可能在新响应之后 `setTasks`，显示错误会话的子任务。需要让所有请求携带取消信号或代次标识，过期响应不得更新数据、错误或 loading 状态。

### R8 / P2：轻量模式选择模型后不能继续键盘输入

位置：`webapp/src/plugins/sessions/XuenessComposerToolbar.tsx:64`；新轻量输入框在 `plugins/providers/LightweightWorkbench.tsx:961`。

模型菜单选择后尝试把焦点还给 `textarea.xn-composer__input`，但轻量模式的输入框 class 不同。菜单关闭移除聚焦元素后，没有输入框接住焦点。应使用传入的真实输入 ref，或统一跨布局的输入焦点接口。

### R9 / P2：被拒绝的修改工具仍会在工作区创建 Git 检查点

位置：`xueness/tool_registry.py:94`、`xueness/bundled_plugins/git/turn_checkpoints.py:106`。

新 before-tool 事件发生在工具 handler 内的 Gate 检查之前。临时仓库中以 plan 权限调用 write，写操作被 `plan_mode_denied` 拒绝且文件未变，但 Git refs 从 0 变为 1，会话也多了轮次检查点。因此快照并非在「第一项实际允许的变更之前」创建；批准等待期间用户新增的修改也可能不在后续实际执行的快照里。

应区分拦截/准备事件与已获准开始执行的事件，将持久快照放在后者，保持 Gate 拒绝不修改工作区元数据。

### R10 / P3：MCP 表单字符串长度校验与后端不一致

位置：`webapp/src/plugins/mcp/ElicitationForm.tsx:286`；后端 `xueness/bundled_plugins/mcp/elicitation.py:480`。

前端 JavaScript `.length` 按 UTF-16 单元计数，Python `len` 按 Unicode 码点计数。`maxLength:1` 的单个 emoji 在后端有效，前端却拒绝。应统一计数，并核对原生 input 的 maxLength 限制。

## 原始版本的独立验证（修复前）

- 原分支前端：613 项测试通过、typecheck 通过。此次档位界面改动后重新运行，仍为 613 项全通过，typecheck 与正式 Vite 构建通过。
- 插件结构校验通过；`tests.test_plugin_architecture` 的 26 项通过。新增样式仍位于 extensions 插件目录，能力归属仍为 `extensions.plugin_profiles`。
- 后端全套：2067 项，41 项跳过，5 项失败。4 项是 `/var` 与 `/private/var` 的 Mac 临时目录断言差异，设置规范化 TMPDIR 后这 4 项单独重跑均通过。Anthropic stream 用量字典形状断言在导出的 `origin/main` 上同样失败，确认不是这批引入。没有把这次全套报告写成完全通过。
- 已安装 `/Applications/Xueness.app`：96 个前端资源逐文件 SHA-256 与分支原构建一致；可执行后端与本地构建二进制 SHA-256 一致。读取冻结 PYZ 后，223 个 Xueness Python 模块的递归代码结构与源码编译结果一致，无缺失或差异；`_load_commands` 含 language 关键字参数。
- 安装包冻结后端独立 smoke 通过：打包时区数据、认证 HTTP、27 插件目录、PTY、工作流 worker、开关边界与关闭清理。全程隔离状态、真实模型禁用。
- PR 当前为 OPEN，尚未合并，未显示 CI status checks。Windows 原生环境与真实 MCP 服务/真实模型长任务未在这台 Mac 上端到端验证。

## 协作约束文档偏差

这批 `5a1d45b` 删除了 AGENTS.md 中「子代理只能使用 GPT-6 Luna，推理等级 MAX」这一行，而项目所有者本轮提供的约束仍明确保留它。本轮已恢复仓库中的该约束。仅凭交接记录无法推断此前其它团队是否另获授权；本轮审查与修复子代理严格使用指定模型和推理等级。

## 本轮按用户截图调整的界面

只调整 extensions 的档位展示：三个同尺寸卡片，中文名称、简短说明、图标、当前状态，每档一个按钮；去掉重复的轻量档推荐切换行，保留手动开关优先与权限不变提示。自定义档位中英文说明继续显示。三档数据 ID 和后端行为没有变化。

使用临时状态和 `/tmp/xueness-pr1-web-dist` 正式构建检查了桌面、420px 窄屏、亮暗主题和英文文案；卡片等高，420px 无横向溢出，切换显示正确当前状态，无浏览器运行时错误。源码和临时预览已更新；已安装应用仍是原 fc614e9 构建，尚未将本轮美化打包安装。

预览：`reviews/images/plugin-profiles-2026-10-05.png`。
