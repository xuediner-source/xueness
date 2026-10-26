# Phase H07 Review — swarm coordinator, sharding, critic slots, job isolation

**Reviewer:** deepseek-v4.1-flash (1017 high)
**Scope:** `H07.01-02` (`64ec5e5`), `H07.03-04` (`c97ebc7`)
**Plugin:** `ts/plugins/deepseek_harness` (`src/swarm/*.ts`, `test/*.test.ts`)
**Verdict:** Two real defects fixed, one contract gap closed, regression tests added.

## Commits reviewed

| Commit | Content |
| --- | --- |
| `64ec5e5` | `swarm/coordinator.ts` (slot bookkeeping), `swarm/sharding.ts` (non-overlapping LPT shards), `test/coordinator.test.ts` |
| `c97ebc7` | `swarm/critic-slots.ts` (dual-pool scheduler), `swarm/job-runner.ts` (failure isolation), two test files |

## Baseline test run

The three H07 suites were green before review (`32 pass, 0 fail`), so the defects
below are not test failures — they are uncovered invariants found by probing the
modified code directly.

## Findings

### 1. `SlotPool.release` over-admits one slot to two holders (fixed)

`critic-slots.ts` pushed the slot id onto the free list unconditionally:

```ts
release(slot) { slot.completed += 1; /* push id even if already idle */ }
```

Releasing an already-idle slot (a double `finally`, a retry path that also
releases, or a supervisor replay) inserts the same id twice, so two concurrent
`acquire()` calls both resolve to `critic-0` while `size` stays 1. Probe before
the fix:

```
two acquirers got: critic-0 critic-0 busy= 1 size= 1
```

That silently breaks the module's core guarantee — the per-kind concurrency
high-water marks in `SwarmStats` and the "pools never share capacity"
separation H07.03 exists to provide. Now `release` throws
`slot <id> is not acquired` when the slot is not `busy`, matching the stricter
`SwarmCoordinator.release`/`retireSlot` style in H07.01.

### 2. `CriticSlotScheduler.run` rejected and dropped an outcome when a model threw (fixed)

`solveTask` had no `catch`: a throwing solver call propagated through
`Promise.all`, so `run()` rejected even though the other tasks' patches were
already queued and reviewed. The H07.03 contract says "returns one review
outcome per task, in the order each patch was queued" — after a rejection the
caller cannot learn which patch was lost. Probe before the fix:

```
run() => rejected: solver boom
```

`runReview` had the same shape for the critic call. Both are now contained:
a crashed solver queues `{ solverError }` and a crashed critic yields no
outcome, each surfaced as a `CriticReview` with `malformed: true`,
`verdict: "reject"`, `score: 0` and a `solver failed: …` / `critic failed: …`
reason. `run()` now always resolves with exactly `tasks.length` outcomes;
slots are still returned in `finally`, so no slot leaks on the crash path.
This also makes H07.03 and H07.04 agree: both isolate per-job failures instead
of letting one task tear down the run.

### 3. A retrying job held its solver slot through the backoff delay (fixed)

`JobCoordinator.runJob` released the slot only in `finally`, so during
`await sleep(retryDelayMs)` the job kept a slot `busy` while doing no work.
With `solverSlots: 1` a backing-off job blocks every sibling for the whole
delay. Probe with `retryDelayMs: 60`, one slot:

```
mid-run after poison failed (no request in flight): [{"kind":"solver","total":1,"busy":0},...]
call order so far: poison,other,poison
```

(after the fix — `other` now runs inside the retry window). The release moved
to a `released` flag so the retry path frees capacity before sleeping and the
`finally` stays a safe no-double-release net.

### 4. Misleading `CoordinationResult.ok` doc (fixed)

The comment claimed `ok` means "every job reached a terminal state without an
exception escaping", but the value is `progress.failed === 0`. Since `runJob`
always contains exceptions this could never be false under the documented
meaning, while it is legitimately false when a job is marked failed. Comment
corrected to the actual contract.

## Reviewed and found sound

- `sharding.ts`: LPT assignment with path-sorted determinism, `strict`
  duplicate rejection, `shardsAreDisjoint`/`shardsCover`/`shardWeightSpread`
  helpers; empty input, out-of-range `shardCount` and negative/non-finite
  weights all validate. Shard counts never exceed `shardCount` and every file
  lands in exactly one shard.
- `coordinator.ts`: exclusive hand-out, FIFO waiter drain on release,
  `abortWaiters`, `retireSlot` capacity accounting, idempotent lease
  `release()`, and `SlotAcquisitionError` on saturation.
- `critic-slots.ts` separation: solver slots are released before the review is
  drained, so a slow critic cannot starve solver throughput, confirmed by the
  per-kind `maxActive` assertions.
- `job-runner.ts`: attempts accounting (`1 + maxRetries`), `retrying` counted
  as pending in `progress()`, retry provenance kept in `job.error` after
  recovery, `maxRetries >= 0` validation.

## Changes applied

- `ts/plugins/deepseek_harness/src/swarm/critic-slots.ts` — release invariant;
  solver/critic error containment; `unreviewed()` helper.
- `ts/plugins/deepseek_harness/src/swarm/job-runner.ts` — release slot before
  retry backoff via a `released` flag; corrected `ok` doc.
- `ts/plugins/deepseek_harness/test/critic-slots.test.ts` — 3 new tests
  (double-release rejection, throwing solver, throwing critic).
- `ts/plugins/deepseek_harness/test/swarm-failure-isolation.test.ts` — 1 new
  test (slot freed during retry backoff).

## Verification

```
bun test coordinator.test.ts critic-slots.test.ts swarm-failure-isolation.test.ts
  → 36 pass, 0 fail (32 before, +4 new)

bun scripts/check-max-lines.ts
  → check:lines ok: 863 prod files, largest 399 effective lines (max 400)

bun scripts/check-plugins.ts
  → check:plugins ok: 35 plugins, 534 source files

bun run typecheck
  → 1145 errors, all in plugins/workflows (missing @xueness/sessions exports);
    identical count with the H07 changes stashed, zero errors in
    plugins/deepseek_harness → pre-existing, unrelated to this phase.
```

No changes to catalog/manifest registration were needed: H07 ships internal
swarm modules exported through `src/index.ts` and adds no user-facing feature,
tool, CLI command or panel, so the plugin-feature registration requirements do
not apply.

## Residual notes (not fixed — design input)

- `CriticSlotScheduler.run`'s drain loop polls with `setTimeout(0)` while the
  review queue is briefly empty; correct but a condition-variable wake-up on
  `review-queued` would avoid the churn at high shard counts. `JobCoordinator`
  is unaffected (it uses `Promise.all` directly).
- `JobCoordinator` allocates a critic pool it never schedules work on
  (`slotStatuses()` reports it for symetry). Harmless today; either wire critic
  reviews in or drop the pool when H07.04 is extended.
