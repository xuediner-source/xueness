# 供应商请求与响应字段契约（F01.01）

日期：2026-10-24 · 任务：F01.01 · 契约锚点：C-MDL-01 · 机器可读版：[provider-field-contracts.json](provider-field-contracts.json)

本树生产协议入口共两个（`provider-config.ts:29-30,47` 只接受 `openai` / `anthropic`）：

| 协议 | Adapter | 流式解析 | 非流式解析 |
| --- | --- | --- | --- |
| Anthropic Messages（`/messages`） | `ts/packages/providers/src/anthropic.ts:50-230` | `anthropic-stream.ts:69-220` | `media.ts:366-385` |
| OpenAI Chat Completions（`/chat/completions`） | `ts/packages/providers/src/openai.ts:104-275` | `streams.ts:83-148` | `openai.ts:211-235` |

workbuddy（`plugins/workbuddy/src/provider.ts:24,46-49`）、标题/语义/压缩等辅助调用均复用这两个 adapter，无第三协议入口。完整逐字段行（外部字段 → 内部键 → 入口 path:line → 归一函数 → 不支持行为）见 JSON；本文只收摘要、显式 unsupported 清单与确认缺口。

## 六类映射摘要

**tool call**：OpenAI 流式分片经 `NativeCallAssembler`（index 界 0-127、ID 冲突/对象-分片混用拒绝、finish_reason 才 close）；非流式与 Anthropic 终检统一走 `normalizeNative`（tool-protocol.ts:78-108，envelope/ID/参数校验，失败产出内容无关 `_protocol_diagnostic`），进入 driver 有界修复环（driver.ts:173-187）。Anthropic 流式 `tool_use` 有独立身份断言（anthropic-stream.ts:222-236）与「仅 closed 块参与装配」规则（:194）。参数归一绝不把非法 JSON 替换为 `{}`（tool-input-normalization.ts:11-22）。

**reasoning**：Anthropic 全链——流式 thinking/redacted 块与 signature_delta（delta 优先，:245）→ `_reasoning_blocks`（仅签名/redacted 可重放，unsigned 仅显示）→ 请求侧重放 `canonicalReasoning/nativeReasoning` → 跨模型签名剔除与签名拒绝修复（reasoning-history-normalization.ts）。OpenAI 兼容 `reasoning_content/reasoning/thinking` 仅投流式观察者显示，不保留重放（协议无签名，per-protocol 差异，EN-05）。

**usage**：`reportedUsage` 白名单（metadata.ts:7-11）+ `prompt/completion_tokens_details` 细项；派生仅算术（prompt=input+cache_read+cache_creation、anthropic 流 total=prompt+completion，EN-02）；usage 缺失时无 `_usage` 键，不虚构。消费：driver `provider_usage`（≤100 行、4000 字符界）、lightweight `observeUsage` 校准、`model-retry`、空完成异常检测。

**cache**：响应侧 `cache_read_input_tokens` / `cache_creation_input_tokens`（Anthropic）与 `prompt_tokens_details.cached_tokens`（OpenAI）原样保留（两形状不互转）；请求侧断点见确认缺口 **FC-GAP-01**。

**finish reason**：别名表（end_turn/stop_sequence→stop、tool_use/function_call→tool_calls、max_tokens→length、pause_turn→paused、refusal→content_filter、context_length(_exceeded)→context_limit）+ 未识别字符串显式 `unknown`（metadata.ts:57-61）；`incompleteReason` 把 length 算术细分为 output_limit/context_limit/generation_limit 并配 PAUSE_MESSAGES（metadata.ts:69-93）。

**流式事件**：SSE 框架统一（仅 data: 行、行 256 KiB/流 8 MiB 界、空闲超时下限 40s、超时显式 connection_failed）；Anthropic 事件机（message_start 复位/message_delta/三类内容块/delta/stop、error envelope 分类、缺 message_stop 显式失败）；OpenAI 事件机（[DONE]、usage-only 块跳过、完成后有效载荷显式拒绝、非 event-stream 回退 JSON 路径）。

