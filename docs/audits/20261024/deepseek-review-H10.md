# Phase H10 review — optimizer (fitness/loop) + chaos catalog & stress runner

Reviewer: deepseek-v4.1-flash (1017 max)
Date: 2026-10-24
Scope: phase H10 commits in `5116ee7` ("H10.03-04 + H11.01-02 + H12.01/05-06"), branch `wt-review-2`
Verdict: **one real contract gap found and fixed**; rest of H10 is sound.

## Commits and files inspected

```
5116ee7 H10.03-04 + H11.01-02 + H12.01/05-06: optimizer, chaos, desktop telemetry/polish
```

H10-owned files (the H11/H12 files in the same commit were out of scope for this audit):

| File | Purpose |
| --- | --- |
| `ts/plugins/deepseek_harness/src/optimizer/fitness.ts` | H10.03 — fold H06 bench + H02 verify into one deterministic fitness score |
| `ts/plugins/deepseek_harness/src/optimizer/loop.ts` | H10.04 — budgeted hill-climb with sandbox containment |
| `ts/plugins/deepseek_harness/test/optimizer-fitness.test.ts` | 30 folding/ordering assertions |
| `ts/plugins/deepseek_harness/test/optimizer-loop.test.ts` | budget, containment, revert, patience assertions |

## Test evidence

```
bun test optimizer-fitness.test.ts optimizer-loop.test.ts  → 30 pass, 0 fail
bun test (4 H10/H11 chaos+optimizer files)                 → 48 pass, 0 fail
bun test plugins/deepseek_harness/test/                    → 333 pass, 2 fail
```

The 2 failures are **pre-existing and out of scope**: `e2e-extensions.test.ts` imports a non-existent `isFile` export from `@xueness/sessions`, and `e2e-hooks.test.ts` imports a non-existent `DEFERRED_TOOL_CALL` from `@xueness/providers`. Neither file nor either dependency package was touched by `5116ee7` (`git show 5116ee7 --stat -- ts/plugins/workflows` is empty, and the same class of drift accounts for the 1150 `tsc` errors in `plugins/workflows`). H10 introduced none of them.

## Finding (fixed): `foldFitness` was untypable for its documented pure use

`foldFitness` is documented as a **pure** fold — "fold both probes' outputs into the final breakdown (pure, no probes run)" — and takes a third parameter defaulting to `{}`:

```ts
export function foldFitness(benchReport, verifySummary, options: FitnessOptions = {}): FitnessBreakdown
```

But `FitnessOptions` declares the two required probes:

```ts
export interface FitnessOptions { readonly bench: BenchProbe; readonly verify: VerifyProbe; /* + weights, scale */ }
```

Consequences, all confirmed against the real compiler:

1. The default value `{}` does not satisfy the declared parameter type (`TS2739: Type '{}' is missing the following properties ... bench, verify`).
2. `createFitnessEvaluator`'s own internal call `foldFitness(report, summary, { weights, speedScaleTicks })` was a type error (`TS2345`) — i.e. **the module's own shipping code did not typecheck**.
3. Every test call site that passes only fold knobs was a type error: `{ speedScaleTicks: 1000 }` (3 sites) and `{ weights: {...} }` (1 site).
4. Because validation lived only in `validateOptions` (the probe path), the pure path silently accepted `weights: { verify: -1 }` or `speedScaleTicks: 0` and folded them into an out-of-contract score — contradicting the module's own contract ("non-negative weights", "must be positive", "Scores are finite and reproducible").

This is a genuine contract gap rather than a cosmetic typing nit: the probe-free entry point is the one the H10.05 trajectory analysis and report generation call, and it was both untypeable and unvalidated.

### Fix applied

Split the fold parameters from the probe parameters, and validate on **both** entry points:

```ts
/** Fold parameters shared by `foldFitness` (pure) and the probe evaluator. */
export interface FitnessFoldOptions {
  readonly weights?: FitnessWeights;
  readonly speedScaleTicks?: number;
}

/** Probe options: the two probes plus the fold parameters. */
export interface FitnessOptions extends FitnessFoldOptions {
  readonly bench: BenchProbe;
  readonly verify: VerifyProbe;
}
```

- `foldFitness(..., options: FitnessFoldOptions = {})` — pure path now typechecks with zero probes.
- `validateFoldOptions(options: FitnessFoldOptions)` holds the weight/scale checks; `validateOptions` delegates to it after checking the probes, so the evaluator keeps its fail-fast behaviour.
- `foldFitness` calls `validateFoldOptions` first, so a negative weight or non-positive scale now throws on the pure path too, as documented.

Result: `tsc` errors attributable to `fitness.ts` dropped from 7 to 0; total project count moved 1156 → 1150. `createFitnessEvaluator` still resolves `weights`/`speedScaleTicks` once outside the loop, so per-candidate behaviour and determinism are unchanged.

## Reviewed and found correct (no change)

### `fitness.ts`

