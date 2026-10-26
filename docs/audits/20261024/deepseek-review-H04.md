# Phase H04 Review — deepseek-v4.1-flash (1017 max)

Date: 2026-10-24
Worktree: `/workspace/wt-review-3`
Reviewer model: deepseek-v4.1-flash (1017 high)

## Scope

Phase H04 commits (all under `ts/plugins/deepseek_harness/`):

| Commit | Items | Files |
| --- | --- | --- |
| `92d10fe` | H04.01-02 | `src/compat/swe-bench-harness.ts`, `test/swe-bench-harness.test.ts` |
| `bfc28d6` | H04.03-04 | `src/compat/rule-pack-importer.ts`, `test/rule-pack-importer.test.ts` |
| `bcd4983` | H04.05-06 | `src/compat/sandbox-verifier.ts`, `test/sandbox-verifier.test.ts` |

All three modules are exported through `src/index.ts`. No H04 change touched
the CLI, the web server, the agent kernel or the workbench container, so the
plugin-ownership rule of `AGENTS.md` holds: the work stays inside the
`deepseek_harness` bundled plugin and nothing outside it implements a feature.

## Verdict

**Accepted with fixes applied.** Three real defects were found and corrected;
no contract violation of the H01 "zero glue" rule (nothing from an imported
source is ever evaluated or executed) was found in the importers.

## Defects found and fixed

### 1. Sandbox cloned itself recursively when its root sits inside the source (H04.05)

`sandboxRoot` defaults to `<cwd>/.sandboxes`, i.e. *inside* the workspace being
cloned. The clone loop skipped that entry with
`join(source, path) === root` — a comparison between a `node:path.join` result
and an un-normalized root string. It never matched (and on Windows is always
false because `list` returns `/`-separated paths), so the sandbox copied its
own growing subtree into itself. With the default `kind: "worktree"` and no
explicit `sandboxRoot`, the first `verify()` could recurse until the disk or
the path limit stopped it.

Fixed in `sandbox-verifier.ts` by normalizing the root's offset inside the
source once (`rootWithinSource`) and excluding that prefix and everything under
it from `clone`, `snapshot` and `rollback`.

### 2. Rollback did not restore files a gate deleted (H04.05)

`rollback` only rewrote snapshot files that still existed
(`current.has(path) && content differs`). A gate that deleted a tracked file
left the sandbox permanently missing it, so the reported rollback was partial
while `rolledBack: true` claimed a full restore. Rollback now writes snapshot
content back whenever the file is absent *or* rewritten, which is what
"roll back to the pre-gate snapshot" means. The source workspace was never at
risk (gates run in the clone), but diagnostics and any post-failure inspection
were wrong.

### 3. `verify { sandbox: true }` bypassed the plugin feature gate (H04.06)

`withSandboxedVerify` routed `deepseek_harness/verify` straight to
`verifier.verify()` and never consulted the wrapped `HarnessApi`. A dispatcher
calling it while `deepseek_harness` was disabled (or while a dependency was
unavailable) still started a directory clone, spawned gate subprocesses and, for
`kind: "container"`, launched `docker run`. That contradicts the rule that a
disabled plugin must not start requests, polls, subprocesses or new tasks — the
sandbox path was the one arm of `verify` that skipped `enabledNow()`.

Fixed by pre-flighting the wrapped API with `deepseek_harness/list`, which
answers the gate state without side effects, and returning its refusal
(`disabled`, `unknown_method`) verbatim before any clone or spawn. The result
row now also carries `keptRoot`, which callers need to find a retained sandbox
under the default `keep: "onFailure"`.

### 4. SWE-bench instances with an empty FAIL_TO_PASS resolved vacuously (H04.02)

`evaluateSweBenchRun` used `every()` over both lists, so a task whose
`FAIL_TO_PASS` is empty — legal input, and produced by the importer when the
key is missing or `[]` — resolved as soon as `PASS_TO_PASS` passed, with no
evidence that any bug was fixed. Such records inflate both the exported
`resolved` flag and `summarizeSweBenchEvaluations().resolutionRate`, which is
the headline number of the export. Resolution now requires a non-empty
FAIL_TO_PASS set whose every entry passed, plus no PASS_TO_PASS regression.

## Reviewed and found correct

- **Importer isolation (H04.03/04).** `readTextSafe` refuses symlinks before
  parsing, bounds each file by `MAX_MANIFEST_BYTES`, and the dot-file path goes
  through `parseHarnessManifest` like any other manifest, so no source can
  introduce executable content. Converted ids are slugified and letter-first
  (`packId`), matching the loader's `/^[a-z][a-z0-9_-]*$/` for harness ids;
  skill and template ids are validated only as non-empty by the loader, which
  the slugified output satisfies.
- **All-or-nothing import.** `mountAll` records what landed and unmounts in
  reverse order of success on any refusal, so a partially converted pack never
  survives.
- **JSONL tolerance.** CRLF, blank lines and a single trailing newline are
  handled; per-line failures are reported with 1-based line numbers instead of
  aborting, and duplicate `instance_id` values are skipped rather than silently
  overwriting.
- **Determinism.** `exportSweBenchEvaluations` goes through `canonicalJson`, so
  equal evaluations serialize to identical bytes; `summarizeSweBenchEvaluations`
  returns `0` (not `NaN`) for an empty set.
- **Container wrapping.** `containerCommand` mounts the sandbox root at
  `workdir` and sets `-w`, so gates cannot escape to the host tree.

## Verification

```
bun test plugins/deepseek_harness/test/swe-bench-harness.test.ts \
         plugins/deepseek_harness/test/rule-pack-importer.test.ts \
         plugins/deepseek_harness/test/sandbox-verifier.test.ts
# 49 pass, 0 fail (was 45; 4 regression tests added)

bun scripts/check-max-lines.ts   # ok: 851 prod files, largest 399/400
bun scripts/check-plugins.ts     # ok: 35 plugins, 524 source files
bun run typecheck                # 1147 pre-existing errors, identical count at HEAD
```

`bun run typecheck` reports 1147 errors both with and without these changes, so
none are introduced here. The H04 compat modules typecheck clean in isolation
(`tsc --noEmit --strict` over the three files). The repo-wide errors are
unrelated to this phase — chiefly `plugins/workflows` importing removed
`@xueness/sessions` exports and `apps/server/src/bundled-plugins.ts` not
resolving `@xueness/plugin-deepseek_harness` — and are out of H04 scope.

## Test coverage added

- `sandbox-verifier.test.ts`: nested-root clone does not copy the sandbox
  subtree; a deleted snapshot file is restored by rollback; a disabled feature
  gate refuses `{ sandbox: true }` without creating a sandbox and still works
  once re-enabled.
- `swe-bench-harness.test.ts`: an empty FAIL_TO_PASS list never resolves and
  contributes 0 to the resolution rate.
