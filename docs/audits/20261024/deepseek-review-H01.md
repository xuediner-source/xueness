# Phase H01 Review — deepseek-v4.1-flash (1017 max)

**Scope:** commits `1c13a94` (H01.01–02 contracts + adapter), `a6290fd` (H01.03–04 prefix-cache + reasoning bridge), `8d30c1a` (H01.05–06 hot loader, registry, RPC/CLI entry) on `wt-review`.
**Reviewer:** deepseek-v4.1-flash (1017 max) via WorkBuddy.
**Verdict:** Two real defects and one contract gap found and fixed. Phase tests were green at HEAD (136 pass), so none of these were caught by the shipped suite — each fix is now covered by a test or a gate.

## Gate status after fixes

| Gate | Result |
| --- | --- |
| `bun test plugins/deepseek_harness` | **137 pass / 0 fail** (10 files) |
| `bun scripts/check-max-lines.ts` | ok — 851 prod files, largest `plugins/automation/src/off-peak-queue.ts` (399/400) |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 524 source files |
| `bun run typecheck` | 1146 errors, **none from `deepseek_harness` sources/tests** |

`bun run typecheck` is red at HEAD for reasons unrelated to H01: `packages/sessions` no longer exports `SessionStore`/`PyOSError`, which breaks `plugins/workflows`, plus ~1100 other pre-existing failures across the tree. Verified pre-existing: stashing every H01 edit leaves the count at 1147. Before the fix below, that same run also reported the one H01-owned error (`apps/server/src/bundled-plugins.ts: Cannot find module '@xueness/plugin-deepseek_harness'`); it is gone now. I did not touch the unrelated failures.

## Defect 1 — reasoning bridge loses `content: ""` on a full round trip (H01.04)

`roundTripOpenAI([{ role: "assistant", content: "" }])` returned `[{ role: "assistant", content: null }]`.

`openAIToAnthropic` only emitted a text block for non-empty content, so an empty assistant answer became a zero-block message, which was then padded with `{ type: "text", text: "" }`; on the way back, `anthropicToOpenAI` dropped zero-length text blocks and fell through to `content: null`. The module documents a lossless round trip, and the case is reachable: DeepSeek V4.1 returns `content: ""` alongside a non-empty `reasoning_content` on reasoning-only turns, which is exactly what this bridge converts. Downstream, `null` and `""` differ on the OpenAI wire (a `null` content with no tool calls is rejected by several OpenAI-compatible endpoints as a malformed assistant turn).

Note the failure is invisible to the existing suite because its own "reasoning-only" fixture is already `content: null`, so the collapse is idempotent for that shape.

**Fix** (`src/reasoning-bridge.ts`):
- `openAIToAnthropic` emits a text block for **any** string content, `""` included.
- `anthropicToOpenAI` tracks `sawText` separately from the joined text, so a single empty text block yields `content: ""` while a thinking-only turn still yields `content: null`.
- Doc comments on `toAnthropicMessages`/`toOpenAIMessages` now state the exact normalizations, including that `content: null` on a non-assistant turn normalizes to `""` (that wire shape has no null slot).

**Regression test:** `reasoning-bridge.test.ts` → *"keeps an empty assistant content string distinct from a missing one"*, asserting all three shapes: `""` alone, `""` next to reasoning, and `null` next to reasoning. All three round-trip byte-identically.

## Defect 2 — the plugin was never registered as a workspace package (H01.03–06)

`apps/server/src/bundled-plugins.ts` imports `@xueness/plugin-deepseek_harness`, but `package-lock.json` had no entry for it (`grep -c plugin-deepseek_harness` → 0 at HEAD), so the only H01 typecheck error was the unresolved import. Every other one of the 34 bundled plugins is present in the lockfile.

**Fix:** regenerated the lockfile (`npm install --package-lock-only --offline`), which now resolves `node_modules/@xueness/plugin-deepseek_harness` → `plugins/deepseek_harness` with `"link": true`. The H01 typecheck error is gone.

## Contract gap — registration did not match the phase's own work (H01.05–06)

