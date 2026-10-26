# H09 Review — Tournament runner (bracket / match runner / scoring / CLI)

Reviewer: deepseek-v4.1-flash (1017 max)
Branch: `wt-review` · Phase commits: `09d09a8` (H09.01-02), `95ebab3` (H09.03-04)
Scope: `ts/plugins/deepseek_harness/src/tournament/{bracket,match-runner,scoring}.ts`,
`src/index.ts` (RPC + CLI wiring), matching tests.

## Verdict

Phase H09 is a solid, genuinely pure-computation layer: no clock, no randomness,
positional match ids, byte-stable JSON, and the shared H01 `PrefixCache` is reused
rather than re-implemented. Three real defects were found and fixed in this review.
All 48 phase tests pass after the fixes (`bracket`, `match-runner`, `scoring`,
`tournament-cli`).

## Findings and fixes

### 1. `bracketRanking` could rank the runner-up above the champion (fixed)

`bracketRanking` ranked models purely by "deepest round in which the model appears
as a player", then by seed. A finalist's appearance is identical whether it won or
lost the final, so the champion and the runner-up always tie on depth and the seed
tie-break decides — which is wrong whenever the champion is the worse seed (the
normal case for an upset).

Observed before the fix, 4 models, `d` (seed 4) beats `a` then wins the final:

```
champion: d
ranking : [ "b", "d", "a", "c" ]   // runner-up "b" ranked first
```

Fix (`bracket.ts`): the champion is credited one extra round survived past the
final, so it always sorts first; all other relative depths are unchanged.
Regression test: "bracketRanking puts the champion first even when it is the worse seed".

### 2. A stalled match was replayed on every round (fixed)

`runTournament` looped `while (readyMatches(...))` and only counted *decided*
matches toward the loop condition. A `double_forfeit` match stays `ready` forever
(its branch cannot advance), so while a sibling branch kept advancing, the stalled
match was re-run each round. With `a`/`d` failing and `b`/`c` playing, the log was:

```
[ "r0m0:double_forfeit", "r0m1:scored", "r0m0:double_forfeit" ]   // r0m0 logged twice
```

This duplicated log entries, re-ran the task's work, and inflated per-model
`cacheMetrics.requests` for failed sides.

Fix (`match-runner.ts`): an `attempted` set of match ids, filtered out of
`readyMatches`, so each match is attempted at most once per run; the loop also
terminates as soon as a round produces no advance. Doc comment updated to state the
one-log-entry-per-match contract.
Regression test: "logs a stalled match once instead of replaying it every round".

### 3. RPC tuning numbers were accepted without validation (fixed, and a typecheck break)

`dispatchTournament` copied `kFactor` / `initialRating` / `ratingDecimals` from the
untrusted `Row` straight into `ScoringOptions` (`Record<string, unknown>` members).
Beyond the `bun run typecheck` failure this caused
(`TS2322: Type '{} | null' is not assignable to type 'number | undefined'`), the
values reach `scoreTournament` as `unknown`: a string `kFactor` would silently
become a broken rating instead of a clean rejection.

Fix (`index.ts`): each field is type-checked up front and rejected with
`invalid_input` before the run starts, so the RPC returns a stable error contract
like its `models` / `turns` siblings.

### 4. `bracket.ts` header overstated bye placement (doc only)

The header claimed byes "always fall to the better (lower-numbered) seeds". The
`seedOrder` construction spreads `null` slots across the opening round, so for e.g.
5 models the byes sit with seeds 1, 2 and 3 — which is a consequence of the pairing,
not a guaranteed property of the layout. Reworded to describe the actual
construction (extremes paired, leftovers become byes on both sides).

## Checked and found sound

- `recordResult` purity: returns a deep clone, rejects unknown / non-ready / already
  decided matches and non-player winners; replay is byte-identical.
- Byes resolve at build time and cascade through `settleReadyState`; `bracketComplete`
  /`bracketChampion` are consistent with the played state.
- `runMatch` isolation: per-side `{ ok, score }`, non-finite scores rejected,
  forfeit and double-forfeit outcomes, strict tie goes to slot 0 (deterministic).
- `scoreTournament`: symmetric Elo-lite updates, quantization per update, forfeit
  counted as a full win, `double_forfeit` skipped and counted in `matchesSkipped`,
  total order in standings, throws on unknown model / bad winner.
- CLI: `tournament <models-csv> [turns]` maps a stalled bracket to exit code 1 and a
  rejected payload to exit code 2; usage string updated.
- Per-match session key `<matchId>/<model>` on the shared cache is collision-free.

## Gates

| Gate | Result |
| --- | --- |
| `bun test` (bracket, match-runner, scoring, tournament-cli) | 48 pass, 0 fail |
| `bun scripts/check-max-lines.ts` | ok — 876 prod files, largest 399 effective lines |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 544 source files |
| `bun run typecheck` | no H09 errors; remaining errors are pre-existing in `optimizer/fitness.ts` (H10 scope, not touched here) |

## Suggested follow-up (not changed)

H09 features are not registered in `ts/plugins/deepseek_harness/manifest.json` or
`ts/catalog/deepseek_harness.json` `features`: the catalogue still ends at
`deepseek_harness.bench`, and `deepseek_harness/tournament` is an RPC/CLI method
only. Per the project's plugin rules, the tournament capability should be registered
as e.g. `deepseek_harness.tournament` (中文/English name pair) before H09 is treated
as shipped in the feature panel. Recommend doing this together with the same gap in
H10's optimizer rather than twice.
