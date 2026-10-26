# H06 Review — Bench suite, profiler, regression reports, bench CLI

**Reviewer model**: deepseek-v4.1-flash (1017 max)
**Scope**: all phase H06 commits in `/workspace/wt-review`
**Verdict**: accepted after four fixes (two correctness bugs, one type-surface break, one integrity gap) plus one registered contract gap

## Commits reviewed

| Commit | Round | Content |
| --- | --- | --- |
| `a98f069` | H06.01-02 | Bench runner skeleton (`bench/runner.ts`) + deterministic fixtures (`bench/cases.ts`) |
| `fcb69cb` | H06.05-06 | Regression report generator (`bench/report.ts`) + bench suite and CLI/RPC (`bench/suite.ts`, `src/index.ts`) |
| `e84340c` | H06.03-04 | Token/cache/latency profiler (`bench/profiler.ts`) + profiled runner (`bench/profiled-runner.ts`) |

## What holds up

- **Determinism is real, not asserted.** Every module takes an injected clock (`clock`, `nowMs`, `now`) and no module in H06 touches I/O, network or randomness. Two runs under the same clock are byte-identical, and `formatBenchReport` / `serializeRegressionReport` / `renderRegressionMarkdown` are stable string/byte emitters (`runner.test.ts:117`, `bench-cli.test.ts:9`).
- **Failure isolation is correct at every layer.** A throwing workload fails its own case (`runner.ts:90`), a throwing scenario fails its own suite entry (`suite.ts:362`), a rejecting provider call is excluded from the profile rather than profiled with fake numbers (`profiled-runner.ts:403`), and invalid/duplicate case ids never abort the remaining cases (`runner.ts:135-147`).
- **One dispatch surface.** `harnessCommand(["bench", ...])` goes through `api.dispatch("deepseek_harness/bench", ...)` (`index.ts:152`), so CLI and RPC cannot drift; exit codes align with the H05.06 contract (0 healthy, 1 unhealthy, 2 usage).
- **Untrusted baseline payloads are validated** by `coerceBenchRun` (`index.ts:118`) before reaching `compareBenchRuns`, with the metric row fully type-checked.
- **Regression semantics are sound.** Direction-aware verdicts (`lower-is-better` vs `higher-is-better`) with a relative threshold, zero-baseline infinite jumps, `flippedToFailed` / `addedCases` / `removedCases` drift tracking, and an `healthy` flag that also catches new failures (`report.ts:171-209`).
- **Fixtures are genuinely synthetic and reproducible**: every input derives from an index, no `Math.random`, and the fixtures exercise real pipelines (`importSweBenchTasks`, `parseHarnessPackage`, `createPrefixCache`, `planShards`) rather than timing stubs.

## Defects found and fixed

### 1. `runBenchCase` produced `NaN` timings for a non-positive iteration count (fixed)

`runBenchCase` is exported and documented as "measure one well-formed case", but nothing enforced well-formedness when it is called directly — only `runBenchCases` pre-validated. With `iterations: 0` the loop body never ran, so `minTicks` stayed `Number.POSITIVE_INFINITY` and `meanTicks` became `0 / 0`:

```
runBenchCase({ iterations: 0, ... })
=> {"ok":true,"timings":{"totalTicks":0,"minTicks":null,"maxTicks":0,"meanTicks":null}}
```

`JSON.stringify` turns both `Infinity` and `NaN` into `null`, so this silently corrupts the RPC/CLI surface (a null `meanTicks` in a parseable report) and every downstream aggregate, and the result is reported as `ok: true` — a benchmark that measured nothing claims success. Negative counts returned a nonsensical `iterations: -2`.

Fixed in `runner.ts:81` — the iteration guard now lives in `runBenchCase` itself, so every entry point shares one contract. It returns the same failed shape `runBenchCases` already emitted (`ok: false`, `timings: null`, `valueDigest: null`, `iterations: 0`).

### 2. `profiler.measure` depended on `this` and broke when unbound (fixed)

`measure` was an object method calling `this.record(...)`. The interface publishes `measure` as a plain function that callers legitimately pass around, but detaching it destroys the receiver:

```
const { measure } = createBenchProfiler();
await measure(call, invoke)
=> TypeError: undefined is not an object (evaluating 'this.record')
```

