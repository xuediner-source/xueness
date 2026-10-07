# ZCode 实机对照与会话修复（2026-10-07）

## 对照依据

本轮直接打开 `/Applications/ZCode.app`，截图检查已有会话的工作过程折叠、思考展开、终端详情；随后在 ZCode 和安装版 Xueness 中新建测试会话，发送完全相同的消息：

> 这是会话界面验收。先用一句话说明准备检查什么，再使用终端只执行 pwd 和 printf 'Xueness conversation UI test\n'。不要读取、编辑或删除文件，不联网。最后给出包含两条清单和一个简短代码块的结果。

ZCode 使用其已选 GLM-5.3-Flash，Xueness 使用其已配置方舟 DeepSeek V4.1 Flash，未切换提供者或模型配置。最初对照沿用原有权限选择；新版新会话按默认逐项审批，只批准请求中的 `pwd` 和 `printf`，未开启完全访问。两边均实际完成终端调用并显示结果。模型、权限选择、上下文和窗口尺寸不同，因此没有把本次观察当作模型速度、成本或质量基准。

同时核对官方 [zai-org/ZCode](https://github.com/zai-org/ZCode) 源码，复核时 HEAD 为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。只读取源码，没有运行其项目或加载其中的可执行扩展。

| 实机／源码依据 | Xueness 原问题 | 本轮调整 |
| --- | --- | --- |
| [ConversationComposer](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationComposer.tsx)：提交时先认领并清空草稿，拒绝才按 revision 恢复 | 已有会话的已发文本一直留到模型结束；按钮成为“加入队列”，可能重复提交 | 标准／轻量编写器提交时立即清空；`/messages`、创建或入队成功的 ACK 与模型运行完成分开；只恢复未接受且未被新输入改动的草稿 |
| [ConversationTurnGroup](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationTurnGroup.tsx)：过程和最终回答分开 | 过程没有整体折叠；中间说明重复占用消息操作区域 | 每段工具工作一个细分隔线标题，正常完成后默认折叠；异常、运行中、没有最终回答时展开；保留最终回答、完成状态和交互边界 |
| 实机：说明 → 命令 → 后续思考；[conversationAssistantWorkItems](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/conversationAssistantWorkItems.ts) | events.v1 先投影 tool.call，再投影同一回复的文字，导致命令跑到说明前面；无正文的思考回复遗漏；历史 completion 事件导致第二轮以后的文本／思考关联偏移 | sessions 的 journal 展示投影按真实消息与调用 ID 还原顺序，计入各轮历史 completion 事件，支持含附件的用户消息；补回有实际调用支持的纯思考步骤；不修改 journal、事件协议或工具结果 |
| 实机：脑图标、折叠的思考行；[reasoning](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ai-elements/reasoning.tsx) | 通用“思考过程”带左边框和额外留白，流式内容占用正文空间 | 安静单行、手动展开、运行时显示有界最新摘要；尊重思考显示开关。删除 parity-final 中覆盖插件样式的旧规则 |
| 实机：终端摘要单行，展开显示命令和输出；[ToolLayout](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/ToolLayout.tsx) | “终端操作”大卡片、重复成功标签和大块输入 JSON | 取消组外框；显示图标、数量和摘要；成功标签仅供辅助技术读取，失败／运行状态仍可见。已识别的终端结果显示命令和原样输出，退出码只显示实际报告的值；原始数据按需挂载，未知结构继续通用详情，保留失败复制与独立展开状态 |
| [timelineScrollAnchor](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/timelineScrollAnchor.ts) | 流式更新可能打断历史阅读 | 保留已有跟随／释放跟随／回到底部规则，复核真实构建的长时间线虚拟化和历史跳转 |
| 实机：顶部以任务标题为主，正文优先 | 任务标题被 CSS 隐藏，检查与用量面板占据较大高度；启动瞬间出现没有错误文本的重试条 | 恢复单行省略的任务标题；检查区去掉大外框；请求状态、耗时与 Token 收入一行可展开入口；正在提交运行时不显示“重试运行” |
| 实机新会话追加同一测试：`pwd` 再次等待审批却没有审批按钮 | 通用 `pending_denials` 用整段会话中任意成功记录隐藏同名命令的拒绝，误把前一轮成功当成本轮授权 | 只用时间顺序中后来的成功重试消除较早的待审批项；新的拒绝继续显示，单次批准及策略拒绝边界不变 |

折叠选择以真实首个调用 ID 为键。journal 晚到、插入前置说明时不会重置用户的选择。没有真实起止时间的历史标题显示“工作过程”，没有复制 ZCode 的泛化“持续了几秒”文案，也没有把页面挂载时长当成模型思考时长。

## 插件归属与使用

- `sessions.composer`：草稿清空、ACK、拒绝恢复；`sessions.streaming`：journal 展示、顺序、思考行、工具组和整体折叠；`sessions.history`／`sessions.timeline_follow`：历史定位与阅读位置。新增纯展示投影模块已登记在 sessions manifest。
- providers：既有 `providers.activity` 的请求状态与耗时明细折叠；轻量编写器继续复用 sessions 提交边界。
- planning：既有交付检查的紧凑展示，仍分别显示工具执行和交付检查，未把工具成功解释成全部任务完成。
- 容器只传递接受通知并协调已有组件；审批修复位于原有共享 Gate／审批基础设施，不是新增产品能力或共享例外。完整目录仍为 **28 个插件、160 项功能**。

工作过程标题可以展开／收起；正常完成默认以最终答案为主，失败或未完成默认保留过程。工具组和单个工具可以独立展开。请求状态行打开后查看服务实际报告的 Token 和已有步骤耗时；缺失项继续显示 `—`。每次新增产品功能仍必须归属插件。

## 验证记录

- 前端全套 **829/829**，typecheck、生产 build、插件结构／设计／启动 bundle 门禁通过。
- 插件架构单元检查 26 项通过。审批相关 Web 回归 222 项（20 项按环境跳过）通过；实机发现并修复审批判断后，后端全套 **2280 项、41 项按环境跳过，其余通过**。第一次使用系统 Python 时有 3 项因缺少 `python-pptx`／`openpyxl` 报错；改用已包含桌面 Office 依赖的 `/Users/xuediner/code/.xvenv/bin/python` 重跑全套通过，未修改测试以掩盖依赖缺失。
- 最新生产构建的 8 组会话／草稿验收：标准／轻量、明暗、1280／420px；提交立即清空，已接受后的供应商失败不覆盖新草稿，未接受的提交恢复原空白格式；工作折叠保留答案，思考和命令顺序正确。这些用隔离状态与拦截的模型请求验证，未调用真实模型。
- 另外复核标准／轻量的 56 组请求阶段布局、编写器交互和长时间线虚拟化／阅读位置。截图与模拟结果保存在 `/tmp/xueness-conversation-parity-20261007/`，可重新运行 `webapp/verify-conversation-parity.mjs` 生成。
- 本机旧版追加发送已实测复现：生成期间输入仍残留，完成后才清空。新版首次发送与已有会话追加发送均立即清空；生成期间输入的下一条草稿在结束后保持原样，随后仅清理本轮测试草稿。实机复核多轮说明／命令顺序、单行长标题、新一轮审批入口及真实 `printf` 输出与退出码 0。
- 已整包覆盖 `/Applications/Xueness.app`（本机测试版仍为 0.1.5）；源码构建包与安装目录的 2058 项文件／符号链接清单一致，冻结后端及打包应用 smoke 通过。覆盖前旧包保存在 `/Users/xuediner/code/Xueness.app.bak-20261007-164523-before-approval-fix`。没有修改用户会话、工作区、模型配置或插件开关。
- 真实模型输出的命令成功与最终答案正常显示已经确认；它没有提交可验证的结构化完成引用，所以仍显示“工具证据未通过验证”，交付内容为“尚未检查”。这是如实暴露的供应商最终证据兼容限制，没有为视觉对齐改成“全部已验证”。

## 范围边界

这次对齐的是会话过程、提交生命周期和阅读体验。Xueness 仍使用自己的 textarea、Markdown 渲染器、事件协议与权限实现，没有宣称完整复刻 ZCode 的 Tiptap 富文本编辑器、所有预览组件或宿主功能。轻量模式保留自身的简洁时间线。正文内容和任务结论来自各自模型，界面不会虚构供应商未报告的思考时间、Token、交付证据或执行结果。本轮没有提交、推送或发布到 GitHub。
