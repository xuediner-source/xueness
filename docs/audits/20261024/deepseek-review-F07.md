# F07 Phase Review — deepseek-v4.1-flash (1017 max)

Scope: the three phase commits (F07.01–F07.06) on branch `wt-review-2`.

| Commit | Task |
| --- | --- |
| `744a788` | F07.01 config layering / multi-root workspaces, F07.02 hook input & output protocol |
| `3230aad` | F07.05 plugin component packages & lifecycle, F07.06 plugin SDK & contribution contract |
| `d7e2f86` | F07.03 hook lifecycle & trust boundary, F07.04 multi-directory Skills & Commands |

Result: **one real defect found and fixed**. Everything else in the phase holds up.

## 1. Defect found and fixed

### Re-granting a workspace hook could never restore it after a configuration change

`ts/plugins/hooks/src/trust-write.ts` — `grantTrust`

F07.03 binds every trust record to the configuration revision it was reviewed
against (`configRevisionAtGrant`), and `admitted` only honors a record whose
revision equals the current one. That part was correct. The write side was not:
`grantTrust` deduplicated on `(workspace, digest)` and `continue`d on any match,
so a record that already existed kept its **old** revision forever.

Because the declaration digest covers only the hook's own declaration, editing
an *unrelated* hook in the same workspace changes the shared revision while the
first hook's digest stays identical. The typical user flow then breaks:

1. Grant hook A → trusted.
2. Add hook B to `.xueness/hooks.json` → revision changes → A and B are both `stale_trust`.
3. Re-grant (the UI lists both as pending) → B gets a fresh record, but A's
   existing record is skipped, so A stays pinned to the dead revision.
4. The workspace is left permanently in `pending_trust`/`stale_trust` with hook A
   never runnable — re-granting it is a no-op, and the only escape is to revoke
   and re-grant or delete the store by hand.

Verified with a direct probe of the public API before the fix: after
`grantTrust(state, ws, pending)` returned `ok`, `admitted()` still reported
`pending_trust` with hook `a` pending.

**Fix:** `existing` became a `Map<key, index>`. A record whose
`configRevisionAtGrant` already equals the current revision is left untouched; a
record bound to an earlier revision is replaced in place with a freshly stamped
record (`grantedAt` updated too, since this is a new review). This keeps the
F07.03 intent — old grants really do stop working — while making the explicit
re-grant action actually work. Re-stamping in place also keeps the store from
growing a duplicate row per review cycle. `MAX_TRUST_RECORDS` is now checked
against newly **added** rows only, so an in-place re-stamp can no longer fail a
store that is full.

Regression test added in `ts/plugins/hooks/test/hooks-lifecycle.test.ts`
("re-granting an already-recorded hook re-stamps it to the current revision"):
grants one hook, adds a second declaration, re-grants both and asserts the
resulting state is `trusted` with nothing pending.

## 2. Areas reviewed, no defect found

- **F07.03 trust boundary** (`lifecycle.ts`, `trust.ts`, `revision.ts`). The
  three hook families stay separated: user hooks always run, plugin hooks are
  gated by `hook-boundary.json` and rejected on a corrupt boundary, workspace
  hooks are never trusted by origin. Invalid plugin ids, unknown events and
  empty commands are refused into `plugin_hook_invalid`. `statusDocument` and
  `admitted` derive staleness identically, so the UI document and the runner
  cannot disagree. Legacy pre-F07.03 records without `configRevisionAtGrant`
  stay honored — deliberate and covered by a test.
- **F07.02 protocol** (`runner.ts`, `hooks-protocol.test.ts`). argv-only
  execution, private environment stripped, stdin JSON payload, timeout clamped
  by the cap, exit 0/2/other semantics, and the `subjects` matcher plumbing all
  match the documented contract. Failures are contained to exit `-1`.
- **F07.04 extra roots** (`skills/src/extra-roots.ts`,
  `commands/src/extra-roots.ts`). Both loaders are strict in the same way: exact
  key count, integer `schemaVersion`, symlinked store refused, byte and entry
  caps, duplicate detection on the resolved path, and every bad entry degraded
  to a diagnostic instead of a failed listing. Each root is its own jail and the
  jail is re-checked at read time. The shared diagnostics root (`base: ""`) is
  consumed and skipped by both `discover` functions without being mistaken for a
  real directory. Namespacing keeps collisions addressable as `ns:name` instead
  of silently overriding, and a namespaced command name that stops being valid
  is refused with a diagnostic rather than listed.
- **F07.01 layering** (`settings/src/layers.ts`). `LAYER_SCOPES` covers every
  layer, the override matrix orders by merge rank then pointer, and an MCP
  server's `source`/`overrides` split matches the documented "winner last"
  chain. `switchRoot` re-applies only the workspace layer.
- **F07.05/F07.06** (`components.ts`, `contribution.ts`). Component packages
  stay purely declarative (ids, descriptions, `alwaysLoad`), `BUILD_ONLY_FIELDS`
  blocks a marketplace package from mounting frontend or setting defaults, and
  `contributionIssues` composes manifest shape, SDK fields, self-dependency and
  the compatibility verdict. `compatVerdict` rejects non-positive/non-integer
  versions instead of coercing them.

## 3. Verification

```
bun test plugins/hooks/test/                                 27 pass, 0 fail
bun test plugins/{hooks,skills,commands,settings,extensions}  77 pass, 4 skip, 0 fail
bun scripts/check-max-lines.ts                               ok (799 prod files, max 400)
bun scripts/check-plugins.ts                                 ok (33 plugins, 484 source files)
bun run typecheck (tsc -p tsconfig.json)                     exit 0
```

The new regression test fails against the pre-fix `grantTrust` and passes after
it, so it guards the exact behaviour that was broken.
