# 2026-10-06 交接修复与后续实验功能

基线为交接 bundle 的 `2568b13`，同时保留 `wt/z-history` 的 `99d1862`、`b65ab61`。本轮在 `codex/handoff-fixes-20261006` 开发，使用隔离状态目录，不读取或覆盖用户会话、模型配置及插件开关。

## 复核问题

| 编号 | 修复结果（均已实现） |
|---|---|
| R1 | 增量事件使用前缀版本 token，已读历史替换、同长度变化、压缩后重新增长必须重新同步。 |
| R2 | 保留跳转窗口直到滚动视口真正同步，远距离跳转不被旧布局测量撤销。 |
| R3 | 绑定状态目录但没有 session 的直接工具调用同样经过插件策略。 |
| R4 | 干跑区分文件不存在、存在但不可读，以及无法生成可靠 diff。 |
| R5 | 限制干跑文件读取和 diff 计算规模，输出截断不能代替处理上限。 |
| R6 | 标准/轻量模式的 Alt+Enter 保持一致，不意外发送。 |
| R7 | 窄屏侧栏焦点允许属于当前控件的 portal 菜单，拒绝无关外部节点。 |
| R8 | 相隔很远的固定条目不会把虚拟列表扩成整段数百行。 |
| R9 | `aria-activedescendant` 只引用已挂载选项；外部选中及键盘远跳保持可见。 |
| R10 | 延迟提交同时更新时间戳，结束时准确 flush；标准和轻量模式共用调度。 |
| R11 | macOS 临时目录路径断言先规范化，正确处理 `/var` 与 `/private/var`。 |

## A3 / U5：结构化问题答复

归属 `sessions.answer_question_experimental` 和 `sessions.question_answer_ui`。设置 → 通用 → 会话实验功能 → 结构化问题答复，保存为 `general.sessionsAnswerQuestionEnabled`，默认关闭，只有布尔 `true` 开启。会话插件关闭时不加载表单、不请求问题接口。

- `GET /api/sessions/<sid>/question` 返回 `{id, enabled, question: null | {id, text}}`。问题 ID 由宿主生成，模型不能指定。
- `POST /api/sessions/<sid>/answer-question` 接受 `{questionId, answer}`；答复去掉首尾空白后为 1–5000 个 Unicode 字符。
- 返回 `{id,status,questionId,accepted:true,alreadyAnswered}`；相同问题和相同答复幂等，过期 ID 或不同答复冲突返回 409。
- 写入前取得既有会话 lease 并重新读取；沿用工作区边界、Host/Origin/CSRF、插件开关及 `core.answer_session`。
- API 只保存答复，不启动模型、不批准工具。原 `/answer` 路由保持兼容。
- 标准和轻量界面共用明确的「仅保存答复」「答复并继续」。Ctrl/Command+Enter 明确选择继续；普通 Enter、Alt+Enter 和中文输入确认不会触发提交。失败保留草稿；仅保存后保留明确的「继续任务」入口。待答复期间普通输入框停用，避免误走普通消息路径；切换会话、卸载或关闭功能后的迟到请求不能启动旧会话。

## A4：每轮工具调用预算

归属 `tools.call_budget_experimental`。设置 → 通用 → 工具执行实验功能，`general.toolsCallBudgetEnabled` 默认关闭；`general.toolsCallBudgetLimit` 默认 100，只接受 1–10000 的整数。

预算在原 Gate 通过后、工具副作用之前预留。模型会话按用户轮次持久计数，恢复不重置，并发工具共用原子预留。预算拒绝返回 `tool_call_budget_exhausted`、`retryable:false`；现有运行循环据此暂停。新的用户消息开启下一轮。预算不授予权限，原 Gate 拒绝保持原含义。

tools 插件将权威计数保存为 `<state_dir>/.tools-call-budgets/<sid>.json`，只包含 `{turn_id, used}`；读取上限 4KB，写入采用原子替换与私有权限。写入预留共用 `<state_dir>/.tools-call-budget-locks/<sid>.lock` 的跨进程锁，拒绝链接路径。会话中的 `tool_call_budget` 是镜像，不能用陈旧会话快照覆盖权威计数。原会话 lease 继续保护消息日志；不为计数保存整份旧日志，也不嵌套取得会话 lease。记录或存储错误阻止执行，状态接口返回 503，不伪造剩余额度。

注册工具、MCP、skill_read 和 task 的模型调用均经过同一执行前策略。task 在父会话计一次；子代理的工具按它自己的内存会话及轮次累计，多个 dispatch 不会重新置零。相同执行范围内对同一调用的重复授权只预留一次。干跑预览也消耗一次预算，但仍不消耗真实审批。

