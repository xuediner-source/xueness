# Phase H11 Review — Cross-plugin stress & chaos tests

- **Phase:** H11 — "Cross-plugin stress & chaos tests" (H11.01–H11.06)
- **Reviewer:** deepseek-v4.1-flash (1017 max)
- **Worktree:** `/workspace/wt-review-3` (branch `main`)
- **Review date:** 2026-10-24

## Commits under review

No commit subject begins with `H11.` — the phase shipped inside two batch commits:

| Commit | H11 content |
| --- | --- |
| `5116ee7` | H11.01-02: `chaos/scenarios.ts`, `chaos/stress-runner.ts` + 4 test files |
| `226baab` | H11.03-06: `chaos/report.ts`, `chaos-*` tests, `deepseek_harness/chaos` RPC + CLI gate, `optimizer/genome.ts`, `history.ts`, `skill-diff.ts`, tournament `report.ts` / `live-adapter.ts` |

Because the phase has no dedicated commit, the `evidence` fields in
`docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.json` point at `360721e` and
`morning-wrap-20261026`, neither of which is an H11 commit in this history.
The code is present and tested; only the evidence trail is imprecise.

## Verdict

**Pass with fixes applied.** The chaos catalog, bounded-concurrency runner,
flake detector and RPC/CLI gate are structurally sound and all 29 phase tests
pass. Two real contract gaps were found in the hard-fail gate and fixed in
this review.

## Scope verified

- **H11.01 — scenario catalog.** 6 scenarios covering all 6 declared fault
  families (`timeout`, `rate_limit`, `partial_json`, `malformed_json`,
  `empty_body`, `flaky`); `chaosCatalogCovered()` asserts the >= 6 /
  full-coverage acceptance criterion. Faults are sequenced by a call counter
  (`everyN`), never wall-clock or `Math.random`, so runs are deterministic.
- **H11.02 — stress runner.** One shared `SlotPool` is the only concurrency
  gate; `maxConcurrentObserved` is a genuine high-water mark of
  `pool.busyCount` sampled *after* `acquire()`. Per-scenario failures are
  bucketed, an `inject()` that throws is isolated, and every started call is
  accounted as `succeeded`/`invalidResponses`/`failed` (asserted by H11.03).
- **H11.03 / H11.04 — cross-plugin stress.** Slot-pool cleanup and
  quota/429 degradation assertions hold; no deadlock (the run resolves).
- **H11.05 — report + flake detector.** Deterministic markdown + canonical
  JSON; emits `ChaosReport.hardFail`.
- **H11.06 — RPC/CLI gate.** `deepseek_harness/chaos` validates
  `concurrency`/`callsPerScenario`/`scenarioIds`; CLI maps a hard fail to
  exit `1` and invalid input to exit `2`.

## Defects found and fixed

### 1. The hard-fail gate could not detect a wholly broken run (high)

`buildChaosReport` only set `hardFail` when a scenario had **both** successes
and failures at a rate >= `hardFailRate`. Consequences:

- A scenario rejecting on *every* call with a plain `Error` (no `ChaosError`
  kind — a dropped connection, a wiring bug, a mis-wrapped model) produced
  `succeeded === 0`, so the mixed-outcome branch never fired and the report
  said `hardFail: false`. The H11.06 gate then exited **0** for a run in
  which every call failed.
- `faultKinds` was collected but never consulted, so a scenario throwing a
  fault kind it does not inject was treated as an expected fault.

Reproduced before the fix: an all-rejecting scenario reported
`hardFail=false`, and `harnessCommand(["chaos", ...])` exited `0`.

Fix: added `expectedChaosFaultKinds(kind)` to `chaos/scenarios.ts` (timeout →
`timeout`, rate_limit/flaky → `rate_limit`, body families → none) and made
the report hard-fail on either:
- failures not attributable to the injected fault (`faultKinds` empty, or
  outside the scenario's expected set), or
- a body family (`partial_json`/`malformed_json`/`empty_body`) that throws
  at all, since those families are meant to *resolve* with bad text.

Both conditions also emit a `FlakeFlag` naming the reason.

### 2. An empty `scenarioIds` list was a vacuous pass (medium)

`deepseek_harness/chaos` with `scenarioIds: []` ran zero scenarios and
returned `{ ok: true, hardFail: false, totalCalls: 0 }`. A caller could get a
green chaos gate without a single call executed. Now rejected as
`invalid_input`, consistent with the existing "unknown scenario" validation.

## Regression coverage added

`test/chaos-report.test.ts` (+4 cases): healthy default catalog stays green
with exactly the one expected `flaky_intermittent` flake; an un-attributed
rejecting scenario hard-fails; an out-of-family fault kind hard-fails; a body
family that throws hard-fails.

`test/chaos-cli.test.ts` (+1 case): empty `scenarioIds` returns
`invalid_input`.

## Verification

| Command | Result |
| --- | --- |
| `bun test plugins/deepseek_harness/test/chaos` | **29 pass, 0 fail** (6 files) |
| `bun scripts/check-max-lines.ts` | ok — 884 prod files, max 399/400 |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 550 source files |
| `bun run typecheck` | **1147 errors, identical to the pre-change baseline** |

The typecheck failure is pre-existing and repo-wide: `plugins/workflows`,
`apps/server/src/bundled-plugins.ts` and some harness tests reference
members (`SessionStore`, `lockFileSync`, `mkstemp`, `PyOSError`,
`resourceDispatch`, `@xueness/plugin-deepseek_harness`) that
`@xueness/sessions` does not export. Verified by stashing the review changes
and re-running: the count is 1147 either way, so these fixes introduce no new
type errors. It is a shared-infrastructure break outside H11's ownership and
is recorded here rather than patched, since repairing `@xueness/sessions`
exports would reach well beyond this phase.

## Notes, not defects

- `ScenarioStressResult.durationMs` uses `Math.max` over settle timestamps,
  so it measures wall-clock span across a scenario's interleaved calls rather
  than per-call latency. Fine for a stress gate; not a latency metric.
- `flaky_intermittent` overrides `everyN` to 3; with `callsPerScenario < 3`
  the injected fault never fires. The scenario still passes, so no gate
  false-negative, but a run cannot exercise it at `callsPerScenario: 1`.
- Phase evidence in `ZCODE-FULL-ALIGNMENT-TASKS-20261024.json` should be
  repointed at `5116ee7` / `226baab`.
