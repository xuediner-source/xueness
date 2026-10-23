# Z8 守护执行、会话目标与项目记忆

本文记录 Xueness 对 ZCode v3.15.1（`aac4755666d09fdcd70272fcf063c077a639015f`）相关机制的选择性适配。功能由现有 planning、memory、sessions、providers 与 remote 插件承载；这不是完整上游兼容，也不把权限提示包装成系统沙箱。

## 守护执行

权限模式仍有 `plan`、`build`、`edit`、`yolo`、`guarded` 五种，默认是 `build`；用户需主动选 `guarded`。网页主工作台和轻量工作台的 composer 权限选择器、分屏 pane 选项菜单，以及 CLI `--permission-mode guarded` 和聊天 `/mode guarded` 都能选择该模式。CLI 示例：

```sh
xueness run <session-id> --permission-mode guarded
xueness chat <session-id> --permission-mode guarded
```

`planning.guarded` 使用有限的命令分类器，只分析 POSIX/Git Bash 与 PowerShell 中已知的危险命令形状。命中已知规则的 exec 调用会在既有 allow 规则前逐次请求批准；普通或未命中的调用沿用 `yolo` 的放行语义。Windows CMD、无法可靠解析的 opaque 命令和 classifier 的 `unsupported` 结果不代表安全，也不形成沙箱；不能据此推断未知命令会被拦截。该模式不限制进程可访问的操作系统资源，也不提供自动安全保证。

`shell-parse.ts` 位于 contracts，是无 I/O 的共享解析合同；permissions 保留兼容重导并使用 guarded policy。Z8 没有扩展通用 Gate 只读白名单。只读子代理和工作流的 `edit` 文件能力仍受各自已有权限上限约束，不因主会话选择 guarded 而放宽。

## 会话目标

`planning.session_goal` 将目标、稳定 id、状态、历史和可选预算写入该会话记录。`summaryTitle` 从目标首段确定性归一化并限为 80 个 Unicode 码点，不另调模型生成标题。支持状态包括 `active`、`paused`、`blocked`、`budget_limited`、`complete`、`achieved` 与 `cleared`；目标会在每次请求读取当时的状态，包括暂停或清除状态。模型可用只读 `goal_read` 查看当前会话目标、公开状态、预算与已报告用量。

CLI 入口为 `xueness goal --session <id> show|set <text>|replace <text>|pause|resume|clear|budget --budget <json>`。替换已有目标需显式选择 `replace`；网页在会话输入框上方显示目标摘要和状态，展开可查看全文和历史，具体预算可通过 goal show 查看，运行中可暂停目标，暂停、受阻或预算到限后可显式继续。native protocol 暴露六个会话/工作区范围方法：`goal/read`、`goal/set`、`goal/pause`、`goal/resume`、`goal/clear`、`goal/budget`。

目标 driver 可在一次 run 内继续推进并验证目标，但没有后台自动恢复 runner。运行中的暂停先写入 live 目标状态，再中断并排空当前执行；恢复必须由用户显式发起，并沿用累计用量。预算（`maxRounds`、`maxWallSeconds`、`maxTokens`）按完整对象替换，`{}` 清除上限；其限制作用于跨 continuation 的目标，不会在每一轮重置。即使一轮结束时目标仍未完成，系统也不会在之后自行启动新 run。

## 项目记忆与显式 dream

已有 memory 插件读取三个整理轨道：全局 `MEMORY.md`、用户偏好 `USER.md`、当前项目 `projects/<项目哈希>/KEY.md`。`memory.context` 在模型请求前注入只读记忆并标为不可信数据；标准档和轻量档采用各自请求格式。既有 memory HTTP editor 可读取带 SHA-256 的轨道，并要求显式确认及 digest 匹配才写入。设置关闭 memory 或未配置记忆根时不注入。Dream 是 `memory.dream` 的另一条显式工作流，不会把原本只读注入改成自动整理。

基本操作：

```sh
xueness memory-dream propose --session <owner-session> [--source <source-session> ...] [--name <name>]
xueness memory-dream list --session <owner-session>
xueness memory-dream show <dream-id> --session <owner-session>
xueness memory-dream start <dream-id> --session <owner-session> --digest <startDigest> --approve --allow-real
xueness memory-dream show <dream-id> --session <owner-session>
xueness memory-dream apply <dream-id> --session <owner-session> --digest <applyDigest> --approve
```

`propose` 只存输入快照，不调用模型。默认来源是同一 canonical workspace 中最近最多五个非当前主会话；`--source` 可显式指定 1–20 个来源，包括当前空闲的主会话。跨 workspace、remote、子代理和工作流内部会话会被拒绝。快照只取近期 user/assistant 纯正文，所有来源合计上限 40,000 个 Unicode 码点；system、思考内容、模型原始 I/O 和 tool 输出不会作为 transcript 输入。来源会绑定 session/message id 与内容 hash。草稿的 `startDigest` 同时绑定项目根、所选来源快照和当时的 KEY 内容 digest；开始前若来源或 KEY 已变化，返回冲突而不提交模型请求。

`start` 必须提交草稿返回的精确 digest、`--approve` 和 `--allow-real`；memory、providers 与宿主 real-model 开关都必须允许请求。它只向所选 provider 发送一次严格 JSON handoff，不注册工具、不进入工具循环。候选 JSON 必须恰为 `{content,summary,sourceSessionIds}`，内容为完整 KEY 候选，UTF-8 不超过 100 KB，摘要最多 1,200 个 Unicode 码点，所列来源必须是本次选择的 session。模型报告的 usage 原样保存；provider 未报告时记为 `unknown`。状态为 `ready` 只表示候选可审阅，不写磁盘。CLI 的 start 等待此次 job 完成后返回，之后可用 `show` 查看候选。

只有用户审阅后执行 `apply` 才会写入项目 `KEY.md`。批准 digest 绑定候选、项目根和来源；应用时会重新核验来源快照与 KEY 基线，再调用现有 memory track writer 的 CAS。digest 或基线不匹配时不会覆盖新编辑；plan/read-only 会话不能应用。重复提交已应用的同一 digest 返回既有结果而不重复写入。Dream 永不改全局 `MEMORY.md` 或 `USER.md`，也不能指定任意文件路径。

草稿和结果保存在私有状态目录的 `memory-dreams` 中；真实 job 由创建它的当前 host 持有并使用每 workspace lease 互斥。未知的历史 `running` 状态不会自动恢复，用户需取消后新建 proposal。插件或 general memory 开关关闭、或 ApplicationApi 关闭时会中断并排空当前 job；不会自动应用候选。HTTP 归属 `/api/sessions/:id/memory-dreams`，只允许 collection GET/POST、dream GET，以及 `start`、`cancel`、`apply` 三种 POST 操作。native protocol 暴露六个方法：`memory/dream/list`、`propose`、`get`、`start`、`cancel`、`apply`。

这是一条用户启动、用户审阅和用户批准的适配路径；没有自动 dream scheduler，也没有 ZCode 上游那种由完整工具循环驱动的 dream。源码验收记录见 [z8-memory-source.json](../../验收资料/验证记录/z8-memory-source.json)：该记录覆盖四个 memory 场景、五次 loopback provider 请求。
