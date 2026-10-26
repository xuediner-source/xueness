# DeepSeek (`deepseek-v4.1-flash 1017 max`) Code & Contract Review Report: Phase `F02` (`F02.01`–`F02.06`)

- **Review Scope**: Commits `7a7b25e..83b5b0f` (`F02.01` `7a7b25e`, `F02.02` `4ede540` / `1ff24d5`, `F02.03` `606c58d`, `F02.04` `9874830`, `F02.05-06` `83b5b0f`), covering contracts `C-TOOL-01` through `C-TOOL-07`
- **Review Time**: 2026-10-25 01:25 (UTC+8)
- **Reviewer**: Claude Code CLI (`/home/box/.local/bin/claude-ds` -> `wb2api-claude-bridge` on `127.0.0.1:7864` -> `deepseek-v4.1-flash (1017 max)`, session `5bde2710-6254-4ca9-a538-2e2f3632f1be`)

---

## 1. Executive Summary

Phase `F02` (`F02.01`–`F02.06`) implements the full tool exposure, discovery, deferred execution, persistence, queue-aware deadline, and concurrency barrier architecture across `@xueness/engine-tools`, `@xueness/kernel`, `@xueness/tool-bridge`, `@xueness/agent`, `@xueness/providers`, `plugins/providers`, and `plugins/mcp`:

- **`C-TOOL-01` & `C-TOOL-02` (`F02.01`)**: `ToolDefinition` safety/exposure metadata (`readOnly`, `destructive`, `alwaysLoad`, `shouldDefer`), `toolSafetyMetadata` and `toolExposure` helpers, standard-profile request filtering (`kernel-hooks.ts`), lightweight-profile `alwaysLoad`/`deferred` policy (`runtime-tools.ts`), and MCP `alwaysLoad` configuration (`plugins/mcp`).
- **`C-TOOL-03` (`F02.02`)**: Generic `tool_search` registered on the `providers` plugin with a live kernel catalog projection (`ProviderToolSearchBinding`), deterministic local keyword scoring, `resolveToolSearchMode` capability gating, and `session.discovered_tools` recording.
- **`C-TOOL-04` (`F02.03`)**: `deferred_tool_call` envelope tool and `runTools` (`agent/src/tools.ts`) admission/unwrapping onto the single `ToolBridge` permission/validation/execution path without discovery bypass or duplicate permission tables.
- **`C-TOOL-05` (`F02.04`)**: Durable `discovered_tools` hydration (`hydrateDiscoveredTools`), one-time hidden `<system-reminder>` discovery announcements (`flushDiscoveredToolsAnnouncement`, deduplicated via `session.announced_discovered_tools`), and atomic post-compaction re-announcement (`discoveredToolsReminder`, deduplicated via `session.announced_compact_discovered_tools`).
- **`C-TOOL-06` (`F02.05`)**: Queue-aware `ToolDeadline` (`tool-deadline.ts`) charging only active tool execution time, pausing on nested model queue waits (`pause()`/`resume()` via `ToolEnv.deadlineControl`), reporting `queuedMs` separately on `tool_timeout`, and honoring external `AbortSignal` immediately even while paused.
- **`C-TOOL-07` (`F02.06`)**: Shared `batch-scheduler.ts` (`planBatches`, `runBatches`, `parallelEligible`) with configurable `batchConcurrency` (default 10), explicit-only parallelism (`concurrencySafe === true && !destructive`), serial barriers for mutating/destructive/dependent calls, and deterministic index-ordered results.

Line-by-line review of all Phase `F02` modules identified **5 real code/test defects (2 High, 2 Medium, 1 Low)**, all of which have been directly fixed and covered by unit tests.

---

## 2. Findings & Fixes Summary

