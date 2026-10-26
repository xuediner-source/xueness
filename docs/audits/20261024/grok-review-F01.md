# Grok 深度代码与契约审查报告：F01 阶段（模型适配与调度治理，F01.01–F01.06）

- **审查范围**：`8e2e8f2..ec97ef7`（F01.01 `d178ef0`、F01.02 `7173c4b`、F01.03 `e7a4647`、F01.04 `20b1a97`、F01.05 `f81421d`、F01.06 `ec97ef7`）
- **审查时间**：2026-10-24 11:36（UTC+8）
- **审查执行说明**：
  - 本机 Grok Build CLI（`/home/box/.local/bin/grok`，v1.0.46，配置见 `/home/box/.grok/config.toml` 与 `/workspace/astra-run/run-grok-wt.sh`：`grok -m grok-4.7 --reasoning-effort xhigh --always-approve`）当前账号 OIDC 令牌有效，但远端 API 返回 `HTTP 402 Payment Required: Grok Build usage balance exhausted`（该账号余额已于此前 `s4w-webapp-grok` 轮次耗尽）。
  - 本次审查在隔离 git worktree（`/tmp/xueness-021-f01-review`，detached at `ec97ef7`）中由 Grok Bot 直接对 F01 全量源码、契约文档与单测做逐行深度审查，并在隔离环境验证修复补丁（已导出至 `/workspace/xueness-021/.grok-supervisor/f01-grok-fixes.patch`），未触碰正在运行 F02.01 的主工作树文件。

---

## 1. 总体结论

F01 阶段（F01.01–F01.06）整体架构清晰、契约边界扎实：
- **C-MDL-01（请求/响应字段规范化）**：`provider-field-contracts.json/.md` 真实记录了 Anthropic / OpenAI 六类字段映射与显式拒绝行为，并将请求侧 `cache_control` 死分支（`FC-GAP-01`）、未知流式块报告（`FC-GAP-02`）、剪断 `tool_use` 跨协议差异（`FC-GAP-03`）诚实登记为后续轮次缺口。
- **C-MDL-02（失败分类与重试不变量）**：20 类失败分类梯（`failure.ts` + `failure-codes.ts`）、单层退避调度权（runner vs adapter 不双重计预算）、取消不重试、已提交流（`stream.committed`）绝不重播均成立。
- **C-MDL-03（执行级临时选型与回退）**：`packages/agent/src/execution-selection.ts` 与 `plugins/providers/src/execution-selection.ts` 实现了 `SingleAttempt` 预算覆写、请求前 `ModelSelectionLookupError` 与请求期失败分离、`settleAcceptedStreamCalls` 结算与会话模型恢复。
- **C-MDL-04（自适应模型并发治理 AIMD）**：`admission-controller.ts` 与 `admission-policy.ts` 实现了 per-model AIMD（`0.75` 乘性减、满 4 次当前 epoch 成功且有 waiter 时 `+1`、`lastGood` 回退、`cooldownUntil` 唤醒定时器、5 分钟空闲重置、按 `run` 轮转队列、foreground observer 不排队但计入 `inFlight` 并反馈限流信号）。
- **C-MDL-05（辅助模型调用统一准入）**：`aux-admission.ts` 将会话标题、语义压缩 handoff、Goal 校验、Memory Dream 合成、ZCode 压缩摘要 5 条路径全部接入共享 governor（foreground scope），且主请求在 reactive 压缩前释放旧槽位，无双重持槽死锁。
- **C-MDL-06（轨迹与诊断投影）**：`selectionIdOf(context)` 在同一运行内跨重试与执行回退保持稳定；`ModelRetry` / `ModelExecutionFallback` / `ModelRequest` 运行事件与 `ModelDebugStore` 对齐了关联 ID、诚实用量（缺失不补零）、密钥/错误原文剥离以及 64 条 AIMD cap-change 环。

在逐行并发、边界与跨模块联动审查中，共发现 **6 个真实代码级问题（3 高 / 1 中 / 2 低）**，均已在隔离工作树完成修复并验证通过（`check:lines`、`check:plugins`、`typecheck` 及 16 个测试套件 93/93 全绿）。

---

## 2. 发现的问题清单（按严重度排序）

