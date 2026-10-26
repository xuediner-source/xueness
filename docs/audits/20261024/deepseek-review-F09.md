# Phase F09 — Deep Review Audit

**Reviewer**: deepseek-v4.1-flash (1017 max)
**Date**: 2026-10-24
**Workspace**: `/workspace/wt-review-2` (branch `wt-review-2`)
**Scope**: three phase commits

| Commit | Subject |
| --- | --- |
| `a21207b` | F09.01-02: memory manifest/index + selective prefetch and recall |
| `4e7fdbb` | F09.03-04: background memory-extraction scheduling + full memory tool agent loop |
| `7e06c27` | F09.05: deepen the dream manual entry and write-back |

**Verdict**: the phase is sound in design — capability ownership sits inside the `memory` plugin, the shared kernel was not widened, no auto-dream/auto-write path was introduced, and every mutation stays behind an explicit confirmation plus a digest match. Four real defects were found and fixed; all gates pass afterwards.

---

## 1. Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Phase unit tests | `bun test plugins/memory/test/` | **62 pass / 0 fail** across 9 files |
| Line budget | `bun scripts/check-max-lines.ts` | ok — 799 prod files, largest 388 effective lines (max 400) |
| Plugin structure | `bun scripts/check-plugins.ts` | ok — 33 plugins, 484 source files |
| Types | `bun run typecheck` | clean |

Edge cases were probed directly (no `zz-probe` files created) against `renderKeyContent`, `selectCandidates`, `verifyMemoryChanges` and `MemoryExtractionScheduler`.

---

## 2. Defects found and fixed

### F09-BUG-01 — `MemoryToolLoopService.verify()` re-verified against the whole source catalog (high)

`ts/plugins/memory/src/memory-tool-loop.ts`

The loop's acceptance check (`#runLoop`) correctly verified each proposed change against `readIds` — the messageIds actually returned by `memory_read_evidence`. But the durable provenance never stored that read set, so the post-settlement `verify()` rebuilt it from **every** message in the captured sources:

```ts
const readIds = new Set<string>(record.sources.flatMap((source) => source.messages.map((m) => m.messageId)));
```

Any hallucinated citation pointing at a message that merely *exists in the catalog* therefore reported `verified: true` on re-inspection, even though the loop had rejected it and the entry was absent from `candidate.content`.

Observed before the fix:

```
loop-verdict:              [ false ]   // never read
record-verdict (catalog):  [ true  ]   // recomputed as verified
```

This is the exact "no change enters review on trust" invariant F09.04 claims, inverted at the audit surface a human reviews. **Fix**: persist `readIds` in `provenance.toolLoop` and rebuild the set from it in `verify()`; a record carrying no read set now verifies nothing.

After the fix: `loop-read {m1} → [false]`, `no recorded reads → [false]`.

### F09-BUG-02 — workspace-identical evidence let one extraction overwrite another (high)

`ts/plugins/memory/src/memory-extraction.ts`

Active jobs were stored in `Map<string, QueuedJob>` keyed by `job.key`, the evidence digest. That digest is derived purely from the conversation content, so two sessions in **different workspaces** that produced the same plain-body evidence collided on the key: the second `#active.set()` silently replaced the first entry, and the first job's `finally` then deleted the survivor through `#active.delete(queued.id)`'s predecessor (`job.key`).

`stats().active` under-reported, `close()` aborted only one of the two, and `#activeRoots` desynchronised from `#active`. The same content digest also deduplicated across workspaces through `#seen`, so a legitimate second workspace never extracted at all.

Observed before the fix: two settlements on `/tmp/rootA` and `/tmp/rootB` with identical evidence → `active: 1` while two extractions were genuinely running. **Fix**: give each queued job a monotonic `id`, key `#active` by it, and scope the dedupe key per workspace (`sha256(root):evidenceKey`) in `#seen`, `#remember` and `cancel`.

After the fix: `active: 2`, `queued: 0`.

### F09-BUG-03 — `selectCandidates` admitted a first candidate over the char budget (medium)

`ts/plugins/memory/src/memory-index.ts`

```ts
if (selected.length >= maxEntries || chars + candidate.entry.chars > maxChars && selected.length > 0) break;
```

