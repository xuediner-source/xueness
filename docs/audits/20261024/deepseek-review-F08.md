# Phase F08 Review — Subagent Configuration, Dispatch/Collect/Resume, Message Contract & Parent-Child Lifecycle

- **Reviewer model**: deepseek-v4.1-flash (1017 max)
- **Scope**: the three F08 phase commits
  - `6a2a286` — F08.01 deepened agent configuration & context inheritance + F08.02 unified background Dispatch/Collect/Resume
  - `cd784e7` — F08.03 coordinator & message contract + F08.04 completion aggregation & hidden reminders
  - `d21e6d6` — F08.05 parent-child lifecycle coordination, budget reservation, cross-task recovery
- **Outcome**: 3 real defects found and fixed; all gates green after the fixes.

## Baseline verification

| Check | Result |
| --- | --- |
| `bun test plugins/subagents` (pre-fix) | 91 pass, 0 fail (11 files) |
| `bun scripts/check-max-lines.ts` | ok — 799 prod files, largest 398/400 effective lines |
| `bun scripts/check-plugins.ts` | ok — 33 plugins, 484 source files |
| `bun run typecheck` | exit 0 |
| `bun test apps/server/test/agent-subagents.test.ts` | 7 pass, 0 fail |

The existing phase tests all passed, so the review focused on contracts *between* the new modules — the paths where a unit test proves one module in isolation but the coordinator's state merge, the registry's restart, and the reminder stamp disagree.

## Defect 1 — A resumed child never got its completion reminder (contract gap, C-WFL-04 × F08.02)

`TaskCoordinator.sync()` copies `notified` and `termination` from the durable `task_runs` row onto the live registry row (deliberately: the registry never sets `notified`, and `background-receipts.ts` stamps it, so without the copy every `sync()` would erase the stamp). `TaskRegistry.restart()` resets `status`/`summary`/`error`/`endedAt` for a resumed child but left those two fields alone.

Failure scenario, reproduced before the fix through the real `sync()` + `mergeSubagentNotices()` path:

1. A child fails → terminal notice delivered → durable row carries `notified: true` and `termination.reason: "child_error"`.
2. The parent calls `task_resume` → `restart()` flips the row back to `running`, but `notified: true` and the old `termination` survive.
3. The resumed child finishes **successfully**. `terminateTask` correctly writes no reason for a clean success — but `sync()` re-merges the stale `termination`, so the durable row reports a clean `completed` task with `termination.reason = "child_error"`. Worse, `pendingSubagentNotices` skips the row because `notified === true`, so the completion is **never reminded** and the model never learns the follow-up finished. The whole F08.04 reminder contract is silently defeated for every resumed task.

Observed after the fix: `notices after resumed success: ["subagents:<task>:completed"]`, row `{status: "completed", notified: undefined, termination: undefined}`.

**Fix**
- `task-registry.ts` — `restart()` now deletes `termination` and `notified`: the previous attempt's outcome does not describe this run.
- `coordinator.ts` — a new `STALE_WHILE_RUNNING` field set; `sync()` refuses to merge `notified`/`termination` from the journal while the live row is `RUNNING`, so an older journal stamp cannot resurrect either one mid-run (this also covers a resume that arrives before the parent ever collected).

## Defect 2 — The concurrency limit was process-global, not per session (real bug, F08.02)

`coordinator.ts` held `let slots = MAX_CONCURRENT` at **module** scope with free functions `takeSlot`/`giveSlot`. Every `TaskCoordinator` in the process — one per live parent turn, and the server creates a fresh one per run (`agent-service.ts:253`) — drew from the same counter of 4.

Failure scenario, reproduced: coordinator A (session `a…`) dispatches 4 long children; a completely unrelated coordinator B (session `b…`) then dispatches its first child and is refused with `subagent workers are busy (4); wait for existing requests to finish`. Two concurrent user sessions starve each other; a leaked slot in one session permanently reduces capacity for all of them, and `close()` of any coordinator hands slots back to a shared pool it never took from (the counter could grow past 4, silently raising the limit).