The failure lands *after* `await invoke()`, so a caller that composed the profiler by destructuring lost the measurement and got a rejected promise in exchange for a completed model call. Fixed by extracting a `recordCall` closure and having `measure` call it directly (`profiler.ts:242`, `profiler.ts:293`). Behaviour is unchanged for bound calls; unbound calls now record normally.

### 3. Completion-only usage was reported as `tokenSource: "reported"` while the prompt side was estimated (fixed)

The token-source classifier fired on `promptTokens` **or** `completionTokens`, but `promptTokens` carries the chars/4 estimate and `providerCacheHitRate` divides by it. A provider returning `{ completionTokens: 5 }` therefore tagged the sample `reported` while `promptTokens` was still a heuristic — exactly the "never mix silently with reported usage" guarantee the module header promises.

Fixed in `profiler.ts:249`: only a reported prompt count yields `tokenSource: "reported"`; a completion-only block stays `estimated` and is additionally flagged with `completionTokensReported: true` on `ProfileConditions` so the mixed case stays visible instead of being flattened.

### 4. `ProfileAggregate` omitted the `model` field it always carried (fixed)

`aggregate()` returned `model` and `summary().models` sorts by it, but the interface never declared it, so `typecheck` failed on both the implementation and `profiler.test.ts:138` — the H06.03 type surface did not compile. The plugin suite hid this because `bun test` strips types. Fixed by declaring `model: string` on `ProfileAggregate` (`profiler.ts:89`).

### 5. `baseline: null` (no defect — clarified, not changed)

Reviewing this branch I initially suspected `{ baseline: null }` was indistinguishable from an absent baseline. It is not: the guard tests `!== undefined`, so an explicit `null` reaches `coerceBenchRun`, returns `null`, and is rejected as `invalid_input` — verified by probe after the review. The only change made here is an explanatory comment at `index.ts:98` recording that `null` means "malformed", not "absent", so a later refactor does not collapse the two states. No behavioural fix was needed and none was made.

## Contract gap found and closed

The bench surface was not registered as a product feature. Per `AGENTS.md`, every user capability must be declared under a stable `<plugin>.<feature>` id with a Chinese `name` and an English `nameEn`, and the `xueness harness` CLI command must be declared in the plugin's own manifest. H06 had added a fifth RPC method and a fifth CLI action while `manifest.json` / `catalog/deepseek_harness.json` still declared seven features and `"tools": []` with no `commands` key — the bench capability would not appear in `设置 → 插件 → 已安装功能插件`, and the CLI action was not attributable to the plugin.

Fixed by adding `deepseek_harness.bench` ("确定性 bench 套件、指标档案与回归报告" / "Deterministic bench suite, metric profiling and regression reports") to both the manifest and the catalog, and declaring `"commands": ["harness"]` in the manifest.

## Verification

| Check | Result |
| --- | --- |
| `bun test` on the four H06 suites (`bench-runner`, `profiler`, `report`, `bench-cli`) | 51 pass / 0 fail |
| `bun test plugins/deepseek_harness` (whole plugin) | 227 pass / 0 fail |
| `bun scripts/check-max-lines.ts` | ok — 862 prod files, largest 399/400 |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 534 source files |
| `bun run typecheck` | 1145 errors, all pre-existing in untouched packages (`packages/sessions`, `apps/workflows`, …); the 2 H06 errors are gone (was 1147 before the fixes) |
| Post-fix probes | `iterations: 0` → failed result; detached `measure` → records; completion-only usage → `estimated` + `completionTokensReported`; `baseline: null` → `invalid_input`; plain bench run → `healthy: true` |

The residual 1145 typecheck errors were confirmed pre-existing by stashing the H06 fix set and re-running: the count is identical without these changes, and no remaining error names `src/bench/`, `bench-*.test.ts`, `profiler.test.ts` or `report.test.ts`.

## Notes for later rounds

- `bench/runner.ts` (H06.01, injected-tick model) and `bench/suite.ts` (H06.06, wall-clock model) remain two independent runners with two `BenchCase` types and two differently-shaped `BenchRunSummary` types (one exported as `BenchTimedRunSummary`). The aliasing in `src/index.ts:39` keeps them apart correctly, but a future round should either unify them or document why the tick-based and token-metric paths stay separate.
- `serializeRegressionReport` / `renderRegressionMarkdown` are not reachable from the CLI or RPC yet — the bench method returns the report object, and JSON/MD export is a library-only surface. Wiring an export flag would make the H06.05 deliverable usable from `xueness harness bench`.