| ID | Severity | File & Lines | Real Bug? | Summary |
| --- | --- | --- | --- | --- |
| **F02-BUG-01** | **High** | `ts/packages/tool-bridge/src/tool-deadline.ts:44-178`<br>`ts/packages/tool-bridge/src/bridge.ts:254` | Yes | (1) `ToolDeadline` never removed its `"abort"` listener from `options.signal` when a tool completed within budget, leaking listeners/closures on long-lived signals; (2) if `options.signal` was already aborted (or expired) before `race()` was called, `#settlement()` created a fresh unresolved Promise that hung forever; (3) `bridge.ts` checked `timeoutMs > 0` without `Number.isFinite(tool.timeoutMs)`. |
| **F02-BUG-02** | **High** | `ts/packages/agent/src/tools.ts:126-138` | Yes | `runTools` called `planBatches(...)` once upfront before executing any group, so `suspended: () => halt !== null \|\| stopTurn !== null \|\| blockEffects` was evaluated only when `halt` and `stopTurn` were `null`, never re-evaluating suspension between groups; also `eligible` passed raw `call.function.name` without `internalToolName(...)`. |
| **F02-BUG-03** | **Medium** | `ts/packages/agent/src/kernel-hooks.ts:5-23`<br>`ts/packages/tool-bridge/src/bridge.ts:222` | Yes | `kernelAgentHooks.concurrencySafe` omitted `!tool.destructive` and omitted `"tool_search"` from `SAFE_GATES`, and `kernelAgentHooks` did not forward `batchConcurrency`; `ToolBridge.callAll` checked only `?.concurrencySafe === true` without `parallelEligible(tool) && !tool.mutating`. |
| **F02-BUG-04** | **Medium** | `ts/plugins/providers/src/tool-search.ts:100-130,166-167` | Yes | (1) `hydrateDiscoveredTools` used `.slice(-Math.max(0, maxDiscovered))`, which evaluates `.slice(-0)` (`=== .slice(0)`) when `maxDiscoveredTools === 0`, failing to clear the persisted window when discovery is disabled, and `new Set(previous)` kept first-seen order instead of newest-at-end; (2) `queueDiscoveredAnnouncement` queued all non-deferred search hits even when `maxDiscovered < results.length` evicted earlier hits from `discovered_tools`. |
| **F02-BUG-05** | **Low** | `ts/packages/agent/test/zcode-prompt-context.test.ts:20` | Yes | Test asserted `SYSTEM_REMINDER_SOURCES.length === 31`, failing after `F02.04` added `"tool_discovery"` as the 32nd source (`2` prefix + `18` persisted + `12` per-request = `32`). |

---

## 3. Root Cause & Fix Details

### `F02-BUG-01` (High): `ToolDeadline` external `AbortSignal` listener leak & pre-`race()` settlement hang
- **Location**: `ts/packages/tool-bridge/src/tool-deadline.ts:44-178`, `ts/packages/tool-bridge/src/bridge.ts:254`
- **Root Cause**:
  1. The constructor registered `options.signal.addEventListener("abort", () => this.#cancel(), { once: true })`, but `race().finally()` only called `#disarm()` (clearing the timer) and never removed the abort listener from `options.signal`. Under a long-lived session or caller signal, every deadlined tool call that completed normally retained its `ToolDeadline` instance on the signal's listener list.
  2. `#settlement()` lazily allocated `this.#settled = new Promise((_, reject) => { this.#settleRejecter = reject; })` when `race()` was called. When `options.signal` was already aborted at construction time (`if (options.signal.aborted) this.#cancel()`), `#cancel()` ran while `#settleRejecter` was still `null`. A subsequent `deadline.race(run)` created a brand-new unresolved Promise that never rejected.
  3. `bridge.ts:254` checked `typeof tool.timeoutMs === "number" && tool.timeoutMs > 0` without `Number.isFinite(tool.timeoutMs)`.
- **Fix**:
  - Stored `#externalSignal` and `#onExternalAbort` on `ToolDeadline` and added `#detach()` to remove the abort listener on `#expire()`, `#cancel()`, and `race().finally()`.
  - Recorded `#settleError: Error | null = null` in `#expire()` and `#cancel()`, and made `#settlement()` return `Promise.reject(this.#settleError)` immediately if already settled before `race()`.
  - Updated `bridge.ts:254` to guard with `Number.isFinite(tool.timeoutMs)`.

