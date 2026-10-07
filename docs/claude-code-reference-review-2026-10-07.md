# Claude Code 参考审查（2026-10-07）

后续按用户要求借鉴任务执行思路，新增 `planning.work_policy`，以原有插件挂接点注入标准／轻量两套原创规则；不引入上游安全审查或拒绝策略提示词。说明见[Agent 工作规则](agent-work-policy-2026-10-07.md)。下文保留前次源码与上下文连续性审查结果，提示词改进并不代表供应商证据兼容问题已解决。

本轮按用户要求，在会话优化收尾前阅读 3 月源码快照和 9 月提示词，并与 Xueness 当前实现逐项对照。只读取相关实现和提示词片段，没有运行镜像项目，也没有把其代码、完整提示词或环境配置复制进产品。

## 来源与范围

- 3 月事件是 **2026-03-31 的 npm source map 暴露**，不是正式开源发布。最终找到仍保留 TypeScript 的 [sthiou1/claude-code-snapshot-backup](https://github.com/sthiou1/claude-code-snapshot-backup)。GitHub API 核对唯一快照提交为 `618cae4cb7235ba0c9b1efdf7db5ce164c58c1b1`，提交时间 4 月 5 日，提交说明称其保存 3 月 31 日快照；未独立验证其与原 npm 包逐字一致。本次重点阅读 `query.ts`、`services/compact/compact.ts`、`tools/AgentTool/AgentTool.tsx` 的相关路径，不声称读完全部源码。
- 9 月资料采用 [asgeirtj/system_prompts_leaks 的 9 月 22 日版本](https://github.com/asgeirtj/system_prompts_leaks/blob/a03321b094e65cad2ccd1f5ffb4b309537648834/Anthropic/claude-code/claude-code-opus-5.5.md)，提交 `a03321b094e65cad2ccd1f5ffb4b309537648834`。同时核对 9 月 27、29、30 日的更新记录，避免将当前 10 月文件冒充 9 月原文。这是社区采集的运行上下文，混有工具说明、用户配置与环境信息，不能证明全部内容均为 Anthropic 官方固定提示词。
- 行为交叉验证使用官方 [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)、[Create custom subagents](https://code.claude.com/docs/en/sub-agents)。研究论文 [Dive into Claude Code](https://arxiv.org/html/2604.14228v1) 仅作结构线索；表内结论回到实际快照、官方文档及本地实现验证。

## 可迁移思路与本地结论

| 思路和直接依据 | Xueness 当前情况 | 判断／归属 |
| --- | --- | --- |
| 先限制工具结果，再逐级缩小上下文；不同恢复路径有次数上限。[query.ts](https://github.com/sthiou1/claude-code-snapshot-backup/blob/618cae4cb7235ba0c9b1efdf7db5ce164c58c1b1/src/query.ts) | `core.compact` 已有工具结果遮罩、整体交换保留与持久 journal；providers 的轻量视图保留人类要求、分页结果及有界摘要。超预算明确报错，不伪造可用空间。 | 保留现有方向。不要直接搬入多个实验压缩开关。后续加强压缩策略的可解释展示，归属 `providers.budgets`、`providers.budget_feedback`、`providers.checkpoints`。 |
| 压缩后的输入由明确边界、摘要、保留消息和恢复附件组成；重新带回计划、已使用技能及仍未收集的异步任务。[compact.ts](https://github.com/sthiou1/claude-code-snapshot-backup/blob/618cae4cb7235ba0c9b1efdf7db5ce164c58c1b1/src/services/compact/compact.ts) | planning 已在每次请求注入当前目标。本轮补齐当前回合未收集的子任务 ID／最后状态（最多 8 项），以及成功读取技能的按需重读索引（最多 6 项、提示最多 3000 字符）；压缩后无需等到提前结束才取得任务 ID。 | **已按需实现** `subagents.context_restore` 和 `skills.context_restore`，复用现有插件挂接点，不导入快照代码。只提示当前启用插件及当前 agent 的索引，不复制子任务结论或技能全文，不扩大权限，不作为完成证据。 |
| 子代理的前台、后台和取消生命周期明确，后台任务有独立身份。[AgentTool.tsx](https://github.com/sthiou1/claude-code-snapshot-backup/blob/618cae4cb7235ba0c9b1efdf7db5ce164c58c1b1/src/tools/AgentTool/AgentTool.tsx) | `subagents/coordinator.py` 已实现后台派发、最多 4 个工作线程、结果收集、依赖等待说明、停止／禁用取消，以及未收集结果时拦截结束。摘要不进入直接工具证据。 | 已具备用户要求的核心机制，不重复造一套团队系统。独立工作存在时继续执行；仅依赖结果、审批、用户停止、失败或预算边界时等待／暂停。这里保证的是调度行为，不能保证模型在网络等待期间持续内部推理。 |
| 提示词将宿主规则、记忆索引、能力描述和工具协议分开；后台子任务输出经收集后汇入主任务。[9 月提示词](https://github.com/asgeirtj/system_prompts_leaks/blob/a03321b094e65cad2ccd1f5ffb4b309537648834/Anthropic/claude-code/claude-code-opus-5.5.md) | Xueness 已有短版轻量 system、按插件注入完成规则、技能目录及 `skill_read`。仍需针对实际供应商检验最终证据协议；本轮真实方舟回答呈现正常 Markdown、命令也成功，但未提供可验证的结构化引用。 | 继续采用短规则和真实兼容测试，避免复制巨型提示词或猜测私有推理参数。最终回答／证据修复归属 sessions 与 providers；保留“工具执行成功”和“交付检查”两种状态。 |
| 技能全文和额外工具按需加载，子任务拥有单独上下文，只回传必要结论。[官方上下文说明](https://code.claude.com/docs/en/how-claude-code-works#manage-context-with-skills-and-subagents) | 轻量模式的 `select_tools` 已提供初始最小工具、`tool_search` 和结果分页；未收集任务时强制保留 `task_collect`。标准模式仍会传入完整启用工具 schema。 | 轻量模式已有。可将按需发现作为标准模式的可配置策略，但要先验证模型工具兼容、MCP、禁用和预算边界，不能只在 UI 增加开关。归属 providers，并依赖相应工具插件。 |
| 后台子代理可以继续工作，权限请求有清楚的来源。[官方子代理说明](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background) | Xueness 当前子代理只读，宿主 Gate 强制限制，不能通过提示词扩大。主会话的单次审批在本轮实机测试发现历史成功误消除新拒绝，已修复并回归。 | 当前保持只读边界。未来若允许写入子代理，应先设计隔离工作区、准确审批和回收，不直接照搬更高权限。所有新产品能力仍作为插件登记。 |

## 本轮实际落地与后续优先级

本轮会话修复见 [ZCode 实机对照记录](conversation-zcode-review-2026-10-07.md)：提交立即清空、接受 ACK 和生成完成分开、思考／说明／工具排序、多轮 journal 对齐、安静的工作过程与终端输出、长标题单行，以及新一轮待审批恢复。它们是在 Xueness 原有实现上修复，不是导入 Claude Code 快照。

参考审查后，经用户授权，本轮额外落地了有界任务状态与技能索引恢复，见[实现与边界](context-continuity-2026-10-07.md)。仍待后续处理的是 **供应商最终证据兼容 → 标准模式按需工具发现**，不能将这次索引恢复当作已修复真实模型的最终引用行为。每项扩展仍须在所属插件登记；本轮目录新增两个子功能，没有新增插件包或扩大共享内核白名单。

不能从这些资料推导小模型性能提升数值、供应商缓存收益或显存占用；需要对同一模型、相同权限和相同任务作真实测量。任何缺失的用量或验证信息继续明确显示不可用／未检查。
