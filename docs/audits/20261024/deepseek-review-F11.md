# F11 Phase Review — deepseek-v4.1-flash (1017 max)

**Scope:** all F11 commits on `wt-review`
- `f3611ea` F11.01–02 — V4 contract & compatibility facade, complete wire codec
- `e161baa` F11.03–04 — subscription establish/resync, command receipts & canonical replay
- `df43db1` F11.05–06 — session hydration & projection, SSH/WSL and remote interaction ports

**Verdict:** accepted with 3 defects fixed. All three were real behavioural or
unbounded-growth bugs reachable from the shipped code paths, not style issues.

---

## Baseline (before review)

```
cd ts && bun test packages/contracts/test plugins/remote/test
  66 pass / 1 skip / 0 fail
```

The phase's own suites were green. The defects below live in edge cases the
suites do not cover, which is why they survived the commits.

---

## Fixed defects

### 1. `command-replay.ts` — an in-flight receipt was reported as committed

`replayCommand` returned `disposition: "committed"` for any reply that was a
dict without a `result` key. A `command/execute` acknowledgement such as
`{ commandId, status: "pending" }` therefore came back as a durable commit with
`sends: 1, queries: 0` — no receipt probe, no resend, and an uncommitted
acknowledgement handed to the caller as if it were settled. This contradicts the
module's own contract that only a *settled* receipt status
(`accepted|rejected|stale|noop|failed|duplicate`) may be published as committed,
and it also skips the deadline-bounded replay that exists precisely for this
case.

The fallback branch now only accepts a reply that is not receipt-shaped
(`status` / `commandId` absent), so a pending claim falls through to the probe
loop and ends as a resend or a typed `unknown`.

Observed after the fix: `unsettled receipt -> unknown, sends 2, queries 10`.

### 2. `projection-subscriber.ts` — a new `logEpoch` could never be entered

The seq guards ran before the epoch check. A conversation frame carrying a new
`logEpoch` is replayed from that log's zero, so `fromSeq` is `0` while the
committed `state.seq` is still the old log's value; `toSeq < state.seq` then
returned early and the frame was dropped as a stale replay. The old epoch's
cursor and epoch were both left in place, so every subsequent frame of the new
log was dropped the same way — the subscription silently stalled forever while
still reporting `ready: true`.

The epoch is now settled *before* the seq comparisons: a differing epoch resets
`state.seq` to `0`, a frame at `fromSeq === 0` is accepted as the new log's
start, and a new epoch arriving at a non-zero `fromSeq` counts as a gap and
resyncs instead of jumping the cursor forward.

Verified matrix: old-epoch frame keeps `seq: 100`; new epoch at `fromSeq 0`
adopts the new epoch at `seq: 5` with `gaps 0`; a same-epoch hole still resyncs
(`gaps 1`); a new epoch mid-stream resyncs rather than forward-jumping
(`gaps 2, resyncs 2`).

### 3. `app-protocol-hydration.ts` — removed sessions accumulated without bound

`hydrateWorkspace` bounded `tombstones` to `CONTROLLER_TOMBSTONES` (64) but
pushed a `status: "removed"` row into `sessions` for *every* session that left a
snapshot. Replaying 300 successive snapshots produced 300 rows in `sessions`
with only 64 tombstones — the deleted-session view grew linearly with snapshot
count while the ledger that is supposed to summarize it stayed bounded, and
`hydrationDigest` diverged between a cold client and a live one that had seen a
different number of intermediate snapshots.

Removed rows are now emitted only for identities still retained in the bounded
tombstone ledger. Observed after the fix: `sessions 65, tombstones 64` for the
same 300-snapshot replay.

---

## Reviewed and accepted as-is

- **V4 wire codec (`v4-wire-codec.ts`)** — the fragment budget is found by
  binary search over the caller's real envelope measurement with worst-case
  index digits, and every emitted frame is re-measured with a fail-closed
  `frameEnvelopeTooLarge` rather than trusting the estimate. Good.
- **Reassembly (`v4-wire-reassembly.ts`)** — staging-only fragments, per-fragment
  byte tallies against the assembly cap, idempotent identical duplicates vs.
  `frameAssemblyFragmentConflict` for divergent ones, checksum → UTF-8 → JSON →
  schema ordering, and the `complete` carrier subjected to the same 16 MiB
  ceiling as fragments (the comment correctly explains why). Good.
- **`v4-facade.ts`** — one-family-per-connection negotiation, one-directional
  capability rule enforced against the host's own catalog, unknown `v4/*` routes
  answered with the real route table, and recognized-but-unavailable routes
  refused rather than renamed to a nearby v2 method. Matches the stated contract.
- **`forwarding.ts`** — no shell, no remote command slot after `user@host`,
  loopback-only bind, unprivileged remote port, bare-host target, digest-guarded
  connection row re-check, generation-fenced replacement, bounded capacity and
  sanitized stderr diagnostics. Good.
- **`wsl.ts`** — pure functions with injected probe inputs; no environment or
  credential values read or embedded. Good.

## Noted, not changed

- `hydrateWorkspace` reports a removed row with `status: "removed"` inside
  `sessions` while the same identity is also in `tombstones`. This is the
  documented "tell finished from never-seen" behaviour and the existing test
  asserts it, so it was left alone; only its unbounded growth was a defect.
- `ProjectionSubscriber` hard-codes a 16-subscription cap while the manager
  accepts a negotiated `maxSubscriptions` from the hello. The two are not wired
  together. This is a real contract looseness but not a live defect (the manager
  never passes the negotiated value down), so it is recorded here rather than
  changed under a review task — it belongs to the F11.03 subscription-capacity
  follow-up if the negotiated limit is meant to be authoritative.

## Pre-existing failures, unrelated to F11

Confirmed by stashing the review fixes and re-running at `f3611ea`:

- `bun run typecheck` — `apps/server/src/bundled-plugins.ts(40,23): TS2307
  Cannot find module '@xueness/plugin-os_cua'`. The package name is correct in
  `plugins/os_cua/package.json`; the workspace link is simply absent from this
  checkout's `node_modules`.
- `packages/contracts/test/plugin-manifest-v1.test.ts` — 2 failures on the
  `native_ops` manifest (`is not a version 1 capability` ×3), plus
  `plugin capabilities > checks real hosts, listeners, programs and secrets`.

None of these files were touched by F11.

## Gates after the fixes

```
bun scripts/check-max-lines.ts   ok: 826 prod files, largest 398/400
bun scripts/check-plugins.ts     ok: 34 plugins, 501 source files
bun test plugins/remote/test packages/contracts/test/v4-binary.test.ts
                                 66 pass / 1 skip / 0 fail
bun run typecheck                only the pre-existing os_cua TS2307
```

## Files changed by this review

- `ts/plugins/remote/src/command-replay.ts`
- `ts/plugins/remote/src/projection-subscriber.ts`
- `ts/plugins/remote/src/app-protocol-hydration.ts`
