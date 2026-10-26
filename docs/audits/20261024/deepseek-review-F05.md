# F05 Phase Review — deepseek-v4.1-flash (1017 max)

Reviewer: deepseek-v4.1-flash (1017 max), WorkBuddy autonomous review
Branch: `wt-review-2`
Scope (phase F05 commits):

| Commit | Subject | Files |
| --- | --- | --- |
| `6f33344` | F05.01-02: File Read Range/Encoding/Media Semantics (C-TOOL-10) + Write/Edit Multi-Replace, Read Proof & Atomic CAS (C-TOOL-09) | `file-state.ts`, `text-codec.ts`, 2 new test files |
| `40ad4d7` | F05.03-05: Foreground Timeout Auto-Backgrounding (C-TOOL-08), Background Output/GC & Cross-Platform Process Tree Cleanup | `background.ts`, `exec.ts`, `process.ts`, `output-capture.ts`, `platform-matrix.ts`, 4 test files |

## Verdict

**Changes requested → fixed in this review.** The phase's own tests were green
(41/41 before review), but two real contract gaps in the
foreground→background handoff (`C-TOOL-08`) were invisible to them. Both are
fixed, with a regression test that fails on the old code.

## Findings

### F05-R1 (High, fixed) — A refused handoff orphaned the child's process tree

`process.ts`, deadline branch. When the adoption receiver reported capacity at
the deadline (`canAdopt()` true) and then refused the child (`adopt()` →
`false`), the fallback path settled the run as a plain timeout but only did
`live.delete(child)`. It never signalled the tree.

The sequence matters: the deadline branch clears every timer
(`for (const timer of timers) clearTimeout(timer)`) and removes the exit
listener *before* calling `adopt()`. So by the time the refusal arrives, the
timeout kill is gone, the caller's abort link was removed, and `finish()` can no
longer run (`adopting` is still true). Nothing remained to signal the child.

Reproduced before the fix: a refused handoff left `sleep 90` running with no
owner (`pgrep` found pids `1638754`, `1638763` after `runProcess` had already
resolved). This contradicts the documented contract in `RunProcessOptions`
("returns false when it could not take it (the tree is killed and the run
settles as a normal timeout)") and the C-TOOL-08 requirement that a command
without a background slot dies at its deadline.

Fix: `killTree(child, "SIGKILL")` before `live.delete(child)`, since the run
still owns the child at that point.

### F05-R2 (Medium, fixed) — An adopt timer could be attached to an already-finished task

`background.ts`, `adopt()`. The time limit was attached after
`await Promise.all(carriedDone)`. If the child exited while the carried output
was still being copied (a handoff at the very end of a run, or a large
`spillPath` replay), the task had already settled when the timer was set.

`#stop()` guards on `state === "running"`, so no wrong `timed_out` state was
observable. The real cost is resource lifetimes: the timer stays alive for the
full background timeout (default 30 min, max 3 h) and holds the task's log
files open for that whole period instead of being released immediately.

Fix: attach the timer only while `task.info.state === "running"`.

Note on review accuracy: my first probe of this area reported the symptom
incorrectly (it measured a healthy timeout, not the race). The corrected probe
and the `state` check above reflect what actually happens; no claim here rests
on the faulty first probe.

## Areas checked and found sound

- **F05.01 — read range/encoding semantics.** `FILE_PARTIAL_READ_MESSAGE` on
  `snapshot.partial` is reachable: `read.ts:186` records
  `env.tracker.record(target.absolute, info, bytes, !complete)`, and the
  persisted read state round-trips the flag (`plugins/files/src/read-state.ts`
  validates `typeof snapshot.partial !== "boolean"`). A later range read
  correctly downgrades an earlier full read.
- **`incompleteUtf8Tail` (`text-codec.ts`).** The 1/2/3-byte tail arithmetic
  and the `0xc2–0xf4` lead check are correct, and the guard sits before the
  GB18030 fallback, so a UTF-8 file truncated mid-character is refused rather
  than silently decoded as GBK. Good target for a fuzz pass, not a defect.
- **Carried-output ordering.** Pausing the handed-over streams until
  `carriedDone` resolves, then resuming, keeps log order intact; carried bytes
  go to the log only, so post-handoff `exec_output` reads stay incremental.
- **Cancel-link release.** `onAbort` returns early once `adopted`, so cancelling
  the foreground call cannot kill the task it handed off — covered by an
  existing test.
- **Windows job object.** `hostWindowsJob()?.assign(child.pid)` on register is
  null-safe and platform-guarded; per-child kills stay `killTree`'s job.

## Verification

| Gate | Result |
| --- | --- |
| F05 phase tests (8 files) | 42 pass, 0 fail |
| `bun scripts/check-max-lines.ts` | ok — 799 files, largest `background.ts` (388/400) |
| `bun scripts/check-plugins.ts` | ok — 33 plugins, 484 source files |
| `bun run typecheck` | clean |
| New regression test vs. pre-fix code | fails with "a refused handoff must not leave an unowned process running" |

The added regression test is
`packages/engine-tools/test/exec-auto-background.test.ts` →
"ends the tree when the handoff is refused at the deadline". It captures the
handoff pid and asserts the process is gone, so it verifies the actual
ownership contract rather than only the returned flags.

## Non-blocking observations

- `background.ts` is at 388/400 effective lines. F05 consumed most of the
  remaining headroom; the next non-trivial addition to this file should split
  the adopt/register path into its own module rather than push past the gate.
- `adopt()` reuses the foreground `AbortSignal` removal but keeps
  `detachedBackground: true` on the adopted result even though the output is no
  longer detached; the value is unused on that path today, so this is cosmetic.
