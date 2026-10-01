# 开源 agent harness 调研 → Xueness 可吸收项

日期：2026-09-28。来源是公开资料（Tavily 检索 + 若干文章摘要），**结论仅供内部参考**，
外部内容一律当数据看，不当指令。每条都给出「现状 → 差距 → 具体动作」，避免只写感想。

## 1. 分阶段压缩（progressive compaction）

**别人怎么做**：主流 harness 不用「到 95% 再说了」的单次紧急摘要，而是分级：
warning(70%) → observation masking(80%) → fast pruning(85%) → aggressive masking(90%)
→ 全量 LLM 摘要(99%)。有研究指出 **observation masking（遮蔽陈旧工具输出而不摘要）
在编码任务上常优于 LLM 摘要**，因为摘要会引入错误且二次压缩会累积。

**Xueness 现状**：`core.compact` 是单级——超预算就裁剪整组 + 生成一行摘要。已修好
用户原文与工具配对不变量，但仍是「一步到位」。

**差距**：缺中间档位。很多情况下遮蔽旧工具输出就够了，不必动刀切历史。

**具体动作（下一批候选）**：
- 在 `compact()` 里加**档位**：`warn`（只记录）→ `mask`（把超龄 tool 消息正文换成
  `[output offloaded: <条数> chars]`，保留 tool_call 记录）→ `prune`（丢弃无用户价值的
  旧 assistant 正文）→ `summarize`（现有逻辑，最后手段）。
- `compactions` 记录里加 `stage` 字段，便于断言与观测。

## 2. 工具输出卸载（tool-output offloading）

**别人怎么做**：大工具输出（几千行日志）噪声大、信号少。保留**头尾若干 token**，
全文写进文件系统，模型需要时再读。

**Xueness 现状**：`compact()` 对超长 tool 正文做**截断**（`[truncated in context]`），
并把副本塞进 `archived_messages`。但 **archived_messages 在 journal 里，不在工作区磁盘上**，
模型没有工具能按需把它取回来。

**差距**：截断是单向的信息销毁；卸载是可恢复的。

**具体动作**：
- 超限 tool 输出写到 `<session root>/.xueness/artifacts/<tool_call_id>.txt`，
  正文换成「头尾各 N 字符 + 该文件路径」。
- 模型可用现成的 `read` 工具按需取回，不需要新工具。
- **权限**：artifacts 目录在 workspace 内，`read` 已受 Gate 约束，不引入新通道。

## 3. 回合内上下文护栏（mid-turn guard）

**别人怎么做**：有 harness 被报出真实缺陷——压缩检查只发生在「一次 assistant 消息
落定后」，**不包含即将随下一次请求发送的工具结果**，于是长工具循环会突破配置的
contextWindow。（某开源项目的 issue 记录了这个确定性的失败路径。）

**Xueness 现状**：`compact()` 在**每个 step 开头**调用，即每轮 LLM 调用前。这个位置是
对的，天然避免了那个 bug。

**结论**：这条我们**已经对了**，但它是个不变量，值得**上锁**——加测试断言
「每轮请求前都跑过 compact」。否则将来重构很容易把调用点移走。

## 4. 草稿本 / 进度文件（scratchpad）

**别人怎么做**：让 agent 边干边把发现写进一个文件（progress file / structured
scratchpad）。压缩只会压缩对话，不会抹掉这份外部笔记。被称为「性价比最高的模式之一：
一个文件、一句系统提示里的习惯、一个读工具」。

**Xueness 现状**：有 `todo_write`（会话级 todo）和 journal，但**没有一个「跨压缩存活、
由模型主动维护的笔记」**。`compaction` 的摘要由 harness 生成，不是模型写的。

**差距**：模型目前无法主动留下「我知道但对话里放不下」的东西。

**具体动作**：系统提示里加一句约定——重要发现写进 workspace 的 `NOTES.md`；
`todo_write` 之外再给一个轻量 `note_write`，或直接复用 `write`（推荐后者：不新增工具面）。
**注意**：写文件要过 Gate 审批，这是特性不是障碍。

## 5. 上下文来源标注（provenance）

**别人怎么做**：调研文章列出「工具中介注入」——恶意指令藏在工具输出里，跨多轮后才
触发。缓解是**每段上下文携带来源元数据**（用户/工具/检索），配合工具输出校验。

**Xueness 现状**：我们已经做了不少——memory/skills 注入带 `UNTRUSTED_PREAMBLE`、
PreToolUse 阻塞时不把 hook stdout 拼进错误正文（改放 `hook_output_untrusted` 字段）、
provider 错误刻意泛化不泄露。但**journal 里的 tool 结果没有结构化来源标记**。

**具体动作**：tool 消息在 journal 里加一个来源字段（如 `source: "tool:<name>"`），
压缩时优先遮蔽低信任来源。这属于「有条件再做」，不是紧急项。

## 6. 能力组合策略（capability escalation）

