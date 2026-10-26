# 失败分类与重试语义契约（F01.02 · C-MDL-02）

日期：2026-10-24 · 基线：Xueness 0.2.1（`61d5a71` + F00.02..04 + `d178ef0`）· 机器可读版：[failure-retry-contracts.json](failure-retry-contracts.json)

本轮为**核对轮（无源码改动）**：把限流、Retry-After、连接断开、无输出失败、已输出/已提交失败、取消、业务不可重试错误整理成从 adapter（`ts/packages/providers`）到 runtime（`ts/packages/agent`）一致的分类表，并逐条复核 C-MDL-02 的四条不变量。结论：**全部成立（aligned），未发现双重计预算、取消重试、已提交重播、Retry-After 忽略等违规**；无新增 confirmed gap。

## 1. 调度权单层归属（预算只计一次的结构保证）

同一失败的退避调度**要么在 adapter 内部尝试环、要么在 agent 重试环，从不同时生效**：

| runtime 预算 | adapter HTTP 尝试/逻辑尝试 | 调度权 | 退避曲线 |
| --- | --- | --- | --- |
| Default（maxAttempts=11）/ Unbounded | 恰 1 次（`model-retry.ts:124-126` → `model-request.ts:51-52`） | runner | Retry-After 优先（≤5min 或 < 指数时原值），否则 2s·2ⁿ≤60s + 50–100% jitter（`retry-policy.ts:92-99`） |
| SingleAttempt（lightweight）或 maxAttempts 收窄为 1 | 标准 3 次（`openai.ts:43`）；lightweight 1+transportRetries∈[1,3]（`openai.ts:75-84`、`options.ts:21,29`） | adapter | 0.25s·2ⁿ≤2s（`attempts.ts:59`）；Retry-After 取 Python 血统 clamp [0,2]s 值（`retry-after.ts:135-146`） |

预算计数器 `ModelRetry.#attempt` 的**唯一递增点**在 `model-retry.ts:152`，位于一次完整且未被取消的退避等待之后；等待被取消时抛 `ProviderCancelled`、不递增（`model-retry.ts:158-171`）。同一错误至多进入一次 `retry.next`（`recorded` 标志，`model-request.ts:70,82,91`）；未提交压缩/修复恢复不经预算、每逻辑请求至多一次（`recovered` 标志，`model-request.ts:92-105`）。

## 2. 失败分类表（20 类全枚举）

信号→分类→消费→预算→退避→重播许可。行号均为本树真实位置；`failure.ts` 指分类梯 `classifyModelFailure`（`ts/packages/providers/src/failure.ts:137-176`）。

