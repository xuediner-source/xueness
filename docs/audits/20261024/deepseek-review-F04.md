# DeepSeek (`deepseek-v4.1-flash 1017 max`) Code & Contract Review Report: Phase `F04` (`F04.01`–`F04.06`)

- **Review Scope**: Commits `1f49079`, `1a3c6d1`, `1e1a8bb` (F04.01-02 / F04.03-04 / F04.05-06), covering contracts `C-SES-01` through `C-SES-07`
- **Review Time**: 2026-10-25 (UTC+8)
- **Reviewer**: WorkBuddy (`deepseek-v4.1-flash 1017 max`)
- **Tree**: `wt-review` @ `d7e2f86` + the two fixes written by this review

---

## 1. Executive Summary

Phase `F04` delivers the session-storage foundation:

- **`C-SES-01` (`F04.01`)**: `ts/packages/sessions/src/message-model.ts` — one typed projection over journal rows (`decodeJournalMessage`, `encodeJournalMessage`, `visiblePayload`, `decodeSessionMessages`, `roundTrips`, `canonicalSessionDigest`) with lossless round trip, duplicate-identity rejection and private-metadata separation.
- **`C-SES-02` (`F04.02`)**: `ts/packages/sessions/src/sqlite-store.ts` — `SqliteSessionStore` (one `session` row + indexed `session_message` projection, single `begin immediate … commit` per operation, `onChanged` published strictly after commit), `migrateJsonJournals`, `verifyJsonMigration`, `openStartupSessionStore`.
- **`C-SES-03` (`F04.03`)**: `runtime-event-index.ts` + rewritten `runtime-event-log.ts` (persisted byte offsets, checkpoint-assisted snapshots, `#fullScans` counter) and `packages/contracts/src/runtime-retention.ts` (`RuntimeEventHotWindow`, transient-delta expiry, `ModelRequest` slimming).
- **`C-SES-04` (`F04.04`)**: `lineage.ts` (`applyCanonicalIntent`, `LineageSidecar`, `recordLineageRow`), `commandId` envelopes on fork (`forking.ts`), rewind (`rewind.ts`) and edit-retry (`message-actions.ts`), plus `GET /api/sessions/:id/lineage`.
- **`C-SES-05` (`F04.05`)**: `ts/plugins/files/src/file-rewind.ts` — compare-and-swap file restore with compensating rollback and a bounded `file_rewind_history` trace.
- **`C-SES-06` / `C-SES-07` (`F04.06`)**: compaction recovery and `repairSessions` (schema defaults, root relocation, history-cursor resync) in `session-storage.ts`.

