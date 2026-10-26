# H08 Review — deepseek_harness × extensions/hooks E2E

**Reviewer:** deepseek-v4.1-flash (1017 max)
**Date:** 2026-10-24
**Scope:** `120e44c H08.01-02: deepseek_harness × extensions/hooks E2E`
**Files reviewed:** `ts/plugins/deepseek_harness/test/e2e-extensions.test.ts`, `ts/plugins/deepseek_harness/test/e2e-hooks.test.ts`, `H08.01-result.md`, `H08.02-result.md`

## Verdict

H08.01 is sound. H08.02 carried a **real contract gap**: the hooks E2E asserted a
harness→hooks path that did not exist in production. Fixed in this review.

## Findings

### F1 (real, fixed) — H08.02 tested a hand-wired bridge, not a production seam

`e2e-hooks.test.ts` claimed in its header that "the host maps that declaration
onto a hooks-plugin plugin contribution". It did not. The fixture built the
contribution itself:

```ts
const rows = [{ id: "auto-verify", event: "PostToolUse", command: process.execPath, ... }];
```

Grep across all production sources confirmed nothing consumed
`HarnessManifest.hooks` except the registry's contribution *counter*
(`registry.ts:68`) and the loader's validator. `registerPluginHooks` had **zero
production callers** — only tests. So a harness manifest could declare
`after_tool_execution` and nothing would ever run it; the E2E passed only
because the fixture hard-coded the endpoint. The acceptance criterion for H08.02
("hooks can trigger auto-verify/self-repair") was therefore unproven for real
manifests.

Also note the fixture wrote `event: "PostToolUse"` (the hooks-plugin spelling)
while the manifest declares `event: "after_tool_execution"` (the harness
spelling). The vocabulary translation the header described was missing too, and
the test never noticed because it never read the event from the manifest.

**Fix:** new `ts/plugins/deepseek_harness/src/hook-bridge.ts` (exported from
`src/index.ts`):

- `HARNESS_EVENT_MAP` translates harness snake_case events onto hooks-plugin
  `HookEvent` names. `before_tool_execution` is deliberately **not** mapped:
  `PreToolUse` is the only event whose exit code vetoes a call (`vetoOf` in
  `plugins/hooks/src/index.ts`), so a post-execution-style manifest name must not
  be able to obtain veto power by relabelling.
- `harnessHookRows` / `harnessHookMappings` / `harnessHookContribution` turn
  each mount's declarations into rows, preserving manifest order and generating
  stable ids `${event}:${handler}`.
- The manifest names only a `handler`; the **host** supplies the command via a
  `HarnessHookResolver`. A declaration the host cannot resolve yields no row and
  a structured `handler_unresolved` reason — never a silently dropped or
  defaulted command. A harness source therefore still cannot name the program it
  runs.
- The module returns **data**, not registrations. The plugin-gate forbids
  cross-plugin value imports (`MEDIATED` in `scripts/plugin-gate.ts`), so the
  host hands the contribution to `registerPluginHooks`. Admission stays entirely
  with the F07.03 boundary; the bridge never marks a row trusted.

`e2e-hooks.test.ts` now drives the real bridge (`harnessHookContribution(api.registry, resolveHandler)`),
so the test would fail if the bridge regressed. Added an assertion case covering
the two properties the old fixture hid: a manifest declaration produces a row
with the *host's* command, an unresolvable handler produces no runnable row, and
`before_tool_execution` stays unmapped.

Type detail: `HarnessHookRow` extends `Record<string, unknown>` so the rows are
assignable to the hooks plugin's `Row` without a cast — the host can call
`registerPluginHooks` directly with the bridge output.

### F2 (environment, not H08) — both new test files could not even load

First run of the new files failed before executing any test:

```
SyntaxError: Export named 'isFile' not found in module '.../plugins/sessions/src/index.ts'
SyntaxError: Export named 'DEFERRED_TOOL_CALL' not found in module '.../plugins/providers/src/index.ts'
```

Root cause was the worktree's `node_modules/@xueness` links: `sessions` and
`providers` pointed at `ts/plugins/*` (packages named `@xueness/plugin-*`)
instead of `ts/packages/*` (the real `@xueness/sessions`, `@xueness/providers`),
and `@xueness/plugin-os_cua` was missing (which also broke `typecheck`). The
H08 result docs report "15 pass" against a state where none of this was true in
this checkout. Not an H08 code defect — no test or source change needed — but
the reported results were not reproducible from this worktree as delivered.
Links repaired locally; not committed (they are build artifacts, not sources).

### F3 (minor, no change) — `H08.01` "not_a_directory" relies on the resource route's file naming

`e2e-extensions.test.ts` loads `<resources>/plugins/critic-solver-market.json`
to prove data manifests are refused as harness sources. The file exists only
because `resourceDispatch`'s `itemPath` writes `<id>.json`. That is correct
today and the assert is on the error `code`, not a message, so it is a fair
contract test. Noted only so a future rename of the resource store doesn't make
this assertion vacuous.

## Checks that were already good

- H08.01's atomicity assertions are meaningful: a refused rival mount checks
  `registry.size` is unchanged *and* that the original owner still owns
  `tools:critique`.
- The symlink and `sdkApiVersion` refusals assert the structured `issues` path
  (`/sdkApiVersion`), not just the error code.
- `contributionIssues` is exercised in both directions (clean listing accepted,
  `features` grab refused), so the data-only rule is proven on the extensions
  side too.
- The self-repair assertions cover all three terminal states across the file
  (`passed`, `gave_up`, and the bounded `exhausted` path elsewhere in H02.02).

## Verification

| Command | Result |
| --- | --- |
| `bun test plugins/deepseek_harness/test/e2e-extensions.test.ts plugins/deepseek_harness/test/e2e-hooks.test.ts` | **16 pass, 0 fail** (was 15; +1 for the new bridge case) |
| `bun test plugins/deepseek_harness/test/` | **283 pass, 0 fail** over 23 files |
| `bun scripts/check-max-lines.ts` | ok — 869 prod files, largest 399/400 |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 539 source files |
| `bun run typecheck` | clean |

Note: the two failures reported originally came from the broken workspace links
(F2), and the numbers in `H08.01-result.md` / `H08.02-result.md` ("2059 pass /
36 fail", "14 pre-existing typecheck errors") could not be reproduced here —
after repairing the links, `typecheck` is clean, so those pre-existing errors
were also link artifacts rather than real type errors.

## Residual risk

The bridge is complete but **not yet wired into a live host**: no production
entry point builds a `HarnessRegistry`, then a `HooksBinding`, then calls
`registerPluginHooks`. That composition belongs to whichever round owns host
boot (`apps/server/src/bundled-plugins.ts` currently only imports
`deepseekHarness`). Until that round lands, H08.02's acceptance is proven at the
module seam — manifest in, hooks-plugin rows out, boundary admits/refuses — but
not yet at a running server. Flagging rather than inventing a boot wiring inside
the harness plugin, which would violate the shared-kernel boundary in
`AGENTS.md`.
