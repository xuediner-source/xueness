# Phase F10 Review — Dynamic Workflow Language, VM/Harness, Typed Actors, World Runs, Artifact/Stream/Dashboard SDK, Resume/Amend Lineage & Blocked Reminders

- **Reviewer model**: deepseek-v4.1-flash (1017 max)
- **Scope**: the four F10 phase commits
  - `96dd8a0` — F10.01 dynamic workflow language & type contract + F10.02 workflow VM/harness
  - `3364ffa` — F10.03 typed actors & repair + F10.04 `world.run` / world reads
  - `70fa062` — F10.05 Artifact/Stream/Dashboard SDK + F10.06 Resume/Amend & run lineage
  - `6a722c3` — F10.07 Workflow blocked reminders
- **Outcome**: 3 real defects found and fixed; all gates green after the fixes.

## Baseline verification

| Check | Result |
| --- | --- |
| `bun test plugins/workflows packages/agent` (pre-fix) | 403 pass, 0 fail (43 files) |
| `bun test plugins/workflows packages/agent` (post-fix) | 405 pass, 0 fail (43 files) |
| `bun scripts/check-max-lines.ts` | ok — 799 prod files, largest 398/400 effective lines |
| `bun scripts/check-plugins.ts` | ok — 33 plugins, 484 source files |
| `bun run typecheck` | exit 0 |

The phase tests all passed, so the review targeted the *cross-module* contracts a unit test does not exercise: harness lifecycle versus fire-and-forget ports, the durable stream log versus a torn tail, and the reminder ledger versus its own batch cap.

## Defect 1 — A capped reminder was stamped delivered without ever being delivered (lost reminder, F10.07)

`BlockedReminderTracker.poll()` computed the due stage for a blocked node and then, when the batch was already full, **still** recorded every stage up to and including that one in `deliveredStages` — it only skipped the `due.push`. The node was therefore permanently marked as reminded without a reminder ever leaving the tracker, and because only steering or run progress re-arms the ladder, nothing would ever remind it again.

Failure scenario, reproduced before the fix with `limit: 2` and three blocked runs at a single boundary:

```
poll(t=2000) → []            (nothing is old enough yet)
poll(t=3000) → ["a","b"]     (c is capped … and silently stamped stage 0)
poll(t=4000) → []            (c never reminds again — the run stays blocked forever, unnoticed)
```

Observed after the fix: `poll(t=4000) → ["c"]`.

The existing test asserted `poll(t+60_000) === []` after a capped poll, i.e. it encoded the bug as intended behaviour.

**Fix** — `plugins/workflows/src/dynamic-blocked-reminder.ts`: the cap check now precedes the ledger write, so a node past the batch limit keeps its stage undelivered and the next poll picks it up; the backlog drains at the rate of `limit` per poll. The regression test now drains the full backlog and asserts 2 per poll down to empty, then silence.

## Defect 2 — A rejected fire-and-forget port escaped as an unhandled rejection (real bug, F10.02)

`report`/`log`/`phase` are non-awaited capabilities: the host pushes `invokePort(...)` onto `sideEffects` and returns `void` to the script. The results are only inspected *after* the evaluation settles (`Promise.allSettled(sideEffects)`). If the port rejects while the script keeps running — or after the script has already returned — the rejection is unobserved at that moment.

Reproduced: a script calling `report(1)` against a rejecting `events` port and then awaiting a slow `ask` printed `UNHANDLED: report rejected` on `process.unhandledRejection` *before* the harness returned. On a Node/Bun host with the default `--unhandled-rejections=throw`, that terminates the process hosting an otherwise healthy run; the harness's "never throws, every failure is a coded result" contract does not hold for its own port calls.

**Fix** — `packages/agent/src/script/dynamic-harness.ts`: a `trackSideEffect()` helper attaches a no-op catch at push time and keeps the original promise in `sideEffects`, so the aggregate check still reports `DYNAMIC_PORT` while no rejection is ever unobserved. Regression test asserts zero `unhandledRejection` events and a `DYNAMIC_PORT` failure naming the port error.

## Defect 3 — A torn tail silently swallowed the next stream event (durability bug, F10.05)