`AGENTS.md` requires every plugin to register its actual `modules` and every user-facing capability in `features`. H01.05–06 shipped a hot loader, a contribution registry and an RPC/CLI entry, but:

- `catalog/deepseek_harness.json` and `manifest.json` declared only the two H01.03–04 features — the loader/registry feature had no catalog entry at all.
- Neither file declared `modules`, while 34 of 35 catalog files do (`grep -l '"modules"'` → 34/35; the 35th was this plugin).
- The in-code `package.json` is `0.2.1` while both manifests said `0.1.0`.

**Fix:** added `deepseek_harness.harness_loader` (中文 + `nameEn`) to both files, declared `modules: [contracts, adapter, prefix_cache, reasoning_bridge, loader, registry]`, and set both versions to `0.2.1`. `check:plugins` stays green.

I deliberately did **not** add `commands: ["harness"]`. `harnessCommand` in `src/index.ts` is a self-contained printing shell — nothing in `apps/` or `packages/` calls `createHarnessApi`/`harnessCommand`, so no `xueness harness` subcommand exists for a user to run. Registering it would advertise a capability that cannot be exercised; that wiring is H01.06's remaining work, not a catalog edit.

## Reviewed and found sound

- **Contracts / adapter (`1c13a94`).** Validation-before-mutation holds: `parseHarnessPackage` returns all issues at once, `HarnessAdapter.mount` pre-checks every contribution key before inserting, and `unmount` clears the index. Duplicate-key derivation is consistent between `contracts.ts` and `adapter.ts` (tool/verifier by name, hook by `event:handler`, skill/template by id). No code from a harness source is imported or evaluated anywhere.
- **Hot loader rollback (`8d30c1a`).** `loadHarness` validates fully before touching the target; `HarnessRegistry.mount` is atomic (restores `#owners` and `#mounts` on a mid-mount throw) and distinguishes `HarnessAlreadyMountedError` from a generic refusal, so the loader never rolls back a pre-existing mount. `readJsonSafe` refuses symlinks, non-regular files and >256 KiB manifests **before** parsing, and `readHarnessManifest` bounds each contribution list at 200.
- **Prefix cache (`a6290fd`).** `stablePrefix` sorts tools by name then canonical form, excludes volatile fields by construction, and appends one frame per turn so earlier turns stay a literal byte prefix. I checked the frame-boundary concern directly (a message whose content embeds a serialized follow-up frame): `JSON.stringify` escaping keeps the two prefixes distinct, so no collision. `record`/`metrics` are pure functions of the recorded sequence; FIFO eviction is capacity-bounded at 1.
- **RPC gate (`8d30c1a`).** `createHarnessApi` answers `disabled` for every method when the feature gate is off, and `unknown_method`/`invalid_input` are distinguished before any I/O.

## Left as-is (reported, not changed)

1. **`xueness harness` CLI is not reachable from the host CLI.** `harnessCommand` exists and is tested, but no entrypoint registers it (see above). Pre-existing gap for H01.06, outside a review fix.
2. **Adapter and loader validate manifests differently.** `contracts.ts` uses `ID = /^[a-z][a-z0-9_]{0,63}$/` and `NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/`; `loader.ts` uses `/^[a-z][a-z0-9_-]*$/` for ids and lowercase-only names with no length cap. A package accepted by `parseHarnessPackage` (e.g. `demo.ping` as a tool name, or a 3-digit version `1.2.0` vs `1.2`) can be refused by the loader. Not unified here: each module is self-consistent and the two are not used on the same input path (the adapter mounts in-memory packages, the loader reads files off disk), so changing either regex would be a contract decision for whoever unifies the two mount paths.
3. **`canonicalJson` throws `RangeError` on cyclic input** and renders `Date` as `{}`. Both are acceptable for a projection of JSON request bodies; noted for callers that pass non-JSON values.
4. **`readJsonSafe` has a TOCTOU window** between `lstatSync`/`statSync` and `readFileSync`. It is a local harness directory read behind the plugin's `fs.read` allowlist, so this is not a privilege boundary; closing it would need an `open`+`fstat` rewrite.
