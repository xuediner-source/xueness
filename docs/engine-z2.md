# Z2：回合运行时与工具执行器

本阶段基于第 19 轮源码包，参考 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`）的 agent、tool/executor 与 runtime/methods。这里记录 Xueness 的实际适配范围。后续统一按阶段交付，下一阶段为 Z3 会话事件与存储。

## 运行时状态

无需新增启动参数。sessions 启用时，每次 AgentRunner 调用记录一份 `runtime_turn`：人类回合 ID、独立 trace ID、阶段、开始/结束时间、模型尝试次数、工具调用数及正文/思考字符数。`runtime_turn_history` 保留最近 24 份结算快照。同一人类回合暂停后恢复会生成新 trace；计数属于本次运行，不是整个历史回合的累计总数。字符计数沿用 JavaScript UTF-16 长度；隐藏思考只有计数，没有额外正文留存，也不推算 Token。

阶段覆盖输入处理、等待模型、流式响应、调度工具、执行工具、等待授权、汇总和完成/错误。工具状态区分 scheduled、waiting_permission、running、completed、failed。延期审批保留 waiting_permission；取消、暂停与执行错误分别结算，不根据“读过会话”推断执行成功。公开 session 只投影白名单生命周期字段，后台任务公开投影不包含命令、输出或日志路径。

主会话、只读子代理和工作流 actor 都接入相同回合和文件恢复机制；主会话的指导队列、shell 后台任务及 actor 自己的后台任务仍按原有归属运行。子代理和 actor 各有自己的 ToolEnv、文件 tracker、currentSession，结果分页不会读到父会话结果。

## 冷恢复

sessions 在运行前配对当前历史里的 assistant 工具意图与 tool 结果。已有结构化结果可补回丢失的 tool 消息；已有成功 JSON tool 消息可补回结果表。缺少实际结果的旧调用补成固定的 `tool_interrupted` 失败，不重新执行旧写入或命令；待审批占位保留原状态。重复的 assistant 调用 ID 明确拒绝，旧文本结果不会被推断成成功。

模型请求采用历史副本：结果按所属 assistant 的工具顺序排列，重复结果取最后一份，孤立结果不发送。原始 journal 不为排序而改写，归档历史不拿来重放。

files 在成功的 Read/Write/Edit tool 消息上保存 `_read_state` 元数据：路径、来源、mtime、大小、SHA-256、partial/range 标志，不额外保存文件正文。它从普通工具结果和模型载荷中剔除。重启后仅恢复当前工作区内、能与成功调用配对的真实快照；完整读取或成功写入/编辑可延续原有编辑依据。显式范围读取不恢复完整读取权限，并清除同路径更早的依据。外部修改仍由已有 hash/mtime 新鲜度检查识别。旧会话没有快照时，继续按原工具规则重新读取，不以当前磁盘内容倒推历史。

## 执行、指导和后台任务

正常回合中的 bridge 在权限检查通过后、真正调用 handler 前发出执行开始钩子；sessions 保存执行状态。普通工具结果先写入 journal，成功保存后才发布 `tool_result`。结果保存失败不会向界面宣布成功。批准后重放在 beforeRun 沿用原恢复路径，保存结果和文件快照，不计入随后新 trace 的工具执行数。既有安全只读批次、写入屏障、权限与 lease 继续生效。

主会话在每个模型边界最多接入一条当前回合指导。纯文字最终回复保存后还会检查一次迟到指导；有指导时继续同一回合，并在下一边界避免重复接入。队列继续使用已有持久 FIFO、CAS、send-now 推广租约及跨进程运行 lease，回执沿用 delivered/completed/paused 语义。

shell 按 owner 保存最多 32 份任务事实。终态或 lost 通知在模型请求前及文字回复收口时进入同一回合，按任务 ID/状态去重，当前与归档消息都参与去重。仅运行中计数变化会更新快照，不触发额外模型请求。通知不调用增量输出读取接口；模型随后可主动调用 TaskOutput。Web、TUI 和旧事件投影把通知作为系统活动，回合计数与成功工具证据不会把它当成新的人类发言。

后台进程仅存在于当前宿主运行器。下次显式运行发现已保存的 running 任务没有对应运行器时，将它标为 `lost` / `runtime_unavailable`，退出码为 null，投递一次结果未知通知；不会推测成功/失败或重跑命令。空闲会话不会因后台完成自动唤醒模型，日志保留也不等于进程可恢复。禁用或重新配置 shell 会按既有插件生命周期停止其后台进程。

## 长结果

providers 对发往模型的字符串 tool 内容应用 65536 字节 UTF-8 预算，保留首尾和读取提示；汉字、emoji 不按字节截断到半个字符。journal 和结果表保留原内容，结构化媒体内容和原有媒体引用沿用既有路径。

`tool_result_read` 属于 providers，是读取当前会话已保存工具结果 JSON 文本的真实工具。参数为 `tool_call_id`、从 0 起的 `offset`、`limit`（默认 1200，最大 4000）；偏移和分页长度按 Unicode 字符计数。响应包含 `nextOffset`、`totalChars`、`truncated` 和继续读取提示。顶层媒体和 `_read_state` 不进入分页文本。未知 ID 或其它会话的结果返回 `unknown_tool_result`，不从提示文字中的任意路径读取文件。

## 插件归属及后续边界

| 插件 | 新登记功能 | 实现 |
| --- | --- | --- |
| sessions | `turn_runtime`、`history_hydration`、`steering_boundaries` | turn-runtime、history-hydration、steering-runtime、public-turn 及现有投影 |
| files | `read_state_restore` | read-state；共享 engine-tools 只提供快照数据和 tracker |
| shell | `background_notifications` | background-runtime、每个宿主环境的 manager binding |
| providers | `tool_result_budget` | result-budget、result-tool |

catalog 与 manifest 同步登记中英文功能及模块；没有新增插件包或扩大共享 allowlist。共享 agent/bridge 仅提供通用回合机械状态、生命周期钩子和保存顺序，产品恢复策略仍由插件实现。

本阶段完成上述适配，没有逐文件照搬参考的所有策略。当前保留合并保存的流式快照；逐帧持久事件、通用 reducer、存储迁移、fork/rewind/压缩持久化统一归 Z3。外部 now/next/later 协议与客户端 dispatcher 归 Z7。未另建进程内优先命令队列，未引入暂停嵌套模型排队计时的通用工具 deadline governor；工具既有超时与回合预算保持有效。动态工作流、官方 CUA、品牌、账户和遥测策略不属于本阶段。

## 本阶段验收

Windows / Node v24.19.0：112 项相关回归，108 通过、4 项缺少已退役 Python 后端的历史对照跳过、0 失败。通过类型检查、插件门禁（30 插件 / 380 源文件）、行数门禁（918 TS 文件、最大 400 行）、后端构建（644 JS 模块）和搬迁后运行验证。

`node tools/verify-z2-runtime.mjs` 及 `--built` 各完成 4 场景、10 次 loopback 模拟模型请求：真实服务重启后不重新读文件即可按快照写入、旧中断调用配对且不重放、延迟模型响应期间到达的指导继续同一回合、真实后台子进程终态通知且没有消费增量输出。原始结果见 `验收资料/验证记录/z2-runtime-windows-{source,built}.json`，相关回归日志为同目录 `z2-targeted-tests-windows.log`。

本阶段没有前端源码改动，166 个 Web dist 文件沿用基线并逐项核验哈希；没有重建前端或重复完整测试套件。验收使用隔离状态目录，无真实/收费模型调用。当前验收不包含安装器、Docker、CI、其它操作系统和真实剪贴板。