**Fix**: the slots became a private per-instance field (`#slots`) with `#takeSlot()`/`#giveSlot()` methods; the module-level mutable counter is gone. All dispatch, resume and worker-finish call sites use the instance methods.

## Defect 3 — Stale `termination` reported on a clean re-run (same root cause as 1, confirmed via the registry directly)

Verified directly on the registry (`record` → `terminateTask(child_error)` → `restart` → `terminateTask(ok)`): the row ended `completed` with `termination.reason: "child_error"`. `terminationReason()`/`isTermination()` would report an abnormal stop for a task that succeeded, and `tasks-http.ts`/the sidepane read that field. Fixed by the same `restart()` change in Defect 1; the regression test asserts `term(done) === undefined` after a clean re-run.

## Contract observations (no change made, judged correct as designed)

- **`nextOperations` / `splitForCollect` / `reconnectPlan`** — the state table matches the F08.02 contract: `running` never resumes, `completed` requires a follow-up message, `failed` retries bare, `cancelled` is closed; deliver-once splits `fresh`/`delivered`/`pending` and the coordinator only marks `collected` on `fresh`.
- **`message-contract.ts`** — identity is authorized against the parent's own registry row *before* any child-store read (`resolveTaskIdentity` returns `foreign_parent`/`stale_child`), escalation replay is idempotent by `requestId` + digest, a second pending escalation per task is refused, and answering clears `pending_question` only when no escalation remains open. The 40-item prune drops only answered items.
- **`child-journal.ts` / `agent-subagents.ts`** — `enqueueMessage` refuses plain guidance while a question is pending (`pendingQuestionOk` is the answer path), the inbox and escalation directories both refuse symlinks, and every write is an atomic 0600 `mkstemp` + `rename`. The escalation port is bound only on the child run (`toolEnv.escalationPort`), which is the authorization boundary rather than the model's word.
- **`inheritance.ts` (F08.01)** — inheritance is strictly narrowing: the branch is a deep clone of plain narration rows only (system/guide/notice/`_meta_source` rows and pure tool-call turns dropped), bounded by messages *and* chars with at least one turn kept; `childToolGrant` intersects with the parent's offered set and subtracts parent + forced denials; `clampModelSelection` falls back to the parent's selection instead of escalating. No path lets a child see or acquire more than its parent.
- **`agent-contract.ts` / `tool.ts` / `prompt/view.ts`** — the shared-kernel touches are additive: an optional `inherit_history` input, an optional `ToolEnv.escalationPort`, and one presentation branch (`_coordination` → `coordinator_steer`, an existing variant) so a child attributes drained messages to the coordinating parent rather than the user. None of them grant capability on their own.
- **`background-receipts.ts`** — notices carry status facts only, never the child summary (untrusted findings), are capped at 8, deduplicated by key across current *and archived* messages, and roll back both the journal and the stamps when the save fails.

## Files changed by this review

- `ts/plugins/subagents/src/coordinator.ts` — per-instance worker slots; `STALE_WHILE_RUNNING` guard in `sync()`.
- `ts/plugins/subagents/src/task-registry.ts` — `restart()` clears `termination` and `notified`.
- `ts/plugins/subagents/test/lifecycle-coordinator.test.ts` — two regressions: "a resumed child drops the previous attempt's outcome…" and "worker slots are per coordinator, so one saturated session cannot starve another".

## Verification after the fixes

| Check | Result |
| --- | --- |
| `bun test plugins/subagents` | **93 pass, 0 fail** (11 files; +2 regressions) |
| `bun test apps/server/test/agent-subagents.test.ts` | 7 pass, 0 fail |
| `bun scripts/check-max-lines.ts` | ok — 799 prod files, largest `plugins/subagents/src/coordinator.ts` 398/400 effective lines |
| `bun scripts/check-plugins.ts` | ok — 33 plugins, 484 source files |
| `bun run typecheck` | exit 0 |

No plugin inventory change was needed: all fixes stay inside the `subagents` plugin's existing modules, tools and features (`subagents.coordination`, `subagents.tasks`), and no new dependency, panel or tool was introduced.