| ID | 失败类 | 触发信号 | adapter 分类入口 | runtime 消费点 | 计预算 | 退避 | 重试/重播 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FR-01 | 限流（可重试） | HTTP 429 / 业务码 1302/1303/1305/3002、rate_limit_* | `transport.ts:169-183,216-220`；`attempts.ts:79-89,126-131` | `failure.ts:159,83`→rate_limited | 是（1 位/次） | Retry-After 优先否则指数 | 未提交可重试+discardPrelude |
| FR-02 | 限流（配额终局） | 429+insufficient_quota/1308-1321 等；category=quota_exhausted | `transport.ts:98-120,176` | `failure.ts:82,154`→不重试 | 否（终局） | 无（quotaResetAt 显式暴露） | 不重试不重播 |
| FR-03 | Retry-After（横切信号） | retry-after-ms / retry-after 头；x-should-retry:false 否决 | `retry-after.ts:135-146,153-167`；`transport.ts:161-162`；`errors.ts:99-103` | `failure.ts:127-134` 仅随可重试分类携带→`retry-policy.ts:92-99` | n/a | ≤5min 或<指数时原值；adapter 内部用 clamp[0,2]s 值 | 不改变所在类许可 |
| FR-04 | 连接断开/网络 | ECONNRESET 等（`failure-codes.ts:34`）；SSE 无 finish 即断（`streams.ts:145-146`、`anthropic-stream.ts:189`） | `attempts.ts:90-94,132-137` | `failure.ts:171-173,85`→network | 是 | 指数（两层曲线见 §1） | 未提交可重试；已交付终局（FR-13） |
| FR-05 | 代理失败 | transport hint=proxy / code 含 PROXY | `errors.ts:200-212,286` | `failure.ts:170` | 是 | 指数/Retry-After | 未提交可重试 |
| FR-06 | TLS 失败 | hint=tls / CERT/TLS 码 | 同上 | `failure.ts:169`→不重试 | 否（终局） | 无 | 不重试不重播 |
| FR-07 | 请求超时 | 408/504、ETIMEDOUT 族、DeadlineExpired | `attempts.ts:55-56,92,129`；`transport.ts:72-81` | `failure.ts:156-158`→timeout | 是 | Retry-After 优先否则指数 | 未提交可重试 |
| FR-08 | 流空闲超时 | ModelStreamIdleTimeoutError | `stream-idle-timeout.ts:45-84` | `failure.ts:145-147`；空闲界每重试 +30s（`model-request.ts:51`、`stream-idle-timeout.ts:13-22`） | 是 | 指数+空闲界递增 | 未提交可重试；等待期取消不落 provider 失败 |
| FR-09 | 服务器错误 5xx | 500-599；业务码 500/1120/1230/2007 | `transport.ts:176`；`attempts.ts:83-87,151-157` | `failure.ts:168`→server_error | 是 | Retry-After 优先否则指数 | 未提交可重试 |
| FR-10 | 供应商过载 | 529；业务码 1312/overloaded_* | 同 FR-09 | `failure.ts:160,84`→provider_overloaded | 是 | 同上 | 未提交可重试 |
| FR-11 | 无输出失败（零输出完成） | 完成但无文本/工具/usage 且流未提交 | runtime 检出：`empty-completion.ts:10-16` | 合成分类 `model-retry.ts:130-131`；`model-request.ts:68-76`；独立空重试预算≤1（`model-retry.ts:67`）且 attempt<maxAttempts 双门 | 是（受空重试≤1 约束） | 指数（无 Retry-After） | 可重试一次；新流从零、旧 prelude 丢弃 |
| FR-12 | 完成后可疑空响应 | 已 accept+completed 后异常 finish+零内容/零 usage | runtime 检出：`empty-completion.ts:19-29` | `model-request.ts:81-85` 以 committed:true 终局；`recorded` 防二次 | 否（终局） | 无 | 不重试不重播（completed 事件只发一次） |
| FR-13 | 已输出/已提交失败 | stream.committed / adapter delivered | `attempts.ts:82,93` fail-closed | `model-request.ts:92,107`→`model-retry.ts:137` 否决重试；`stream.interrupt`（:112）；driver 落 generation_* 暂停（`driver.ts:114-117,150-171`） | 否（终局） | 无（部分输出保留并显式报告） | **绝不重试、绝不重播前缀** |
| FR-14 | 取消/停止/宿主中止/deadline | ProviderCancelled、AbortError、合成信号（`model-request.ts:16-17`） | `transport.ts:84-86`；`request-admission.ts` 各阶段；`stream-idle-timeout.ts:50,67-72` | `failure.ts:144,179-181`；`model-retry.ts:130,137,151,158-171`；`stream.ts:116,123,134`；driver settle("stopped")（`driver.ts:60,135,137,148`） | 否（不触发重试；取消等待不递增） | 无 | 不重试不重播；流标 interrupted |
| FR-15 | 认证失败 | 401/403；业务码 1006/3007 | `transport.ts:176` | `failure.ts:161-163`、业务梯 auth_refresh/invalid_auth | 否（终局） | 无 | 不重试不重播 |
| FR-16 | 无效请求/被拒/模型不存在 | 400/413/422；业务码 1005/3006/3001 | 同上 | `failure.ts:164-166,78-80` | 否（终局） | 无 | 不重试不重播 |
| FR-17 | 上下文溢出 | 400/413+context_* 码；业务码 1261 | `transport.ts:112` | `failure.ts:164-167,86`；`model-request.ts:94-96` 至多一次未提交压缩重建（不经预算） | 否（恢复不耗预算，每请求≤1 次） | 无（压缩即时重建） | 仅未提交可重建；已提交不重建 |
| FR-18 | 响应解析失败/协议错误 | category=invalid_response/stage=parse；SSE finish 后载荷 | `attempts.ts:95-100,138-142` | `failure.ts:140-141`；driver 协议修复环非重试（`driver.ts:173-187`） | 否（终局） | 无 | 不重试不重播 |
| FR-19 | 本地流回调失败 | ProviderCallbackError | `errors.ts:188-197` | `failure.ts:148`；`driver.ts:145` paused | 否（终局） | 无 | 不重试不重播 |
| FR-20 | 未知终局（兜底） | 未匹配错误；业务码 1113/1309/1311/1008/1314/1315 | `completeAttempts` 末端保底（`attempts.ts:150-163`） | `failure.ts:174,175,87` | 依 markedRetryable | 可重试时指数 | 未提交可重试或终局 |

## 3. C-MDL-02 不变量逐条证据

### INV-1 同一失败只计一次预算 — **成立**

- 单层归属矩阵（§1）：runner 可重试时 adapter 每 HTTP 尝试恰一次（`model-retry.ts:124-126`）；runner 不可重试时 adapter 内部有界尝试整体占一个预算位（`retry-policy.ts:73-80`）。
- 计数器唯一递增点 `model-retry.ts:152`；取消的等待不递增（`model-retry.ts:158-171`）。
- `recorded`（`model-request.ts:70,82,91`）与 `recovered`（:92-105）双标志防重复调度；压缩/修复重建不经预算（有意设计，wiring 注明「至多一次未提交压缩/修复」）。
- 测试：`model-retry.test.ts:15,45,74,107`、`model-request.test.ts:16,40`、`failure.test.ts:101`。

### INV-2 取消不重试 — **成立**