All 51 phase tests pass on the untouched tree (`bun test` over the seven F04 test files). Reading the modified sources against the contracts surfaced **two real defects** — one High (permanent lockout of the canonical history intents), one Medium (rollback asymmetry in file rewind) — and **one unremediated contract gap** (C-SES-02's primary store is never wired into production). Both defects are fixed in this review, with regressions.

| ID | Severity | File | Real bug |
| --- | --- | --- | --- |
| `F04-BUG-01` | **High** | `ts/plugins/sessions/src/lineage.ts:84-96` | The lineage command window never retired claims: after 256 canonical history commands every `fork` / `rewind` / `edit_retry` on that session was permanently rejected with `command_capacity`. `LineageSidecar` validated a `retiredBefore` field it never wrote or honoured. |
| `F04-BUG-02` | **Medium** | `ts/plugins/files/src/file-rewind.ts:59-82` | The compensating rollback unconditionally deleted `session.file_rewind_last`, so a *failed* second rewind erased the marker of the *previously applied* rewind while `file_rewind_history` was correctly restored. |
| `F04-GAP-01` | **Medium** | `ts/packages/sessions/src/sqlite-store.ts:402` | Reported, not fixed: the C-SES-02 "primary transactional store" has no production caller. `createSessionsStore` still builds the JSON journal store as primary and SQLite remains a post-publication mirror. |

---

## 2. Verified Correct (no change required)

| Area | Verification |
| --- | --- |
| Lossless canonical model (`C-SES-01`) | `decodeJournalMessage` → `encodeJournalMessage` re-emits every consumed key and every leftover key from `meta`; `roundTrips`/`canonicalSessionDigest` back the store and migration checks. Media-group markers are re-split only after `pyJsonLoads` proves the block is intact, so a torn marker is refused rather than silently truncated. |
| Duplicate identities | `decodeSessionMessages` rejects duplicate `_message_id` and duplicate tool-call ids; `writeSessionRow` runs `sessionFingerprint` (hence the decode) before any SQL, and the `(session_id, message_id)` primary key is a second backstop. |
| Transaction / publish-after-persist (`C-SES-02`) | `withDatabase` wraps every operation in `begin immediate … commit` with a `rollback` on error; `save()` publishes `onChanged` only after the transaction returns; `update()` settles `published` inside the callback so a no-op mutation never publishes. Schema is checksum-guarded and refuses unknown/newer layouts. |
| Migration resumability | `migrateJsonJournals` commits one session per transaction and records `(session_id, digest, message_count, attachment_count)`; a rerun skips digest-matching rows. JSON journals are opened read-only, so fallback stays available. |
| Event paging (`C-SES-03`) | `readEventSlice` seeks `headerEnd`/`offsets` and validates every line's `sessionId` + expected `sequenceNumber`; `loadEventIndex` re-validates signature, monotonic offsets, `offsets[0] > headerEnd`, `offsets.at(-1) <= fileSize` and checkpoint/projection agreement, else falls back to one rebuild. `readPage` rejects an unknown epoch and an ahead-of-head cursor, and clamps the page to `head` so `hasMore` is truthful. |
| Hot window | Retention is memory-only: `#evict` drops whole turns, expires transient deltas after the grace period and slims `ModelRequest` payloads; `covers()`/`tail()` return `null` on a gap instead of a silently short tail, and the ledger is never truncated. |
| Canonical intents (`C-SES-04`) | Claims are durable before execution, replays return the recorded acknowledgement, a reused `commandId` with a different payload is `command_id_conflict`, and a claim crashing between claim and settle answers 503 `command_unknown` and is never re-run — all three paths covered by `lineage.test.ts`. Non-envelope rewinds keep the direct semantics, and edit-retry lineage is only recorded under an envelope. |
| Fork isolation | `makeFork` re-issues `_message_id`, remaps every tool-call id, copies only `results` reachable from copied calls, rejects partial tool pairs and pending approvals, and adopts media per message owner after re-verifying each reference. |
| Rewind pruning | `pruneSuffix` filters `results`, annotations, reasoning/completion/stream histories, interrupt transcripts, edit history, `input_context`/`input_attachments` and marks removed background tasks `branch_removed`; the cut is recorded with a monotonic `generation`. |
| File rewind (`C-SES-05`) | CAS restore (`restoreFileChecked`) compares exists+hash before every write, each restored file is re-hashed and verified, repeated edits to one path collapse to first-before/last-after, and the trace is bounded to 64 entries. |
| Repair (`C-SES-07`) | `repairSessions` only rewrites through `store.save` (so the hash chain continues), never touches queue/media/credentials, reports `unrepairable` with a reason instead of mutating, and honours `dryRun`. |

---

## 3. Fix Details

### `F04-BUG-01` (High): the lineage command window could permanently lock a session out

`LineageSidecar.readRecord` accepted and validated `retiredBefore` (`lineage.ts:28-30`), but `applyCanonicalIntent` never used it — it counted `record.commands.length` against `MAX_LINEAGE_COMMANDS` (256) and returned `command_capacity` when full. Nothing ever removed a claim. The sibling `CommandReceipts` path (`command-http.ts:70-73`) retires by `RETENTION_MS`, so the two durable command windows disagreed on lifetime.

Failure scenario: a session accumulates 256 canonical history commands (forks, rewinds, edit retries — plausible in a long-lived branchy session, and reachable deliberately). From then on every `POST /api/sessions/:id/rewind` with a `commandId` and every `POST /api/sessions/:id/fork` with a `commandId` answers `reasonCode: "command_capacity"` forever, with no recovery path short of deleting the sidecar. The contract (`F04.04-result.md` §17) promises exactly-once replay, not permanent refusal.

Fix in `applyCanonicalIntent`:

- Compute `floor = max(record.retiredBefore ?? 0, Date.now() - RETENTION_MS)` and reject a submitted `commandId` whose embedded epoch is at or below the floor with `status: "stale"`, `reasonCode: "command_expired"` — the same "expired envelope" answer `command-http.ts` gives, instead of a silent capacity refusal.
- Retire claims below the floor before the duplicate lookup and the capacity check, and persist the trimmed record (including `retiredBefore`) so the window keeps shrinking across cold starts.
- Capacity is now evaluated against the *live* claims only.

The duplicate-replay, `command_id_conflict` and `command_unknown` semantics are unchanged: retirement only ever touches claims older than the retention window, and an expired `commandId` is rejected rather than replayed, so a late retry can never re-execute a history intent.

Regression: `lineage.test.ts` — "never locks the session out once retired claims age past the retention window" seeds a full 256-claim window of expired claims, asserts an expired `commandId` is refused as `command_expired` (not replayed), asserts a fresh intent executes, and asserts the record shrank to one live claim with a durable `retiredBefore`.

### `F04-BUG-02` (Medium): failed file rewind erased an earlier applied rewind marker

`applyFileRewind` snapshotted `file_history` and `file_rewind_history` for compensation but treated `file_rewind_last` as disposable: the success path set it and the `catch` block ran `delete session.file_rewind_last` unconditionally. Only the *current* call's mutations were being undone; a marker written by an earlier, successful rewind was destroyed as collateral.

Failure scenario: rewind applies (marker + trace written, `save` succeeds). The operator edits one of the rewritten files. A second rewind for an earlier message hits `Workspace changed after the recorded operation` and compensates — files and `file_rewind_history` come back, but `file_rewind_last` is gone. Any consumer reading the last-applied rewind (resume UI, audit) then sees "never rewound" while the trace still records the rewind, i.e. the two records disagree.

Fix: capture `hadRewindLast` + a deep copy of the previous marker before the attempt, and restore-or-delete symmetrically in the `catch` block — matching how `file_rewind_history` was already handled.

Regression: `file-rewind.test.ts` — "a failed rewind restores the previous rewind marker instead of erasing it" seeds a prior marker and trace, forces a CAS divergence, and asserts both survive the compensating rollback.

---

## 4. Reported Gap (not fixed in this review)

### `F04-GAP-01` (Medium): the C-SES-02 primary store is library-only

`F04.02-result.md` describes "a default-capable SQLite primary session store" selected by `openStartupSessionStore` (JSON until `XUENESS_SESSION_STORE=sqlite` or a migrated database exists, SQLite afterwards). In the tree, `grep -rn "openStartupSessionStore\|migrateJsonJournals"` finds **no caller outside tests**: `apps/server/src/application-api.ts:86` builds the store through `createSessionsStore(options.stateDir, …)`, and `session-storage.ts:56-67` still constructs the JSON `SessionStore` as the primary with `SqliteSessionLibrary` as a *post-publication mirror* (`sqliteSaveHook`). So at runtime the journal remains the primary and C-SES-02's "primary transactional store" is a parallel implementation nobody starts.

This is deliberately **not** patched here: `PrimarySessionStore` (`sqlite-store.ts:115-120`) exposes only `new`/`save`/`load`/`list`, while the plugin layer depends on `store.pathFor`, `store.lease`, `store.directory`, `store.lockDirectory`, journal paths, save hooks and `readJournal` throughout `ts/plugins/*`. Swapping the primary is a multi-file store-interface change with its own migration/rollback risk, not a review-scoped fix. Recommended follow-up: either (a) land a `SessionStore`-compatible adapter over `SqliteSessionStore` and route `createSessionsStore` through `openStartupSessionStore`, or (b) restate `F04.02-result.md` as "transactional mirror + migration tooling available behind an explicit switch", so the deliverable claim matches the tree.

---

## 5. Verification

Run on `wt-review` (`bun 1.4.2`, then the changed tree):

| Command | Result |
| --- | --- |
| `bun test` (the 7 F04 phase test files, before changes) | 51 pass, 0 fail |
| `bun test packages/sessions/test/{message-model,sqlite-store}.test.ts plugins/sessions/test plugins/files/test` | 155 pass, 27 skip, 0 fail |
| `bun scripts/check-max-lines.ts` | `check:lines ok: 799 prod files` (largest `packages/engine-tools/src/background.ts`, 388/400) |
| `bun scripts/check-plugins.ts` | `check:plugins ok: 33 plugins, 484 source files` |
| `bun run typecheck` | clean |

**Observed flake (not a F04 defect, not changed).** One combined run of `packages/sessions/test plugins/sessions/test plugins/files/test` failed the `unread` assertion at `plugins/sessions/test/rewind.test.ts:61`; it passed 3/3 on immediate reruns, passed with the review changes stashed, and passed again on the changed tree. The assertion derives its own `mtimeMs`/`mtimeNs` from `statSync` and compares against the read-state sidecar, so under parallel load it can race the millisecond-granularity marker. It is unrelated to the files touched here; worth stabilising in its own change (use the read-state writer's own revision rather than a filesystem timestamp).

---

## 6. Changes in This Review

| File | Change |
| --- | --- |
| `ts/plugins/sessions/src/lineage.ts` | Retirement window for lineage command claims (`RETENTION_MS` floor, `retiredBefore` persisted and honoured, expired `commandId` answered `stale`/`command_expired`, capacity measured on live claims). |
| `ts/plugins/sessions/test/lineage.test.ts` | Regression: a full window of expired claims no longer blocks new intents and expired `commandId`s are refused rather than replayed. |
| `ts/plugins/files/src/file-rewind.ts` | Symmetric rollback of `file_rewind_last` (restore the previous marker, delete only if there was none). |
| `ts/plugins/files/test/file-rewind.test.ts` | Regression: a failed rewind preserves the previously applied marker and trace. |
| `docs/audits/20261024/deepseek-review-F04.md` | This report. |

C-SES-01 through C-SES-07 hold with the two defects above closed; `F04-GAP-01` remains an open integration item and is the only place where the phase documentation outruns the tree.