- **Eligibility gate ordering.** Verify failure pins `score` to 0 while `verifyScore`/`benchScore`/`speedScore` still report the raw components, so a report can explain *why* a fast candidate was blocked. `eligible` is defined as exactly `verifyPassed`, matching the doc.
- **Empty-input conventions.** Empty gate selection and empty bench suite both score 1 ("nothing to fail"), documented in one place and implemented consistently.
- **Speed decay.** `1 / (1 + totalTicks/scale)` is monotone, bounded in `(0, 1]`, and guarded for `ticks <= 0` / non-finite. `BenchRunSummary.totalTicks` is summed over **ok** results only (`bench/runner.ts:126`), so the "ok cases only" doc claim is accurate — failed cases cannot distort speed.
- **`compareFitness` total order.** eligible → score desc → ok desc → ticks asc → `genomeId` asc covers every field that can differ, so the sort cannot fall through to an unstable comparator. Note `NaN` cannot leak into the score: all three components are guarded and `round` of finite input is finite.

### `loop.ts`

- **Budget never overspent.** Every cap (`iterations`, `evaluations`, `wallMs`) is checked *before* consumption, and the evaluation unit is additionally re-reserved after `mutate` (`loop.ts:209`) so a cap trip cannot leave an applied genome un-reverted. `stopReason` always names the cap that actually stopped the run.
- **Fail-stop containment.** `genomeInsideSandbox` runs **before** `apply` (`loop.ts:203`); a violation breaks with `sandbox_violation` rather than skipping the candidate. `resolveInsideSandbox` normalizes `\\`→`/`, treats absolute paths as absolute, and compares against a `root + sep` prefix, so `/tmp/opt-sandbox-evil` does not pass as inside `/tmp/opt-sandbox` (the prefix-separator case the tests cover).
- **Revert on probe crash.** The `try/catch/finally` around `evaluate` reverts the sandbox even when the probe throws, and the crashed candidate is still recorded in `history` (score 0, `accepted: false`) so the H10.05 trajectory sees every evaluated candidate.
- **Initial genome containment.** An out-of-sandbox *initial* genome throws before the baseline evaluation, so the loop cannot be seeded past its own guard.
- **`patience`.** Counter resets only on acceptance, and crashed candidates count toward stagnation — consistent with "no improvement".

### `chaos/scenarios.ts` + `chaos/stress-runner.ts` (H11, same commit, checked as a call-contract neighbour of H10)

- `ChaosError` carries `kind`/`status`/`retryAfterMs`; `isChaosError` mirrors `instanceof`. Fault sequencing is a pure call counter (`n % everyN`), never wall-clock, so runs replay deterministically as documented.
- Stress runner isolates per scenario: a throwing `inject()` marks that scenario's calls failed without rejecting the run, thrown errors go to `errors`, non-throwing invalid bodies go to `invalidResponses`, and `errors` is capped by `maxErrorsRecorded`.
- Concurrency truthfully reported: `maxConcurrentObserved` is sampled from `pool.busyCount` after acquire and cannot exceed `concurrency`; `totalFailures` sums failed **and** invalid.

## Observations (no change made)

1. **No H10 feature/module registration.** `ts/plugins/deepseek_harness/manifest.json` lists 6 `modules` (all `builtins/*`) and 8 `features`; neither the optimizer nor the chaos modules appear, and `ts/catalog/deepseek_harness.json` mirrors only the 8 features. I did **not** change this, because H10 adds no user-facing surface: no RPC method, no CLI command, no tool, no panel — `HARNESS_METHODS` is unchanged by this commit, and the modules are exported as library API only. This matches the existing precedent for `tournament/` (H09) and `bench/profiler`, which are likewise absent from `features`. If a later phase exposes the optimizer through RPC/CLI, AGENTS.md requires adding stable `deepseek_harness.<feature>` entries (with Chinese `name` + `nameEn`) to both the manifest and the catalog at that time.
2. **Symlinks are not resolved.** `resolveInsideSandbox` uses `path.resolve` only, so a symlink *inside* the sandbox pointing outside would pass containment. This is acceptable for the documented contract ("containment via `resolveInsideSandbox`", paths declared by generated genomes) and resolving links would require I/O in what is currently a pure, testable function — a deliberate trade-off worth keeping, but worth stating explicitly if the write side ever gains `fs` capability.
3. **`history` score on crash is `0`, not the partially-computed value.** Intentional and documented; noted only so consumers of the H10.05 trajectory do not read `0` as "measured and terrible".

## Gates after the fix

| Gate | Result |
| --- | --- |
| `bun test` H10 files (30) / with chaos (48) | pass |
| `bun test plugins/deepseek_harness/test/` | 333 pass, 2 fail (pre-existing `sessions`/`providers` export drift, unrelated) |
| `bun scripts/check-max-lines.ts` | ok — 876 prod files, largest 399/400 |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 544 source files |
| `bun run typecheck` | `fitness.ts` errors 7 → 0; remaining 1150 are pre-existing `plugins/workflows` / `@xueness/sessions` drift, untouched by H10 |

Only `ts/plugins/deepseek_harness/src/optimizer/fitness.ts` was modified; no test, manifest, catalog or frontend file was touched.