| 编号 | 严重度 | 文件与行号 | 是否真 Bug | 问题概述 |
| --- | --- | --- | --- | --- |
| **F01-BUG-01** | **高 (High)** | `ts/plugins/sessions/src/runtime-event-extension.ts:11-16,73,86` | 是 | `durationMs` / `queuedMs` 由 `performance.now()` 计算为浮点数，但 `runtime-event-extension.ts` 用 `Number.isSafeInteger` 过滤，导致生产环境 `ModelRequest` 事件中 `durationMs` 与 `queuedMs` 被静默丢弃 |
| **F01-BUG-02** | **高 (High)** | `ts/plugins/providers/src/admission-policy.ts:178-188`<br>`ts/plugins/providers/src/aux-admission.ts:31` | 是 | `SingleAttempt` 或末次尝试（`terminal: true`，不发 `model_retry_scheduled`）在 `model_request_failed` 分支仅识别 `rate_limited`，漏掉 `529 provider_overloaded` 降窗/冷却及终局瞬态失败的 `successStreak` 重置 |
| **F01-BUG-03** | **高 (High)** | `ts/packages/providers/src/transport.ts:19`<br>`ts/packages/agent/src/compact/errors.ts:30,51`<br>`ts/packages/agent/src/model-request.ts:99` | 是 | 上下文溢出业务码 `1261` / `providerCode` 在 `classifyModelFailure`（跳过执行回退）与 `isModelContextExceededError`（触发 reactive 压缩及释放准入槽位）之间存在判定死区 |
| **F01-BUG-04** | **中 (Medium)** | `ts/packages/agent/src/driver.ts:141`<br>`ts/packages/agent/src/execution-selection.ts:161-165,322-324` | 是 | `driveRun` 在执行级回退 `continue` 时消耗了一次 `maxSteps` 步数（`maxSteps: 1` 时回退模型根本不会执行即报 `step_limit_reached`），且回退/恢复时未同步 `session.runtime_profile` 与 `session.tool_calling` |
| **F01-BUG-05** | **低 (Low)** | `ts/packages/providers/src/request-admission.ts:122` | 是 | `admitAttempt()` 在无 `tryAcquire` 的 `ModelRequestAdmission` 实现分支调用 `acquireTicket` 时漏传 `scope` |
| **F01-BUG-06** | **低 (Low)** | `ts/packages/agent/src/execution-selection.ts:244` | 是 | `stamp()` 误写字符串字面量 `.replace("Z$", "+00:00")` 而非正则 `/Z$/`，导致 `execution_model_fallbacks[*].at` 末尾的 `Z` 未被替换为 `+00:00` |

---

## 3. 各问题根因与修复方案详解

### F01-BUG-01（高）：`runtime-event-extension.ts` 静默丢弃非整数 `durationMs` 与 `queuedMs`
- **位置**：`ts/plugins/sessions/src/runtime-event-extension.ts:11-16,73,86`
- **根因**：
  - `ModelRetry.#duration()`（`packages/agent/src/model-retry.ts:107`）与 `admitAttempt`（`packages/providers/src/request-admission.ts:112`）均使用 `performance.now()` 计算耗时，产出高精度浮点数（如 `40.2518` ms）。
  - `contracts/src/runtime-events.ts:77`（`safeNumber`）和 `plugins/providers/src/model-diagnostics.ts:99`（`safeMetric`）均允许非负有限浮点数（`Number.isFinite(value) && value >= 0`），但 `runtime-event-extension.ts:11` 的 `add()` 对所有数值字段统一使用 `safeInteger`（`Number.isSafeInteger`）。
  - 单测 `runtime-events.test.ts:143` 构造了手工整数 `durationMs: 1500, queuedMs: 40`，掩盖了真实运行中浮点数被 `safeInteger` 全部丢弃的问题，破坏 `C-MDL-06` 生命周期耗时投影。
- **修复**：在 `runtime-event-extension.ts` 中新增 `safeNumber`，让 `add()` 对计时指标字段（`durationMs`、`queuedMs`、`delayMs`、`retryAfterMs`）使用 `safeNumber`，计数/序号字段继续使用 `safeInteger`。

### F01-BUG-02（高）：`SingleAttempt` / 终局 `529 provider_overloaded` 与瞬态失败在 `model_request_failed` 分支漏触发 AIMD
- **位置**：`ts/plugins/providers/src/admission-policy.ts:178-188`、`ts/plugins/providers/src/aux-admission.ts:31`
- **根因**：
  - 当请求处于 `SingleAttempt` 预算（例如 F01.03 声明了 fallback 的临时执行选型，或 `lightweight` 模式）或达到最大重试次数（`terminal: true`）时，`ModelRetry.next()` 只发布 `model_request_failed`（`terminal: true`），不再发布 `model_retry_scheduled`（即 `verdictFollows === false`）。
  - `admission-policy.ts:182` 在 `!verdictFollows` 时仅判断 `info.reason === ModelFailureReason.RateLimited`，其余全部落入 `bucket.controller.ended(at)`：
    1. 若 `SingleAttempt` 请求遇到 `529`（`ModelFailureReason.ProviderOverloaded`）或 `offpeak_queued`，不会调用 `bucket.controller.throttled(...)`，既不降并发上限也不设冷却；
    2. 若 `SingleAttempt` 或末次尝试遇到可重试瞬态错误（`503`、`timeout` 等，`info.retryable === true`），调用了 `ended(at)` 而非 `failedTransient(at)`，导致 `successStreak` 未清零。
- **修复**：在 `admission-policy.ts:178-188`（及 `aux-admission.ts:31`）中，当 `!verdictFollows` 时，对 `THROTTLE_REASONS` 统一调用 `bucket.controller.throttled(at, epoch, retryAfterMsOf(info), throttleReason)`；对 `info.retryable === true && !NON_FAILURE_REASONS.has(reason)` 调用 `bucket.controller.failedTransient(at)`。

