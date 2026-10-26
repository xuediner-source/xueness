# Phase F12 Review — deepseek-v4.1-flash (1017 max)

**Scope:** commits `450fd38` (F12.01–02), `e2173df` (F12.03–04), `222aaec` (F12.05) on `wt-review-2`.
**Reviewer:** deepseek-v4.1-flash (1017 max) via WorkBuddy.
**Verdict:** Three real defects found and fixed. F12.05 was shipped with a broken test suite, a
red typecheck, lost exports and an unregistered plugin. Everything below is verified by test
runs, not inspection alone.

## Gate status after fixes

| Gate | Result |
| --- | --- |
| `bun scripts/check-max-lines.ts` | ok — 835 prod files, largest `plugins/automation/src/off-peak-queue.ts` (399/400) |
| `bun scripts/check-plugins.ts` | ok — 34 plugins, 508 source files |
| `bun run typecheck` | clean |
| Affected tests (`engine-tools`, `os_cua`, `network`, `subagents`, `web-search`, bundled catalog) | 406 pass / 5 skip / 1 fail |

The single remaining failure, `findEditMatch > matches a copied read line that contains a real
tab, then a visible \t escape`, is **pre-existing and unrelated to F12**: it fails identically
with all F12 commits stashed. It is reported, not "fixed over", and left to the phase that owns
`edit-matchers`.

## Defect 1 — F12.05 shipped with 4 failing tests and an inconsistent test fixture

`bun test plugins/subagents/test/channel-reply.test.ts` reported **35 pass / 4 fail** at HEAD,
while `F12.05-result.md` claims "3 pass / 0 fail". Three of the four were test-side, one was a
genuine source gap.

- **Fixture type erasure (3 failures).** `fixture()` typed `source` as a plain object literal, so
  `provider` widened to `string` and never matched `ChannelGroupInputSource`. The mutation table
  was also declared as one union signature and called with a single argument, so the config
  mutations were silently dropped — the "refuses changed bot/group authorization" case never
  mutated the config at all, and the `state` mutation was applied twice. The test asserted a
  behaviour it never exercised.
- **Contract mismatch in the anchor expectations.** The stale-input case assumed
  `inputId: "desktop-input"` (an id the Host does not know) would be refused, but
  `readChannelBinding` deliberately falls back to the latest eligible native input for unknown
  ids — that is the documented desktop-follow-up path. The test encoded the opposite of the
  source's intent for the same scenario it later asserts correctly.

Fixes: typed the fixture `source: ChannelGroupInputSource`; replaced the union mutation table
with `Array<(state, config) => void>` so each mutation reaches the right file; corrected the
anchor expectations to assert the fallback that the code actually promises (and, after restoring
the stale input, that the requested id anchors again).

## Defect 2 — replayed deliveries could attribute unrelated content to the request (source bug)

`replyToChannel` is idempotent per `(bot, task, input, tool call)`. The replay guard compared only
the stored `channelReplyRequestHash`. A record whose `contentParts` and `text` were rewritten
outside the send path — the exact shape of a corrupted or partially-migrated delivery record —
matched the hash and was replayed as a successful delivery of the requested text. Reported
`status: "sent"` for content that was never sent.

Fix: `sameReplyShape()` now also requires the stored parts' rendered text to equal the stored
`text`, so a record that disagrees with itself is an `idempotency conflict` rather than a receipt.
The new regression is covered by the existing conflict test.

## Defect 3 — F12.05 deleted exports and manifest entries belonging to earlier phases

`222aaec` removed, without mention in its result note:

- `export * from "./inheritance.ts"` from the subagents barrel. `typescript` went **red**:
  `inheritance.test.ts` could no longer resolve `clampModelSelection`, `INHERITED_SOURCE` and
  `inheritableParentMessages`, and the implicit-`any` fallout produced 22 errors. This is a
  regression against F08.01, not a new-phase decision.