无会话的 `bind_execution` 直接调用只在该执行范围内共享计数，不伪造持久会话；单次 `core.execute(...,state_dir=...)` 的范围不会成为跨调用的全局限额。若需要跨调用计数，调用者须复用绑定范围或真实会话。

`GET /api/tools/call-budget?session=<sid>` 只投影当前轮的 `{enabled,scope,turn_id,used,limit,remaining}`，不能访问工作区外会话。标准和轻量模式显示同一预算状态；tools 关闭或实验开关关闭后不请求该接口。

## 插件与共享边界

全部新 API、策略、配置界面及答复组件属于现有 sessions/tools 插件，登记 modules、frontendModules、双语 features 并出现在完整功能目录。SettingsSections 新增的 slot 只挂载插件提供的设置组件，不拥有工具策略。

共享执行协议增加严格的 `before_tool_effect` seam，注册表只统一分发，预算和干跑业务留在 tools。通用执行范围映射不携带任何工具策略。`ui/StreamingCommitGate.ts` 为无请求、无权限判断的文本提交调度器，由 sessions 登记导出符号，providers 的轻量界面复用；这不建立整个 providers→sessions 的插件依赖，关闭插件时其挂载与计时器仍由所属界面清理。

干跑是受支持处理器的预览及其它副作用工具的拒绝策略，不是完整沙盒；MCP 能力、显式 PreToolUse hooks、委派运行不能据此宣称被安全隔离。已有文件不可读或超过处理上限时报告 diff 不可用，不假装成新文件。

读取上限为 1,000,000 字节，diff 输入总字符上限 200,000、总行数上限 4,000，另保留最终输出上限。无法预览时返回固定原因；已确认存在的目标保留 `file_exists: true`，`readable` 表示本次受限 UTF-8 预览是否可读取，而不是操作系统权限实测。

## 验收

- 后端针对性回归：117 项通过（预算、干跑、工具事件、插件结构、核心工具路径）。
- 插件结构 checker 通过；独立架构回归 26 项通过。目录实际为 28 个插件 / 145 项双语功能。
- 前端测试 712 项全部通过；typecheck、build 通过，build 包含插件结构、design 和 bundle 门禁；已同步跟踪的 `webapp/dist`。
- `test:browser`、`test:browser:composer`、`test:browser:experiments` 全部通过。覆盖真实组件的侧栏/轨道/时间线窗口化、滚动锚点和贴尾、命令搜索防抖、窄屏 Select portal、Alt/IME、标准 1280px 与轻量 420px 的答复及显式继续、过期问题保留草稿、幂等、实验开关及插件停用后的请求门控。
- 生产 UI 回归通过真实 Python loopback API 保存答复、验证冲突和幂等。显式继续请求被固定 `allow_real=False` 的隔离宿主拒绝，确认请求路径而不启动真实模型。
- 完整后端回归：`python3 -m unittest discover -s tests -q` 运行 2210 项，41 项跳过，零失败（303.489s）；日志 `/tmp/xueness-handoff-fixes-backend-full-final.log`。终端针对性 2 项也通过。`git diff --check` 通过。

全套检查另外发现并修正了旧测试夹具的三处失配：逐项取消需显式开启实验开关、使用正确回调并确认；时间线测试去掉 CSS 后须补回历史轨道的高度/溢出约束；POSIX 终端测试必须等待 `stty size` 输出，不能只等前一条 `printf` 的就绪标记。生产组件没有因测试样式缺失而改动。

测试只使用本地 fixture / 模拟模型，不将 fixture 时长、挂载数量或文件大小声称为真实模型性能。没有实测原生 Windows、真实产品模型性能或客户端在线更新流程。上述首次验收仅包含源码与 Web 预构建产物。

2026-10-06 后续经用户授权，使用当前全部改动重新冻结 arm64 后端并生成 Mac 应用，已覆盖 `/Applications/Xueness.app` 并打开。版本号仍为本地重建的 0.1.4；包含移除桌面端设置、关于页面数据位置及按新版状态显示红点的更新入口。旧应用备份为 `~/code/Xueness.app.bak-20261006-161525`。60 项桌面测试、26 项架构回归、冻结后端正常/强制退出检查通过；生成包和覆盖后的安装路径均用隔离数据完成真实 Electron 启动、28 个插件/145 项功能、关于页面和内置浏览器运行时验证。打包烟测已改为验证 About，插件目录按精确 ID 校验，支持指定安装路径；测试目录关闭 updates，避免自动联网检查。本地覆盖和启动验收不等于跨版本在线更新验证；GitHub 上传状态以仓库和 Releases 为准。
