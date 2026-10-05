# 权限模式对照（build / edit / yolo / plan）

本文对照 Xueness 与 ZCode `--mode build|edit|plan|yolo`。取值的单一来源是
`xueness/bundled_plugins/sessions/plan_mode.py` 的 `PERMISSION_MODES`，前端同值在
`webapp/src/plugins/sessions/permissionModes.ts`。HTTP、CLI、`WebGate`、专家工作流和
app-server 都引用这一份，不再各自写死四元组。

Xueness 还有第二套更硬的旋钮：内核 `mode` 只有 `plan|build`（`core.MODES`）。
内核 `plan` 在任何批准和计划草稿之前拒绝 write/edit/exec/mcp/web。它不并进
`PERMISSION_MODES`。两套同时存在时，更严的一侧生效。

工作台有两个独立控件：工具栏「计划模式」勾选只改内核 `mode`；权限单选只改
`permission_mode`。轻量档工具栏不渲染这两个控件，运行沿用会话已保存的模式，
没有则是 `build`。

## 行为矩阵

图例：允许 / 询问（一次批准或 CLI 交互确认）/ 拒绝。拒绝在 `permission_mode=plan`
时是 `plan_mode_denied`（不可批准）；内核 `mode=plan` 时是 `denied in plan mode`。

| 能力 | build | edit | yolo | plan | ZCode 对应 | 差异 |
| --- | --- | --- | --- | --- | --- | --- |
| read / list / glob / grep | 允许 | 允许 | 允许 | 允许 | 允许（plan 下只读工具放行） | 一致 |
| 工作区 write / edit | 询问 | 自动允许 | 自动允许 | 拒绝 | build 询问；edit 自动改工作区文件；yolo 少确认；plan 拒绝写入 | 一致。Xueness 的 yolo 仍遵守 disallow 名单 |
| 计划草稿 `<状态目录>/plan-drafts/<会话 id>.md` | 拒绝（按普通区外写入） | 拒绝 | 拒绝 | 仅精确绝对路径允许；内核 `mode=plan` 或 disallow write 时连草稿也拒绝 | plan 连工作流草稿也不写 | **有意更严/不同**：Xueness 给本会话留一份状态目录草稿，ZCode plan 不写任何文件 |
| 本地 exec | 询问 | 询问 | 自动允许 | 拒绝 | yolo 少确认；plan 拒绝有副作用的命令 | 一致 |
| 远程 exec（subject 含 connection、connection_digest、argv） | 询问 | 询问 | **仍询问** | 拒绝 | yolo 会跳过确认 | **有意更严**：yolo 不自动放行远程 SSH。单独的旧参数 `--allow-exec`（未带 `--permission-mode yolo`）仍按原语义放行，包括远程 |
| mcp 调用 | 询问 | 询问 | 自动允许（连接进程仍要 `--allow-mcp` 或 Web 的逐次批准路径之外的既有开关） | 拒绝 | plan 允许非破坏性 MCP | **有意更严**：plan 拒绝 MCP |
| web_fetch / web_search | 询问 | 询问 | 自动允许 | 拒绝 | plan 把 WebFetch/WebSearch 当只读 | **有意更严**：plan 拒绝网页工具 |
| browser_*（gate 种类是 exec，主体不是远程形状） | 询问 | 询问 | 自动允许 | 拒绝 | 视规则；plan 通常拒绝有副作用的浏览器动作 | 一致：按 exec 处理，不把浏览器误判成远程 SSH |
| 子代理 | 子会话只读，`mode=plan` 且 `permission_mode=plan`，不继承父会话的 edit/yolo，不拿到父草稿 | 同左 | 同左 | 同左 | 子代理默认可继承父模式；explore 可到 yolo | **有意更严**：子代理始终只读 |
| 工作流子任务 /expert、/dwf | 已批准的 writable agent 可以写，没有 exec。无 `owner_session` 的操作员运行保持原计划 | edit/yolo 会话的 expert 实现阶段可写，仍无 exec | 同 edit | 拥有者 `permission_mode` 或内核 `mode` 为 plan 时，agent 强制只读，command 节点直接失败 | `/expert` 与工作流子任务以 yolo 启动 | **有意更严**。本轮补上的是：已盖 `owner_session` 的运行在执行时重读会话，plan 天花不能被节点上的 `writable: true` 绕过。读不到拥有者或模式非法时按 plan 失败关闭 |
| 闲时任务 off_peak | `offpeak_create` 走 exec 询问；模型工具强制 `confirm: false`，不能自批。稍后的 agent 节点没有 `writable`，无人值守运行只读，且不写 `owner_session` | 排队仍要批准；执行只读 | Web/CLI 的 yolo 会自动放行这次 exec 排队，但执行仍只读，且不能自批 | 拒绝排队（exec） | 无直接对应 | **有意更严**：不因为会话是 yolo 就把闲时任务变成可写 |
| app-server `turn/start` | 接受 `permissionMode` | 接受 | 接受 | 接受，真正是否可用仍由 sessions 运行路由决定（插件关闭则 403） | IDE 驱动同一套 mode | 词表已与 `PERMISSION_MODES` 对齐。此前 app-server 已接受 plan，不是缺入口 |
| CLI `run` / `chat` | `--permission-mode build` 或省略：默认拒绝，旧的 `--allow-write/edit/exec/network/mcp` 仍生效 | `--permission-mode edit` 自动允许工作区写/改，不自动 exec | `--permission-mode yolo` 自动允许写、改、本地 exec、网络；远程仍询问；不因此自动拉起 MCP 进程 | `--permission-mode plan` 映射为只读 + 本会话草稿。省略该参数时，已保存的 plan 会继承为天花；已保存的 edit/yolo **不会**被 CLI 静默套用，也不会被这次调用改写 | `--mode build\|edit\|plan\|yolo`；`--prompt` 默认 yolo | **已补齐**：过去 CLI 没有 `--permission-mode`。聊天 `/mode plan` 仍设置内核 `mode=plan`（连草稿也拒绝，与既有行为一致）；`/mode edit` 与 `/mode yolo` 不能抬起这个内核天花，`/mode build` 可以。旧参数保持兼容 |
| 轻量档 | 工具栏不提供权限控件。服务端用已保存模式，否则 build。`read_only` 会话会去掉变更类工具，Gate 仍执行 | 同左 | 同左 | 同左 | 无同名档 | 不是漏洞：省略控件不等于放行 |