`DynamicStreamBroker.publish()` appended `"<json>\n"` to the JSONL log unconditionally. If a previous write died mid-line (crash, ENOSPC), the file ends in a partial record with **no** newline. The new event is concatenated onto that partial line, so the next `#parse` skips the whole merged line as malformed — the newly published event is durably lost from the log while `publish` still returned it to live listeners.

Reproduced: publish `{n:1}`, append `{"seq":2,"at":"x","pay` (no newline), publish `{n:2}` → `read().events` was `[seq 1]` only, although `publish` returned `seq: 2` and live subscribers received it. A restart-then-replay subscriber would never see event 2, and `lastSeq` under-reports, so `gap` detection also lies.

**Fix** — `plugins/workflows/src/dynamic-streams.ts`: `publish()` reads the existing log once, and when it does not end in a newline prefixes the append with `"\n"`, terminating the torn record so the new event starts its own line. The torn line stays skipped (as documented) and the new event is durable. Regression test appends a partial line directly and asserts both events replay in order.

## Contract observations (no change made, judged correct as designed)

- **`dynamic-language.ts`** — the published surface and `DYNAMIC_DIAGNOSTICS` match what the compiler and evaluator actually emit after the F10.01 widening (`do/while`, `switch`, comma, `in`, `typeof`/`void`/`~`, `--`, spread, destructuring, `as`/`satisfies`, optional chaining). `forbidden.globals`/`forbidden.properties` are the same set the compiler rejects, so the document cannot advertise a capability the VM refuses.
- **`dynamic-harness.ts` budgets** — `reach()` charges `portCalls` *before* the port/op gate, so probing an unregistered capability still spends budget; the op allowlist (`port.ops`) is checked per call rather than trusting the port, and `DYNAMIC_TIMEOUT` is sticky over a racing `DYNAMIC_CANCELLED` so a deadline never masquerades as a host cancel. `ManualDynamicClock.advance()` resolves only waiters whose deadline elapsed and leaves the rest pending.
- **`dynamic-actors.ts`** — `classifyThrown` never treats an abort as repairable; a hold (`awaiting_user`/`paused`) is returned un-validated and transcripted rather than burned as a repair attempt; the repair loop is bounded by `repairBudget` with `budget_exhausted` carrying the full attempt history; `ledger.commit` keys on `run:node:inputHash` so a resumed run replays a completed ask and a recorded failure replays as a throw. Note the `spec.input` check is intentionally inert (instructions are text, not the structured input), and it is commented as such.
- **`dynamic-world.ts`** — sub-run ownership (`parentRunId`/`rootRunId`/`ownerActorId`) and depth are computed from the record chain, usage rolls up only to the direct parent, the cache key is a canonical-JSON sha256 of `{name,args}` so key order cannot cause a false miss, and a failed executor records `status:"failed"` + error without caching. Reads fail closed with no `read` function configured.
- **`dynamic-artifacts.ts`** — content addressing makes re-save idempotent, a collision with a different body is a hard refusal rather than an overwrite, `resolve()` re-verifies the digest (so tampering is refused, not silently returned), cross-run refs are rejected, and `manifest()` exposes metadata only (no bodies). Inline threshold is inclusive (`<=`), matching the doc.
- **`dynamic-dashboard.ts`** — the snapshot is a projection over run records plus on-disk manifests/tails; oversized inline results are elided to a char count and artifact bodies never appear; every list is capped with an explicit `truncated` flag so a panel cannot silently show a partial picture.
- **`dynamic-evaluate-statement.ts` destructuring** — object rest copies only own data descriptors, skips already-bound keys and forbidden keys, and rejects markers; the switch shares one scope for all clauses (correct JS semantics for `let` redeclaration being an error, and `break` unwinds to `null`).

## Files changed by this review

- `ts/plugins/workflows/src/dynamic-blocked-reminder.ts` — cap check before the delivered-stage write.
- `ts/packages/agent/src/script/dynamic-harness.ts` — `trackSideEffect()` for fire-and-forget ports.
- `ts/plugins/workflows/src/dynamic-streams.ts` — terminate a torn tail before appending.
- `ts/plugins/workflows/test/dynamic-blocked-reminder.test.ts` — backlog drains instead of silencing.
- `ts/packages/agent/test/dynamic-harness.test.ts` — no unhandled rejection from a rejected report port.
- `ts/plugins/workflows/test/dynamic-streams.test.ts` — append survives a torn tail.