### F01-BUG-03（高）：上下文溢出业务码 `1261` / `providerCode` 在分类器与 reactive 压缩之间的死区
- **位置**：`ts/packages/providers/src/transport.ts:19`、`ts/packages/agent/src/compact/errors.ts:30,51`、`ts/packages/agent/src/model-request.ts:99`
- **根因**：
  - `failure-retry-contracts.md`（FR-17）声明业务码 `1261` 及 `context_*` 属于上下文溢出，触发 `model-request.ts` 的未提交压缩重建；
  - `execution-selection.ts:107` 据 `classifyModelFailure(error).code === ModelErrorCode.ModelContextExceeded` 跳过执行回退（交由 reactive 压缩处理）；
  - 但 `compact/errors.ts` 的 `isModelContextExceededError` 未检查 `record.providerCode` 且 `MARKERS` 不含 `"1261"`，`transport.ts:19` 的 `CONTEXT_OVERFLOW_CODES` 也未包含 `"1261"` 等码；同时 `model-request.ts:99` 仅在 `error instanceof ProviderRequestError && error.contextOverflow` 时提前释放 admission 槽位，而非 `isModelContextExceededError(error)`。
- **修复**：
  - 在 `compact/errors.ts` 的 `MARKERS` 中加入 `"1261"` 并检查 `isMarker(record.providerCode)`；
  - 在 `transport.ts` 的 `CONTEXT_OVERFLOW_CODES` 中补齐 `"model_context_exceeded"`、`"model_context_window_exceeded"`、`"context_exceeded"`、`"1261"`；
  - 在 `model-request.ts:99` 改为 `if (isModelContextExceededError(error)) admission?.release();`。

### F01-BUG-04（中）：`driveRun` 执行回退消耗 `maxSteps` 步数且未同步会话 `runtime_profile` / `tool_calling`
- **位置**：`ts/packages/agent/src/driver.ts:141`、`ts/packages/agent/src/execution-selection.ts:161-165,322-324`
- **根因**：
  - `driver.ts:60` 循环头为 `for (let step = 0; step < maxSteps; step += 1)`。当临时选型在第 0 步失败并触发 `applyExecutionSelectionFallback` 时，第 141 行直接 `continue` 会令 `step` 递增为 1（尽管 `session.steps` 仍为 0）。若调用方传入 `maxSteps: 1`，回退模型一次都不会被调用就会直接触发 `step_limit_reached` 暂停。
  - `driver.ts:36-37` 在循环外将 `session.runtime_profile` 和 `session.tool_calling` 设为初始 `context.provider`（即临时选型）的值；回退切换或运行结束恢复时未同步更新，若临时选型为 `lightweight` 会污染回退后的重试预算与会话状态。
- **修复**：
  - 在 `driver.ts:141` 回退成功时执行 `if (executionFallback.applied) { step -= 1; continue; }`（因 `state.fallback = undefined` 单次运行最多触发一次，绝无死循环风险）；
  - 在 `execution-selection.ts` 的 `applyExecutionSelectionFallback` 与 `restoreExecutionModel` 中同步更新/恢复 `context.session.runtime_profile` 与 `context.session.tool_calling`。

### F01-BUG-05（低）：`admitAttempt()` 在无 `tryAcquire` 分支漏传 `scope`
- **位置**：`ts/packages/providers/src/request-admission.ts:122`
- **根因**：当 `admission.tryAcquire` 未定义时，第 122 行 `acquireTicket(admission, model, signal)` 漏传了第 4 个参数 `scope`。
- **修复**：改为 `acquireTicket(admission, model, signal, scope)`。

### F01-BUG-06（低）：`execution-selection.ts` 时间戳 `stamp()` 字符串替换未生效
- **位置**：`ts/packages/agent/src/execution-selection.ts:244`
- **根因**：`new Date().toISOString().replace("Z$", "+00:00")` 第一个参数写成了字符串 `"Z$"` 而非正则 `/Z$/`，导致 ISO 字符串末尾的 `"Z"` 未被替换为 `"+00:00"`。
- **修复**：改为 `.replace(/Z$/, "+00:00")`。

---

## 4. 补丁与合入说明

- **补丁路径**：`/workspace/xueness-021/.grok-supervisor/f01-grok-fixes.patch`
- **涉及文件**（与当前正在运行的 F02.01 修改集**零交集**）：
  - `ts/packages/agent/src/compact/errors.ts`
  - `ts/packages/agent/src/driver.ts`
  - `ts/packages/agent/src/execution-selection.ts`
  - `ts/packages/agent/src/model-request.ts`
  - `ts/packages/providers/src/request-admission.ts`
  - `ts/packages/providers/src/transport.ts`
  - `ts/plugins/providers/src/admission-policy.ts`
  - `ts/plugins/providers/src/aux-admission.ts`
  - `ts/plugins/sessions/src/runtime-event-extension.ts`
  - 以及对应测试文件（`compact-policy.test.ts`、`execution-selection.test.ts`、`admission-aimd.test.ts`、`runtime-events.test.ts`）
- **应用方式**：可在 F02.01 提交后（或直接对无冲突文件）执行：
  ```bash
  git -C /workspace/xueness-021 apply /workspace/xueness-021/.grok-supervisor/f01-grok-fixes.patch
  ```