- 分类即否决：`failure.ts:144`（取消→retryable=false）+ `failure.ts:179-181`（isRetryableFailure 排除 Cancelled）。
- 调度五重门含 `!stopped() && !signal.aborted`（`model-retry.ts:137`）；等待期 250ms 协作切片检查（:151,158-171）。
- 全入口覆盖：准入后（`model-request.ts:49`）、流观察者（`stream.ts:116,123,134`）、admission 各阶段（`request-admission.ts:34-36,50-53,63-65,75,84-86,92-115`）、回合层（`driver.ts:60,135,137,148`）。
- 测试：`model-retry.test.ts:94`、`model-request.test.ts:173`、`model-admission.test.ts:145,348`、`request-admission.test.ts:65`。

### INV-3 已消费/已提交流式输出不重播 — **成立**

- 提交界明确：首个文本/推理 delta 或 accept 到的 tool_calls 置位 `#committed`（`stream.ts:70-76,98-117,118-135,77-80`）；未提交 tool 快照只在私有 prelude 缓冲、不公开（`stream.ts:90-97`）。
- adapter 侧 delivered 即 fail-closed（`attempts.ts:82,93`）；runtime 侧 committed 跳过恢复（`model-request.ts:92`）、否决重试（:107→`model-retry.ts:137`）、interrupt 保留部分输出（:112）。
- 允许的重试前必 `discardPrelude`+`finish(null,true)`（`model-request.ts:72,102,108`），新尝试全新 RequestStream（:60-64）；完成后的可疑空响应以 committed:true 终局防 completed 事件重播（:81-85）。
- 测试：`stream-boundary.test.ts:28,55,75`、`model-request.test.ts:86,115`、`model-retry.test.ts:45`。

### INV-4 分类驱动退避（含 Retry-After 尊重）— **成立**

- 有序分类梯 `failure.ts:137-176`（parse→invalid_request→取消→空闲超时→回调→业务码→配额→超时→429→529→认证→4xx→溢出→5xx→TLS→代理→网络→markedRetryable→终局），业务码表先于通用状态分支（`failure-codes.ts:11-31`）。
- Retry-After 全链无丢失：`retry-after.ts:153-167`（retry-after-ms 优先、x-should-retry:false 否决）→`transport.ts:161-162`→`errors.ts:99-103`（≤1 天界）→`failure.ts:127-134`（仅随可重试分类携带）→`retry-policy.ts:92-99`（≤5min 或 < 未封顶指数时原值生效）。
- 分类差异真实驱动退避：429/过载重试 vs 配额终局；网络/超时重试 vs TLS 终局；空完成合成 server_error 重试一次。退避同时受回合 deadline 约束（`model-retry.ts:139`）。
- 测试：`failure.test.ts:24,50,66,90,101,112,125,150`、`model-retry.test.ts:15,107`、`stream-idle-timeout.test.ts:60,105`。

## 4. 边界注记

- **BN-01 调度权矩阵**：见 §1；两层退避曲线独立但不同时作用于同一失败。
- **BN-02 Retry-After 双血统**：adapter 内部 sleep 用 Python 血统 clamp [0,2]s（`retry-after.ts:135-146`）；runner 用 ZCode 血统未 clamp 值（≤5min 优先）。SSE error envelope 无头可用，流中信封不带 Retry-After（`transport.ts:186-221`）。
- **BN-03 恢复路径的状态事件工件**：压缩/修复重建会使 `model_request_started` 以相同 attempt 编号、不同 attemptId 再次发布（`model-retry.ts:86`）；预算无重复计数，消费方应以 attemptId 区分。
- **BN-04 输出受限续跑不是重试**：driver 保留 partial 以回合内 continuation 提示续写（`driver.ts:152-161`，MAX_OUTPUT_TOKEN_CONTINUATIONS 界）；与 C-MDL-03 执行级回退（F01.03）分列。
- **BN-05 off-peak**：automation 插件独立排队，不经 model-retry 预算；`ModelRetryReason.OffpeakQueued` 仅为事件词汇。上游「票据重试仅在流已产出前允许」在本树由通用规则覆盖（一切重试仅限未提交流，INV-3）。
- **BN-06 profile 一致性**：`driver.ts:35` 播种保证回合内 runner/adapter profile 同源；混合叠加在当前接线不可达，即便未来引入，预算仍按逻辑尝试单计数。

## 5. 缺口与去向

本轮在失败分类/重试语义域内**未发现违规、无新增 confirmed gap**。相邻但不属本轮：

| 项 | 状态 | 去向 |
| --- | --- | --- |
| C-MDL-03 执行级选型回退（SingleAttempt 执行预算+已接收工具结算+原会话模型恢复） | delta=gap（上游 3.16.2 新增通路） | F01.03 实现；本轮仅与普通重试分列（BN-04） |
| FC-GAP-03 剪断 tool_use 丢弃策略跨协议不一致 | F01.01 确认缺口 | 留在 [provider-field-contracts](provider-field-contracts.md) 账本；同族已输出边界但属字段契约问题 |

## 6. 结论

C-MDL-02 **维持 aligned**：四条不变量经全链路静态复核成立并有既有测试背书；完整分类枚举表（20 类）已交付。本轮无源码改动。
