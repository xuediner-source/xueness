# DeepSeek (`deepseek-v4.1-flash 1017 max`) Code & Contract Review Report: Phase `F03` (`F03.01`–`F03.06`)

- **Review Scope**: Commits `0f04ce7`, `39454b8`, `92a40d2` (F03.01-02 / F03.03-04 / F03.05-06), covering contracts `C-WFL-01` through `C-WFL-05`
- **Review Time**: 2026-10-25 (UTC+8)
- **Reviewer**: WorkBuddy (`deepseek-v4.1-flash 1017 max`)

---

## 1. Executive Summary

Phase `F03` implements the unified turn-command pipeline and workflow life-cycle contracts:

- **`C-WFL-01` (`F03.01`)**: `command-priority.ts` (`TurnCommandKind`, `COMMAND_PRIORITY_ORDER`, `COMMAND_MERGE_BOUNDARIES`, `TurnCommandRouter`, `TurnPromptOwnership`, `TURN_TRANSITION_TABLE`) and its wiring into the `sessions` plugin's `turn-runtime.ts` (prompt claim at `runStarted`, guide routing at both boundaries, queue drain at `settleRun`).
- **`C-MDL-03` / `F03.02`**: `accepted-call-ledger.ts` (`AcceptedCallLedger`, `settleStreamToolCalls`, durable `accepted_tool_calls` projection), `RequestStream` accepted/prelude accounting, driver + execution-fallback settlement boundaries, and cold-resume hydration in `sessions/src/history-hydration.ts`.
- **`C-WFL-02` (`F03.03`)**: steering priority (`steering-priority.ts`), boundary-tagged guide delivery (`_input_boundary`, `delivered_boundary`), wait-window preservation in `pendingSnapshot`, and `steering-runtime.ts` boundary arguments.
- **`C-WFL-03` (`F03.04`)**: `runner.ts` terminal-stop arbitration plus `run_stop` journaling, `planning/src/goal-contract.ts` (`GoalStopCode`, `goalStopDecision`, `goalContinueDecision`, `goalDecisionFromRun`, `journalGoalStop`) and goal-extension `appendTurn` continuation input.
- **`C-WFL-04` (`F03.05`)**: durable subagent background receipts (`background-receipts.ts` injected at both run boundaries) and workflows blocked reminders (`dynamic-blocked-reminder.ts` exposed on `workflow_script_status` / `workflow_script_list`).
- **`C-WFL-05` (`F03.06`)**: dynamic-run life-cycle table + cold-resume decision (`dynamic-lifecycle.ts`), drain-on-close in `DynamicWorkflowService`, and `withSessionLease` residency helper.

An earlier pass over this phase exists as commit `a026084`. That commit changed exactly five source files (`accepted-call-ledger.ts`, `driver.ts`, `turn-state.ts`, `goal-extension.ts`, `dynamic-tools.ts`), so five of its reported findings landed. This pass re-reviewed the phase against the current tree, **confirmed those five fixes are present and correct**, and found **two further real defects (1 High, 1 Medium)** that the earlier pass missed.

Both are fixed. They were written into the tree during this review; a concurrent process in the same worktree then swept them into commit `68502ab` ("F06.05-06"), whose message does not mention them. No history was rewritten to correct the attribution. The enclosing commit `68502ab` is unrelated MCP work; a reader looking for these two fixes should read the two files below rather than the commit log.

| ID | Severity | File | Real bug |
| --- | --- | --- | --- |
| `F03-BUG-07` | **High** | `ts/plugins/subagents/src/coordinator.ts:18-26` | `coordinator.sync()` erased the durable `notified` receipt stamp on every model boundary, defeating C-WFL-04's exactly-once delivery after compaction. |
| `F03-BUG-08` | **Medium** | `ts/packages/agent/src/accepted-call-ledger.ts:55-72` | `discardPrelude` returned the fragment *count* instead of the newly-discarded count, so a replayed settlement boundary over-reported discards and broke the ledger's own idempotence contract. |

