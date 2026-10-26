# H12 Review — Desktop harness telemetry & replay polish

Reviewer: deepseek-v4.1-flash (1017 max)
Date: 2026-10-24
Branch: `wt-review-3`
Scope: phase H12 (`H12.01` … `H12.06`)

## Commits inspected

| Commit | Subject |
| --- | --- |
| `5116ee7` | H10.03-04 + H11.01-02 + H12.01/05-06: optimizer, chaos, desktop telemetry/polish |
| `9b2399d` | H12.03-04: Trajectory replay scrubber polish + Critic drawer visual state polish |

Source under review:

- `ts/apps/desktop/src/harness-telemetry.ts` (H12.01)
- `ts/apps/desktop/src/renderer/harness-status-strip.ts` (H12.05)
- `ts/apps/desktop/src/renderer/trajectory-replay.ts` (H12.03)
- `ts/apps/desktop/src/renderer/critic-review-drawer.ts` (H12.04 additions)
- Tests: `trajectory-replay.test.ts`, `critic-review-drawer.test.ts`, `harness-telemetry.test.ts`, `harness-status-strip.test.ts`, `harness-polish.test.ts` (H12.06)

## What holds up

- **H12.01 schema/redaction** — validation is total (never throws, collects field-level errors), forward-compatible (unknown fields preserved), and `redactText` masks Bearer tokens, `sk-`/`ghp`/`xox*` keys and `token=`/`password=` assignments while `promptTokens` is correctly *not* treated as a secret (`SECRET_SEGMENTS` splits camelCase). `parseHarnessTelemetryLine` degrades a torn line to an error rather than aborting a whole export.
- **H12.05 status strip** — rows are frozen snapshots, `stripState` walks `idle → ok → warn → critical → exhausted` monotonically, and `render()` is deterministic. A zero/negative quota is rejected loudly while an absent quota degrades to plain totals.
- **H12.03/H12.04 core design** — both modules are pure view models (no DOM, no timers), so the renderer only paints snapshots. `buildReplayFrames` correctly keeps `files` immutable per frame (accept copies, so stepping back never leaks future state), and the H12.04 controller deliberately retains the last loaded drawer across a *failed* reload, so an open review is never blanked by a transient error. The empty state (`rounds.length === 0` → `"empty"`) and `retryable` signalling are both covered.
- **H12.06 acceptance pack** — the offline polish pack drives the real H02.05 critic-solver, H02.06 recorder and H06 profiler instead of fixtures alone, and asserts a second replay is byte-identical. This is a genuine integration check, not a fixture statistic.
- **Plugin ownership** — the H12 work lives entirely inside `ts/apps/desktop` (the `desktop` plugin's backend/app surface, declared in `ts/catalog/desktop.json` `desktopModules`/`features`), with no business logic added to the CLI, web server or agent kernel.

## Defects found and fixed

### 1. H12.03 — `step()` accepted non-integer deltas and could poison the cursor (real bug)

`TrajectoryScrubber.step(delta)` clamped with `Math.min(Math.max(cursor + delta, 0), len - 1)` but never checked that `delta` was an integer, unlike `seek()` which does validate. Confirmed by probe:

- `step(1.5)` returned `null` (no frame at a fractional index) yet left `position === 1.5`, so `current` became `null` while `atStart`/`atEnd` both reported `false` — a scrubber stuck on no frame, which is exactly the "desync from the recorded timeline" the class documentation promises cannot happen.
- `step(NaN)` set `position === NaN` permanently; every later `step()` returned `null`, `atEnd` stayed `false`, and only `reset()` recovered — i.e. a single bad scrubber-tick froze replay.

Fix (`trajectory-replay.ts`): reject a non-integer `delta` with `null` and leave the cursor untouched, mirroring `seek()`'s contract. Regression test: *"ignores non-integer steps so the cursor can never leave the timeline"*.

### 2. H12.03 — a garbled verdict frame silently counted as a reject (contract gap)

`parseTrajectory` (H02.06) only validates `type`, so a partially-written or externally-produced line such as `{"type":"verdict","round":1}` reaches the replay builder with no `verdict` field. The builder took the `else` branch of `if (verdictEvent.verdict === "accept")`, which meant:

- `rejectedRounds` gained round 1 and `lastVerdict` became `"reject"` — inventing a critic decision that was never recorded;
- `pendingProposal` was cleared, so the still-unreviewed solver proposal vanished from the timeline.

The same hole existed for a non-integer/missing `round` (the round would flow into `acceptedRounds`/`rejectedRounds` as `undefined`). Fix: `verdict` is normalised to `null` unless it is literally `"accept"` or `"reject"`, and a verdict only records a decision (and consumes the pending proposal) when both `verdict` and `round` are usable; a malformed exchange likewise keeps its proposal unattributed instead of keying a map on `undefined`. This makes replay **fail closed** — an unreadable decision decides nothing — and keeps the H12.06 "no `undefined` leakage in painted strings" guarantee intact for verdict frames. Regression test: *"keeps a garbled verdict frame from deciding anything"*.

### 3. H12.04 — a synchronously throwing loader left the drawer stuck in `loading` (real bug)

`CriticDrawerController.refresh()` assigned `this.loadResult().then(...)`. If `load()` threw synchronously (a real possibility for a loader that reads a file or parses a path argument before its first `await`), the throw escaped `refresh()` before `this.inflight` was ever assigned, so:

- `refresh()` rejected instead of resolving to `null` — the documented contract is *"on rejection the state becomes `error`"*, and callers awaiting it `catch` nothing;
- `stateRecord` was already set to `"loading"`, so the drawer painted "Loading critic review…" forever with `retryable: false` — the UI locked itself out of the very retry path the controller exists to offer.

Fix: wrap the loader call in `try/catch` and convert a synchronous throw into a rejected promise, funnelling it through the existing `.catch(...)` path so it becomes the normal `error` state with a retryable status. The loader is still invoked synchronously, which preserves the one-in-flight-load contract the concurrency test asserts (`calls === 1`). Regression test: *"treats a synchronously throwing loader as a normal load failure"*.

## Verification

Phase tests (`bun test`, all green):

```
bun test apps/desktop/test/trajectory-replay.test.ts \
         apps/desktop/test/critic-review-drawer.test.ts \
         apps/desktop/test/harness-polish.test.ts \
         apps/desktop/test/harness-status-strip.test.ts \
         apps/desktop/test/harness-telemetry.test.ts
→ 70 pass, 0 fail
```

Gate scripts from `ts/`:

| Gate | Result |
| --- | --- |
| `bun scripts/check-max-lines.ts` | ok — 876 prod files, largest 399/400 effective lines |
| `bun scripts/check-plugins.ts` | ok — 35 plugins, 544 source files |
| `bun run typecheck` | 1157 pre-existing errors, **identical count before and after** the fixes; zero errors in the four touched files |

`bun run typecheck` is red on this branch for unrelated, pre-existing reasons (stale `@xueness/sessions` exports consumed by `plugins/workflows`, and one narrowing complaint in `harness-telemetry.test.ts:91`). This review did not introduce any of them — the error count was confirmed byte-identical with the H12 changes stashed — and did not attempt to fix unrelated modules.

## Notes / residual risk (not fixed, out of scope)

- `harness-telemetry.test.ts:91` has a `TS2352` cast complaint. It is pre-existing and does not affect runtime behaviour (bun strips types), so it was left alone to keep this review scoped to H12 delivery.
- `H12.02` (telemetry ring buffer + export) is explicitly deferred in `H12.02-result.md` and remains `pending` in the task plan; the schema landed in H12.01 so the buffer can be added without a breaking change.
- `CriticDrawerController` has no automatic retry/backoff. That is a deliberate purity choice (no timers) and `status.retryable` hands the decision to the renderer; worth revisiting only if the desktop host wants auto-heal on transient transport errors.

## Verdict

**Approved after fixes.** Three real defects (scrubber cursor corruption, invented verdicts on garbled trajectory lines, drawer deadlock on a synchronous loader throw) were found by probing the edge cases the phase tests did not cover; all three are fixed with regression tests. The phase's design intent — pure, DOM-free, deterministic view models with fail-safe degradation — holds once these gaps are closed.