### `F02-BUG-02` (High): `runTools` upfront `planBatches` call never re-evaluates `suspended()` between groups
- **Location**: `ts/packages/agent/src/tools.ts:126-138`
- **Root Cause**:
  - `planBatches` is a synchronous pure function that returns all `BatchGroup[]` before the `for (const group of ...)` loop begins. Passing `suspended: () => halt !== null || stopTurn !== null || blockEffects` into a single upfront `planBatches` call meant `suspended()` was only evaluated before Group 0 executed (when `halt` and `stopTurn` are always `null`), never observing `halt` or `stopTurn` raised by an earlier group in the turn.
  - Additionally, `eligible` passed `(call.function as Row).name` directly to `runner.hooks.concurrencySafe` instead of normalizing via `internalToolName(...)`.
- **Fix**:
  - Changed the loop in `runTools` to plan one group at a time from `calls.slice(offset)` so `suspended()` is re-evaluated against live `halt` / `stopTurn` state after each group settles, and normalized the tool name in `eligible` via `internalToolName(...)`.

### `F02-BUG-03` (Medium): Safety-metadata & `batchConcurrency` alignment in `kernelAgentHooks` and `ToolBridge.callAll`
- **Location**: `ts/packages/agent/src/kernel-hooks.ts:5-23`, `ts/packages/tool-bridge/src/bridge.ts:222`
- **Root Cause**:
  - `kernelAgentHooks.concurrencySafe` checked `tool?.concurrencySafe === true && !tool.mutating && SAFE_GATES.has(tool.gate)` without checking `!tool.destructive`, omitted `"tool_search"` from `SAFE_GATES`, and omitted `"batchConcurrency"` from `Pick<AgentPluginHooks, ...>`.
  - `ToolBridge.callAll` checked only `this.#kernel.tools.get<AnyTool>(call.name)?.concurrencySafe === true` instead of `parallelEligible(tool) && !tool.mutating`.
- **Fix**:
  - Added `"tool_search"` to `SAFE_GATES`, added `&& !tool.destructive` to `kernelAgentHooks.concurrencySafe`, added `"batchConcurrency"` to `kernelAgentHooks` options, and updated `ToolBridge.callAll` to require `parallelEligible(tool) && !tool.mutating`.

### `F02-BUG-04` (Medium): `hydrateDiscoveredTools` `.slice(-0)` bug & `queueDiscoveredAnnouncement` window mismatch
- **Location**: `ts/plugins/providers/src/tool-search.ts:100-130,166-167`
- **Root Cause**:
  1. In `hydrateDiscoveredTools`, `.slice(-Math.max(0, maxDiscovered))` evaluates `.slice(-0)` (`=== .slice(0)`) when `maxDiscoveredTools === 0`, leaving the persisted discovery array intact instead of clearing it when discovery is disabled. Furthermore, `[...new Set(previous)]` kept the first occurrence of a duplicate tool name rather than the newest-at-end occurrence.
  2. `queueDiscoveredAnnouncement(current, results)` queued all non-deferred `results` even when `maxDiscovered < results.length` caused `recordDiscovered` to evict earlier hits, announcing tools that were not actually in `session.discovered_tools`.
- **Fix**:
  - Deduplicated `previous` preserving newest-at-end order, used `maxDiscovered <= 0 ? [] : deduped.slice(-maxDiscovered)`, pruned `pending_tool_discovery` against the active capped window, and filtered `queueDiscoveredAnnouncement` by `inWindow = new Set(discovered)`.

### `F02-BUG-05` (Low): `zcode-prompt-context.test.ts` source count updated from `31` to `32`
- **Location**: `ts/packages/agent/test/zcode-prompt-context.test.ts:20`
- **Root Cause**: `F02.04` added `"tool_discovery"` to `SYSTEM_REMINDER_PERSISTED_SOURCES`, bringing the total active system-reminder sources to `32` (`2` prefix + `18` persisted + `12` per-request).
- **Fix**: Updated `zcode-prompt-context.test.ts:20` to assert `32`.

---

## 4. Verification Gates

- `npm --prefix ts run typecheck` — clean (`0` errors)
- `npm --prefix ts run check:plugins` — `check:plugins ok: 33 plugins, 451 source files`
- `npm --prefix ts run check:lines` — `check:lines ok: 758 prod files, max <= 400 effective lines`
- `node --test` across `tool-bridge`, `agent`, `providers`, `kernel`, `engine-tools`, and `mcp` F02 suites — `100%` pass (`0` failures)