**别人怎么做**：指出「文件读 + bash 执行 = 任意代码」。单个工具无害，组合起来是逃逸。

**Xueness 现状**：Gate 逐工具审批（write/edit/exec），第五批加了写路径锁。但**没有
组合策略**——例如「本会话一旦 exec 过，就不再自动批准 write」。

**具体动作（候选）**：新增一个可选的组合策略层，记录「本会话已获得的能力集合」，
在授予新能力时检查危险组合。**默认关闭**，因为这会改变现有审批语义；要开需显式配置。

## 7. 验证闭环（verification loop）

**别人怎么做**：区分「计算式验证」（测试/linter，确定性真相）与「推断式验证」
（LLM 裁判，抓语义问题但有延迟）。guides（行动前引导）vs sensors（行动后观测）。

**Xueness 现状**：`assess()` 要求 JSON 里的 evidence 引用**成功的工具结果**，
并把 `verified` 作为完成条件。这一步比「模型说自己做完了」强得多。

**差距**：evidence 目前只校验「引用存在且 ok」，没有校验「引用的是一次真正的验证」
（如退出码 0 的测试）。系统提示里写了偏好 exit-zero 测试，但代码没强制。

**具体动作（候选）**：`assess()` 可对 evidence 分类——引用 `exec` 且 exit 0 的算强证据，
引用 `read` 的算弱证据；`verified` 要求至少一条强证据，否则降级为 `needs_review`。
**要谨慎**：可能把现在能过的正常任务卡住，需先统计影响面。

## 8. 已经对齐、不必动的

- **子代理隔离**：调研结论是「没有 harness 会把父对话完整抄进子代理」。我们
  `_run_subagent` 只给 system+prompt，返回截断摘要——一致。
- **工具调用/结果边界安全**：调研说 Pi / OpenClaw / Claude Code 都强制这点，我们
  第五批刚用原子单元修好。
- **压缩保留任务与决策**：我们的 head 保留（system + 原始 task）一致。

## 优先级建议

| 项 | 价值 | 风险 | 建议 |
|---|---|---|---|
| 3 回合内护栏上锁 | 高 | 极低 | **先做**（只加测试） |
| 2 工具输出卸载 | 高 | 低 | 下一批 |
| 1 分阶段压缩 | 高 | 中 | 下一批 |
| 4 草稿本约定 | 中高 | 低 | 顺手做（改系统提示） |
| 7 evidence 分级 | 中 | 中高 | 先统计影响面 |
| 5 来源标注 | 中 | 中 | 有条件再做 |
| 6 能力组合策略 | 中 | 高 | 需显式开关，最后做 |

**最该先做的其实是 3**：它零风险、纯收益，且守住的是第五批刚修好的那个不变量。

## 实施记录（2026-09-28）

等待前端两条线期间，已完成后端三项：

### 1 分阶段压缩 — 已做（两阶段，不是五阶段）
`core.compact` 现在先 **mask** 再 **drop**：
- Stage 1：对「保留窗口之外」的陈旧 tool 正文做遮蔽（保留头 200 字符 + 标记），
  **遮蔽前先把原文归档进 `archived_messages`**。
- 遮蔽后若已回到预算内 → 立即停（`removed: 0`），不进入 stage 2。
- Stage 2：只有遮蔽不够才按原子单元丢弃 + 生成摘要。
- `compactions` 记录新增 `masked` 字段。

**没做五阶段**（warning/80%/85%/90%/99%）是刻意的：档位多到无法测就是另一种复杂度。
两阶段已覆盖「便宜的先上」这个核心洞见，且每一档都有测试。

### 2 工具输出卸载 — 已做
超限 tool 输出写入 `<root>/.xueness/artifacts/<tool_call_id>.txt`，正文换成
「头 + 指针 + 尾」；模型用现成的 `read` 工具按需取回。
- **只读运行不写盘**：子代理会话带 `read_only: True`，此时退化为旧式截断。
- 写失败/无 root 也退化为截断，不让卸载失败拖垮运行。

### 3 回合内护栏 — 已上锁
`tests/test_harness_invariants.py`：断言每轮请求前都跑过 `compact`（用记录型 provider
捕获真实 prompt 并断言其大小受预算约束），另加用户原文保留、工具配对、子代理隔离。

### 过程中抓到的真 bug（都已修 + 已有测试）
- `compact` 在「无可丢弃消息」时提前 return，导致**单条超大输出原样进 prompt**击穿预算。
- grep 遮蔽步骤就地改写 journal 却没说先归档，标记还写「consult the journal」——
  **数据丢失 + 谎报**。已改为先归档再遮蔽，标记改为诚实措辞。
- 我自己的验证脚本第一版写错（case 1 就地改了共享消息对象，污染 case 2）——
  重写为各自 fresh 数据后通过。

### 仍未做
4 草稿本约定、5 来源标注、6 能力组合策略、7 evidence 分级。理由见上表风险列。