todo_write、ask_user、planning（含 workflow_create / workflow_amend）、tool_search 不属于工作区写入。plan 下仍允许，这样会话可以记待办和起草工作流，但不能 `workflow_run`（那是 exec）。

## 本轮修过的不一致

- CLI `run`/`chat` 没有统一的 `--permission-mode build|edit|yolo|plan`。plan 映射为只读加草稿；yolo 不自动放行远程执行；`--allow-*` 与 `--mode` 仍可用。
- 动态工作流和专家工作流的子任务在执行时不看父会话当前模式。已批准的 `writable` 节点在会话稍后改为 plan 后仍能写工作区；command 节点不经 Gate。现在有 `owner_session` 时按 plan 天花收紧。会话绑定的 expert 会写上 `owner_session`。无主的操作员工作流不改语义。
- 子代理没有记下 `permission_mode=plan`，也没有显式挡住远程执行。子会话现在带上这两项，写权限仍然是关的。
- `permission_mode` 的合法值在 WebGate、专家工作流、app-server、HTTP 错误文案里各写一份。现已只保留 `PERMISSION_MODES`。
- Composer `prepare` 接受 `permission_mode` 但不校验。非法值现在返回 400。合法值仍然不授权，授权只发生在运行路由。
- `xueness run <id>` 省略 `--mode` 时会把已保存的内核 plan 写成 build。现在省略时继承内核 plan，不再抬起。

## 有意不照搬 ZCode 的地方

这些差异更严，或是已经对外的安全语义。本轮没有放宽：

- 内核 `mode=plan` 压过 `permission_mode=yolo`，也压过计划草稿。
- yolo 不自动批准远程 SSH，并且仍然先看 disallow。
- plan 拒绝 web_fetch、web_search 和 MCP。ZCode 把前两者和非破坏性 MCP 当只读。
- 子代理不继承 yolo/edit 的写权限。
- `/expert` 与工作流子任务不升级成 yolo，也不获得 exec。实现阶段只在会话本身是 edit 或 yolo 时可写。
- 闲时任务的无人值守 agent 保持只读，且模型不能自己批准计划。
- 工作台的「计划模式」勾选继续表示内核天花，不改成 `permission_mode=plan`。改成后者会让草稿变得可写，等于放宽这个勾选。
- 本地 argv 以 `ssh` 开头不算远程执行。远程只认 connection + connection_digest + argv 这一组 JSON 字段。
