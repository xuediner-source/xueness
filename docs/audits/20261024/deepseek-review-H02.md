# Phase H02 Review — deepseek_harness builtins

- **Reviewer model:** deepseek-v4.1-flash (1017 high), max reasoning effort
- **Scope:** phase H02 commits `bd09336` (H02.01-02) and `b1b39e5` (H02.05-06)
- **Date:** 2026-10-24

## Commits under review

| Commit | Rounds | Files |
| --- | --- | --- |
| `bd09336` | H02.01-02 | `auto-verify.ts`, `self-repair.ts`, `auto-verify.test.ts` |
| `b1b39e5` | H02.05-06 | `critic-solver.ts`, `trajectory-recorder.ts`, `critic-solver.test.ts` |

H02.03-04 (`repo-map.ts`, `symbol-graph.ts`) were not part of the reviewed commits and
are out of scope here.

## Baseline

Phase unit tests passed before review (36/36 across the two test files), and both
`check:plugins` and `check:lines` were green. The defects below are therefore
correctness gaps that the existing tests did not cover, not build breakage.

## Findings and fixes

### 1. `extractJson` mis-parsed escaped quotes — HIGH (fixed)

`critic-solver.ts` scanned **backwards** from each `}` to find the opening `{`, tracking
string state in reverse. Reverse scanning cannot distinguish an escaped quote from a
delimiter by looking at the preceding character alone, so any payload containing `\"`
followed by a brace lost balance and returned `null`.

Reproduced before the fix (both returned `null` despite being valid JSON payloads):

- `{"path":"a.ts","content":"s = \"a\\\"}\";","summary":"s"}`
- `{"verdict":"reject","reasons":["say \"}\""]}`

Impact was real: a Solver patch containing an escaped quote next to a brace was treated
as unparseable, and a Critic reply quoting a brace was degraded to a malformed rejection,
silently forcing extra rounds or a false rejection.

**Fix:** replaced the backward scan with a forward, string-aware scanner that records
every balanced top-level object and tries candidates last-to-first. Braces inside string
literals no longer affect depth, and `\\"` (escaped backslash) is correctly read as a
closing quote. Verified on five edge cases (unbalanced `{` in string, escaped quote
before brace, escaped backslash before quote, prose braces before payload, critic reason
with `}`), all now parse correctly.

### 2. `compressOutput` split multi-byte UTF-8 — MEDIUM (fixed)

The byte cap sliced a `Buffer` at `maxBytes - 64` and decoded, which can land inside a
multi-byte code point. CJK diagnostics produced a replacement character (`U+FFFD`) in the
middle of a line.

Reproduced before the fix: a CJK log compressed to `maxBytes: 300` ended
`…行7：中�\n… truncated 13252 bytes …`.

This matters because compressed diagnostics are fed straight into the self-repair prompt;
a torn character corrupts the signal the model repairs from.

**Fix:** the budget is now consumed character-by-character using `Buffer.byteLength` per
code point, then snapped back to the last newline, so output is always valid UTF-8 and the
marker still reports the true dropped byte count. Verified: no `U+FFFD`, output ≤ cap.

### 3. `runCriticSolver` reported `exhausted: false` on a malformed final review — MEDIUM (fixed)

`exhausted` was computed as `last?.malformed !== true`. Reaching the fall-through return
means the round budget was fully spent without an acceptance, so a malformed final review
reported `exhausted: false` — indistinguishable from a clean, non-exhausted rejection and
contradicting the field's documented meaning (“the round budget ran out before an
acceptance”). Any caller driving retry policy off `exhausted` would under-retry exactly
when the critic was failing to produce parseable output.

**Fix:** the fall-through now returns `exhausted: true`. Rejections and malformed reviews
both correctly report an exhausted budget; the distinction remains visible per round via
`review.malformed`.

### 4. Manifest/catalog registration did not cover H02 — MEDIUM (fixed)

`AGENTS.md` requires every user capability to be registered in `features` with a stable
`<plugin>.<feature>` id plus Chinese `name` and English `nameEn`, and requires `modules`
to list the actual shipped modules. Both `manifest.json` and `ts/catalog/deepseek_harness.json`
only declared the two H01 features and no `modules` at all, so H02's five capabilities
were invisible in the plugin panel and the catalog row understated what the plugin does.

**Fix:** declared `modules` (`builtins/auto-verify`, `self-repair`, `critic-solver`,
`trajectory-recorder`, `repo-map`, `symbol-graph`) and added five features to **both**
the manifest and the catalog: `auto_verify`, `self_repair`, `critic_solver`, `trajectory`,
`repo_map`. The catalog is what the plugin manager serves, so the two must agree.

### 5. Manifest description contradicted H02's declared capability — LOW (fixed)

The description claimed “Pure computation; no network, file or process access”, while the
manifest already declares `exec: ["*"]` and `fs.read: [workspace, state]`, which
`spawnGateRunner` and the trajectory file sink actually use. The stale text would
misrepresent the plugin's powers in the settings UI.

**Fix:** description now states the gate/repair features run configured commands under the
declared `exec` capability.

## Regression tests added

- `critic-solver.test.ts` — string-embedded braces and escaped quotes do not break
  extraction (three payload shapes plus a critic reason containing `}`).
- `critic-solver.test.ts` — a malformed final critic review still reports `exhausted: true`.
- `auto-verify.test.ts` — truncation stays on character boundaries with no `U+FFFD` and
  respects the byte cap.

## Verification

| Check | Result |
| --- | --- |
| `bun test` phase files | **39 pass, 0 fail** (was 36; +3 regressions) |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 524 source files |
| `bun scripts/check-max-lines.ts` | ok — largest 399/400 effective lines |
| `bun run typecheck` | **1146 errors, all pre-existing** |

The typecheck failures are confined to `plugins/workflows` and `plugins/sessions`
(missing `@xueness/sessions` exports such as `lockFileSync`, `SessionStore`, `isFile`) and
the pre-existing unresolved `@xueness/plugin-deepseek_harness` module path in
`apps/server/src/bundled-plugins.ts`. None originate in H02 files. I confirmed the count
is identical (1146) with my changes stashed, so this review neither introduced nor masked
any of them; they belong to an unrelated workstream and were left untouched.

## Notes / not changed

- H02.03-04 (`repo-map.ts`, `symbol-graph.ts`) predate the reviewed commits; they are now
  registered in `modules`/`features` for consistency but were not otherwise reviewed here.
- `runSelfRepairLoop`'s trailing `return` after the `for` loop is unreachable but harmless
  and keeps the function total for the compiler; left as-is.