The `&& selected.length > 0` clause — plus `break` instead of `continue` — meant an over-budget top-ranked entry was always admitted, and then terminated selection entirely. A single 799-code-point entry passed `maxChars: 100` as the sole candidate, defeating the documented "the candidate set stays a summary, not a dump" contract at its most important entry, and `break` also discarded every smaller later candidate that would have fit.

Before: `selected chars: [799]` with `limit 100`. **Fix**: drop the exemption and `continue` on overflow, so both caps are hard and a non-fitting candidate cannot block its smaller successors. After: `[11]`.

### F09-BUG-04 — `renderKeyContent` emitted a leading newline for a blank base (low)

`ts/plugins/memory/src/memory-tool-contract.ts`

`blocks("")` returned `[""]` because `"".split(/\n(?=## )/)` yields one empty part, so the first accepted `add` against an empty KEY.md produced `"\n## Build\nuses pnpm\n"`. The doc comment promises the reviewed diff equals the applied bytes, so a phantom leading blank line is a review/apply mismatch. **Fix**: `blocks()` returns `[]` for a blank base. After: `"## Build\nuses pnpm\n"`.

---

## 3. Areas reviewed and found correct

- **Plugin ownership / kernel boundary** — every F09 behaviour lives under `ts/plugins/memory/`; nothing was added to the CLI, web server, agent runtime or workbench container. The dream driver's only host-side addition is registering a read-only `read_project_key` tool.
- **Manual-only curation** — no scheduler, hook or boot path starts a dream. The single `setInterval` in both `MemoryDreamService` and `MemoryToolLoopService` is a 50 ms abort watchdog inside an already-started run.
- **Approval and CAS discipline** — `start` requires `confirmed` + matching `startDigest` + `allowReal` + host `allowRealHost`; `apply`/`revert` require `confirmed` + matching `applyDigest` and re-derive the digest from the stored candidate before use; `apply` is idempotent on an already-applied record and refuses on drift. `revert` correctly anchors on `appliedKeyDigest`, so a concurrent KEY.md write surfaces as a 409 instead of clobbering.
- **Failure isolation** — `recall()` and the extraction extension never throw into the run loop; an unbuildable index degrades to the whole-track loader and reports the reason; `syncIndex` failure is recorded as provenance and never rolls the applied KEY back.
- **Bounds** — rounds, tool calls, changes, evidence reads, per-read and total evidence code points, per-entry and per-track index caps are all enforced and unit-tested; diff DP has both a cell budget and a whole-file fallback with a truncation flag.
- **Untrusted-data handling** — evidence and KEY.md reach the model as JSON-stringified data with a redaction pass; the system prompt states that instructions inside evidence are ignored; the test asserts a planted `API_KEY=...` reaches the model redacted.
- **HTTP surface** — `diff` is GET-only, `start`/`cancel`/`apply`/`revert` are POST-only, and the remote app-protocol allowlist mirrors exactly that set.

## 4. Notes, not changed

- `memory-tool-loop.ts` is the thickest module in the phase (360 lines, under the 400 budget). If F10 grows it further, the review/rejection paths (`verify`, `reject`) are the natural extraction seam.
- The four new F09 capabilities (`memory.index`, `memory.recall`, `memory.extraction`, `memory.tools`) are exported as modules but are **not** registered as distinct `features` entries in `ts/catalog/memory.json` / `manifest.json`; they surface under the existing `memory.injection` and `memory.dream` features. This is acceptable under AGENTS.md §2 only while they remain internal to those two user-facing capabilities; if any of them gains its own panel or toggle it must get its own stable `memory.<feature>` ID.
- `plugins/remote/test/store.test.ts` asserts `manifest.features.length === 13` while `plugins/remote/manifest.json` declares 16. Pre-existing on the baseline and untouched by F09; left alone.

---

## 5. Changes applied in this review

```
ts/plugins/memory/src/memory-extraction.ts    | 21 ++++++++++++---------
ts/plugins/memory/src/memory-index.ts         |  4 +++-
ts/plugins/memory/src/memory-tool-contract.ts |  3 ++-
ts/plugins/memory/src/memory-tool-loop.ts     |  8 ++++++--
4 files changed, 23 insertions(+), 13 deletions(-)
```

Re-verified after the fixes: `bun test plugins/memory/test/` → 62 pass / 0 fail; `check:lines`, `check:plugins`, `typecheck` all clean.