- The `task_cancel` and `respond_to_coordinator` tool declarations from
  `plugins/subagents/manifest.json`. Both tools still exist and are still registered by
  `createSubagents`, so the manifest under-declared the plugin's real tool surface (AGENTS.md
  rule 2: the manifest must register the *actual* tools).

Fixes: restored the `inheritance.ts` export and both manifest tool entries. Typecheck is clean
and no F08 behaviour changed.

## Defect 4 — F12.03's `os_cua` plugin was never actually shipped

`ts/plugins/os_cua/` was added and `apps/server/src/bundled-plugins.ts` imports it, but:

- `ts/catalog/os_cua.json` did not exist, and
- `os_cua` was absent from `BUNDLED_PLUGIN_IDS`.

`loadCatalogManifests()` and `plugin-state.ts` iterate `BUNDLED_PLUGIN_IDS`, so `os_cua` had no
catalog row, no persisted-switch allowlist entry, and no row in
`设置 → 插件 → 已安装功能插件` — directly against AGENTS.md rule 6. The bundled catalog test only
compared the catalog against that same list, so both sides agreed on the omission and stayed
green. `tsc` did catch it (`Cannot find module '@xueness/plugin-os_cua'`), and that error was
committed as-is.

Fixes: added `ts/catalog/os_cua.json` (features mirroring the manifest's six `os_cua.*` ids,
`defaultEnabled: false`, `capabilities: ["filesystem-write"]` per the v1 catalog vocabulary) and
appended `"os_cua"` to `BUNDLED_PLUGIN_IDS`. `bun test apps/server/test/bundled-plugin-catalog.test.ts`
now covers it: the shipped-catalog equality test is what would have failed had only one side been
added.

## Reviewed and found correct

- **`repl.ts` persistence model.** Classic `vm` scripts keep top-level `const`/`let` in the shared
  lexical environment and yield the completion value; the async path rewrites bindings to context
  globals so persistence survives `await`. `reset` bumps the epoch and swaps the context, `dispose`
  drops all sessions and runs host cleanup hooks, the sync timeout and the promise-settlement timer
  both map to `tool_timeout`, and the session stays usable after either.
- **`browsers.ts`** — bounded browser/tab counts, `stale_reference` for dropped handles, downloads
  rejected after their reference is released.
- **`os_cua`** — closed action schemas (`unknown action field` refused), bounded coordinates and
  text, per-session grant ledger with TTL, evidence journal, and an explicit `unwiredAdapter`
  rather than a silent no-op.
- **`channel-mention.ts` / `channel-reply.ts` authorization boundary** — mention refs resolve only
  against trusted native nodes of the current task, historical inputs stay name candidates only,
  the binding is re-read after a directory lookup and compared by scope, and
  `needs_clarification` never sends anything.
- **`network/src/citations.ts` and `providers/src/web-search.ts`** — citations are derived from
  provider payloads with a `verified` flag, not synthesised.

## Files changed by this review

- `ts/packages/engine-tools/src/repl.ts` — cancelled first call reports its would-be identity
  instead of `unknown_session` (new `ReplSessions.peek`).
- `ts/packages/engine-tools/test/repl.test.ts` — regression for that path.
- `ts/plugins/subagents/src/channel-reply.ts` — self-consistent replay guard.
- `ts/plugins/subagents/src/index.ts` — restored `inheritance.ts` export.
- `ts/plugins/subagents/manifest.json` — restored `task_cancel` / `respond_to_coordinator`.
- `ts/plugins/subagents/test/channel-reply.test.ts` — typed fixture, working mutation table,
  corrected anchor expectations, type-clean throughout.
- `ts/packages/contracts/src/route-catalog.ts` — `os_cua` in `BUNDLED_PLUGIN_IDS`.
- `ts/catalog/os_cua.json` — new catalog row.
- `ts/catalog/subagents.json` — `reply_to_channel` tool, `subagents.channel_reply` feature,
  `channel_reply` / `channel_mention` modules.