**Corrections to the earlier report.** Two of its six findings do not hold up and are retracted in §3.3: the `pendingSubagentNotices` "foreign parent" filter is correct as written (a `task_runs` row is the session's *own* journal, so an absent `parent` legitimately means "mine", and requiring positive parent evidence would silently drop legacy rows), and its "asymmetric rollback" claim is not reachable because the stamp guard makes write and rollback symmetric by construction.

---

## 2. Confirmed Prior Fixes

Verified present in the current tree, all still correct:

| ID | Location | Confirmed state |
| --- | --- | --- |
| `F03-PRIOR-01` | `ts/plugins/workflows/src/dynamic-tools.ts:34-36` | `workflow_script_list` again returns a top-level **array** of runs (`runs.map(run => ({ ...run, blockedReminder: blockedReminderFor(run) }))`), not the wrapper object that had regressed the tool's pre-existing result shape. |
| `F03-PRIOR-02` | `ts/packages/agent/src/accepted-call-ledger.ts:33` | `stamp()` uses `.replace(/Z$/, "+00:00")`, matching `stream.ts:8`, so durable projection timestamps use the project's `+00:00` form. |
| `F03-PRIOR-03` | `ts/packages/agent/src/driver.ts:255-262` | Post-execution settlement requires positive evidence: `stored.ok !== false`, and the awaiting probe now also covers `awaiting_user` at both the top level and under `data`. A `run_paused` placeholder is no longer recorded `settled_executed`. |
| `F03-PRIOR-04` | `ts/plugins/planning/src/goal-extension.ts:57` | Non-terminal goal stop codes (`waiting_user`, `boundary`) no longer short-circuit the runner; `stopCodeIsTerminal` decides. |
| `F03-PRIOR-05` | `ts/packages/agent/src/turn-state.ts:18-19` | The unused `TURN_TRANSITIONS` alias is gone; only the value import used by `canTransitionTurn` remains. |

---

## 3. New Findings & Fix Details

### `F03-BUG-07` (High): `coordinator.sync()` erases the durable `notified` receipt stamp

- **Location**: `ts/plugins/subagents/src/coordinator.ts:18-23`, consumed by `ts/plugins/subagents/src/background-receipts.ts:54,95`
- **Root cause**: `TaskRegistry` rows carry no `notified` field — `task-registry.ts:29-35` builds `id/parent/agent/promptChars/status/steps/startedAt/endedAt/summary/error/root`. `Coordinator.sync()` rebuilds each journal row as `{ ...live }` and copies back only `agent` plus the `DURABLE_FIELDS` list, which did not include `notified`. `subagentsExtension.beforeModelRequest` calls `sync()` on **every model boundary, immediately before `mergeSubagentNotices`**, so each boundary replaced the stamped row with an unstamped one.
- **Failure scenario** (reproduced against the unfixed tree):
  1. A background task completes; boundary 1 stamps `notified: true` and journals the notice.
  2. Any later boundary calls `sync()`, which rebuilds the row from the registry and drops `notified` back to `undefined`.
  3. Compaction later drops the notice message and its archived copy.
  4. `pendingSubagentNotices` now sees a terminal task that is both unstamped and has no surviving key, so it re-emits the notice.

  C-WFL-04's stated invariant is exactly one effective reminder *ever*, "including after compaction when the stamp row is gone" — the stamp was precisely the thing being destroyed. The pre-existing "survives compaction" test passed only because it never called `sync()` between stamping and compaction.
- **Fix**: add `notified` to `DURABLE_FIELDS`, with a comment naming the receipt contract as the reason, so the live-mirror merge preserves a journal-owned field the registry never sets.
- **Regression**: `keeps the durable notified stamp across coordinator syncs so a compacted notice is not resent` — fails without the fix, passes with it.

### `F03-BUG-08` (Medium): `discardPrelude` reports fragment count, not newly-discarded count

- **Location**: `ts/packages/agent/src/accepted-call-ledger.ts:55-65`
- **Root cause**: the loop incremented its counter for every fragment it *examined* and returned that counter, including fragments skipped by `if (this.#records.has(callId)) continue`. `accept` is idempotent by `callId`, `settle` returns `false` for an already-settled record, and `settleAll` counts only real settlements — the module header documents *every* boundary as idempotent. `discardPrelude` was the sole exception, returning a non-zero total on replay.
- **Failure scenario** (reproduced): settle an uncommitted stream carrying two prelude fragments → `discarded: 2` (correct) → replay the same boundary for the same stream under a second cause (`cancelled` after `model_interrupt`, the exact double-boundary reachable from both `driveRun`'s `settleDyingStream` and `settleAcceptedStreamCalls`) → `discarded: 2` again, although nothing was recorded and the ledger still holds exactly two rows. A caller summing `discarded` across boundaries double-counts, and the reported settlement contradicts the ledger's durable contents.
- **Fix**: count only fragments actually newly recorded (`discarded += 1` after the insert, keyed off `fragments.entries()` so anonymous fragments keep deterministic positional ids), and document the first-time-only contract on the method.
- **Regression**: `replaying a discarded prelude reports nothing new, like settlement does` — fails without the fix, passes with it.

### 3.3 Retracted from the earlier report

- **`pendingSubagentNotices` "foreign parent" filter** (`background-receipts.ts:52`): the earlier report claimed a row without a `parent` field could leak another session's task into this journal. Not a defect. `session.task_runs` is only ever written by `records.ts:99-101` (`recordRun`, where `startRun` always sets `parent`) and `coordinator.ts:143-155` (`sync`, which sets `parent` from the registry row), i.e. it is by construction the session's own journal; the HTTP/service paths that read *other* sessions' rows use `subagent-rows.ts:13`, which does require positive parent evidence. Tightening the receipt filter as the earlier report proposed would silently drop legitimate legacy rows that predate the `parent` field from notification — a regression, not a fix.
- **"Asymmetric rollback" in `mergeSubagentNotices`** (`background-receipts.ts:86-104`): the stamp is guarded by `if (row && row.notified !== true)`, so only rows this call actually flipped are pushed to `stamped` and only those are reset on failure. Write and rollback are symmetric by construction; no reachable divergence was found.

Neither retraction changes runtime behaviour; both are recorded so the earlier report's claim is not mistaken for verified coverage.

---

## 4. Verification

Commands run in `/workspace/xueness-021/ts` after the fixes:

- `bun scripts/check-max-lines.ts` → `check:lines ok: 776 prod files, largest packages/engine-tools/src/background.ts (388 effective lines, max 400)`
- `bun scripts/check-plugins.ts` → `check:plugins ok: 33 plugins, 463 source files`
- `bun run typecheck` (`tsc -p tsconfig.json`) → exit 0, no diagnostics
- Affected regressions all pass: `packages/agent/test/{accepted-call-ledger,command-priority,runner-terminal}.test.ts`, `plugins/sessions/test/{steering-priority,steering-wait-window,session-lease}.test.ts`, `plugins/planning/test/goal-contract.test.ts`, `plugins/subagents/test/background-receipts.test.ts` (7 pass), `plugins/workflows/test/{dynamic-lifecycle,dynamic-blocked-reminder}.test.ts`

Each new regression test was re-run against the unfixed source (the relevant fix stashed): each fails without its fix and passes with it.

Gates and the two regression files were re-run once more at commit `68502ab` (the commit that carries the fixes) and still pass.

**Environment note**: at the start of this pass `ts/node_modules` was a self-referential symlink, so no `@xueness/*` package resolved and every `node --test` file errored at import time rather than running. It was restored with an offline `npm install` from the local cache before any test result above was taken. That restore shows in `git status` as a modification to the tracked `ts/node_modules` entry and is deliberately **not** part of the review commit.

## 5. Verdict

Contracts `C-WFL-01`–`C-WFL-05` and `C-MDL-03` are implemented as specified, with the plugin-ownership rules of `AGENTS.md` respected: every new behaviour lives either in `agent`/`sessions` shared infrastructure or in the `planning`, `subagents` and `workflows` plugins, and each new module is exported through its plugin's or package's `index.ts` rather than being wired into the CLI, web server, agent kernel or workbench container. With the five prior fixes confirmed and these two additional defects fixed, the phase is accepted.