## 不支持字段：显式清单（unsupportedExplicit）

- 未知 finish_reason 字符串 → `unknown`；usage 缺失 → 无键（不虚构计数）
- 未知协议名 / compatibility 键 / lightweightOptions 键 / reasoning effort → 构造期或校验期拒绝
- 媒体能力未声明、MIME 签名不符、媒体预算超限 → 请求前拒绝
- 非法 native envelope、不可归一参数、重复 call ID → `_protocol_error` + 内容无关 diagnostic（有界修复环，耗尽 → needs_review）
- SSE 行/流超限、UTF-8 严格解码失败 → 显式异常
- 流中断（无 message_stop / 无 finish_reason）→ connection_failed
- 零输出异常完成（异常 finish + 零 usage + 无 reasoning）→ EmptyModelCompletionError
- usage 白名单外/越界值 → 不进入 `_usage`（逐 key 白名单制，EN-03）

## 确认缺口（confirmedGaps，转后续轮次）

| ID | 缺口 | 关键证据 | 去向 |
| --- | --- | --- | --- |
| FC-GAP-01 | 请求侧 cache_control 死接线：`prompt/builder.ts:75,77` → `view.ts:54` 写 `_cache_control`，但 Anthropic system 为纯字符串（media.ts:307,358）、OpenAI 先剥 `_` 键后 `system-message-compat.ts:15` 读的无下划线 `cacheControl` 无生产者（死分支）——断点从未发送，内部标记静默丢弃 | 全树 `_cache_control` 生产命中仅 view.ts:54 | F14 验收前补齐批次（涉 system 块状化 + compatibility 开关，本轮禁调真实模型无法验证网关兼容） |
| FC-GAP-02 | 无显式 unsupported 报告通道：Anthropic server_tool_use/web_search_tool_result 等未知块落空 text（anthropic-stream.ts:134-135）、citations_delta 等被忽略（:137-173 无 default）；OpenAI delta.refusal/logprobs 未读取（streams.ts:108-143） | finish 侧 refusal→content_filter 映射已有，缺的是字段级报告 sink | 并入 F01.06 或专项小轮（需与 Python 移植差分测试同步设计） |
| FC-GAP-03 | 剪断 tool_use：Anthropic 在 json 不可解析且 finish∉{stop,tool_calls} 时丢调用、无 diagnostic（anthropic-stream.ts:196-206，终止有显式报告）；OpenAI 同场景保留 invalid 参数并由工具侧自行失败（driver.ts:116-117）——跨协议策略不一致 | anthropic-stream-compat.test.ts 覆盖该行为 | 与 F01.02 失败分类同批（剪断-工具调用结算同族边界） |

## 边缘注记（EN-01..08）

EN-01 `_response_models` 为 write-only 遥测（journal 组装丢弃、树内无读者）；EN-02 usage 派生均为算术并保留原始键；EN-03 usage 越界值逐 key 丢弃（白名单制）；EN-04 Anthropic 历史回放把 invalid-JSON 参数替换为 `{}`（media.ts:317-324 边缘路径）；EN-05 OpenAI reasoning 显示专用；EN-06 strict schema 不可表示时回退非 strict 并把数值约束折叠进 description；EN-07 `requireDone` 存在但生产未启用（finish_reason 兜底）；EN-08 媒体能力按模型族默认推断（gpt-4o/4.1/4.5/5/o 系、gemini）。

## 判定

- 六类（tool call / reasoning / usage / cache / finish reason / 流式事件）在两协议上逐字段可追溯至生产入口与归一函数；测试背书见 JSON `testBacking`。
- **无源码改动**（纯文档轮）：三个小补丁候选均涉及请求形状变更或需移植差分凭据，按 brief 记为 confirmed gap 转后续轮次，不假装已对齐。
- 未触碰 provider/model 配置面，兼容现有模型配置。
- C-MDL-01 delta：`unverified → gap`（归一层接线完好；字段级缺口 FC-GAP-01..03 待修，修复后可转 aligned）。
