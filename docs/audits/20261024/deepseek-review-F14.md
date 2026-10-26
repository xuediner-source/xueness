# F14 Review — deepseek-v4.1-flash (1017 max)

Scope: phase F14 commits `ce07954` (F14.01-02), `4e85556` (F14.03-04), `38eb7a4` (F14.05) on `wt-review-3`.
Method: read every added source/test file, ran the phase unit tests, probed edge cases directly, and executed the F14.05 closure gate against the real repo.

## Verdict

The machinery added in F14 is sound in structure and the phase tests pass (36/36 after this review). Five real defects were found and fixed in `ts`; two contract-level gaps in the delivery claim remain and need an owner decision before F14 can be called closed.

## Defects found and fixed

1. **`runLiveTasks` crashed instead of blocking when authorization was absent** — `plugins/providers/src/live-tasks.ts`.
   `options.authorization.authorized` was read before the `??` fallback, so a caller passing `undefined` (the exact case the module documents as "no authorization → nothing runs") got `TypeError: undefined is not an object` instead of five `blocked` records. Normalized to a local `authorization` value that defaults to `{ authorized: false }`; the batch now records `authorized: false` and never invokes the call port.

2. **Cost totals were summed across currencies** — `live-tasks.ts` `addUsage`.
   With `base.cost.currency = "USD"` and `add.cost.currency = "CNY"` the old code emitted `{ currency: add.currency, amount: base + add }`, i.e. a billed number that was never billed. Now the sum is only produced when both sides share a currency; otherwise the reported cost is dropped (unknown values must be omitted, never invented — the module's own contract).

3. **An authorized batch with zero records validated clean** — `live-tasks.ts` `validateLiveTaskBatch`.
   `records: []` with `authorized: true` passed validation, so a "F14.02 run" could be persisted that executed nothing and carries no outcome at all. A batch must now contain at least one scenario record.

4. **`paginateHistory` spun forever on a non-positive page size** — `plugins/diagnostics/src/performance-baseline.ts`.
   `pageSize = 0` (and any negative value) returned `{ ids: [], nextOffset: <same offset> }`, so the baseline's own walk (`while (offset !== null)`) looped indefinitely — a hung performance gate. Reproduced directly, then fixed so a non-positive size returns `nextOffset: null` (promoting it to one row was rejected: that serves data never requested). `total`/`offset` are floored so fractional input cannot produce non-integer ids.

5. **`concurrentFairness(0, n)` reported an infinite spread** — same file.
   `Math.max(...[])` is `-Infinity`, so a zero-worker call leaked `spread: -Infinity` into a report that is supposed to carry raw finite measurements. Worker count is now clamped to at least one lane.

## Contract gaps closed in the validators (anti-tamper)

6. **Summary counts were trusted, not derived** — `entry-acceptance.ts` and `live-tasks.ts`.
   Both documents advertise "category counts only, never rates", but on file load the counts were accepted as written. A hand-edited acceptance matrix could declare `summary.accepted: 3` with zero accepted cells, and a live-task batch could declare `completed: 5` with one record — precisely the "sample count masquerading as success" failure the phase exists to prevent. Both validators now recompute every count from the cells/records and reject mismatches.

7. **A directory counted as evidence of closure** — `ts/scripts/delivery-closure.ts` `evidenceExists`.
   `existsSync` is true for directories, so a ledger item citing `ts/packages/agent/src` resolved as locateable evidence. Evidence must now be a regular file (`statSync().isFile()`), otherwise the item is reported as counted-complete-without-evidence.

Regression tests were added for every fix above (pagination/fairness bounds, unauthorized default, empty batch, tampered summaries in both documents, directory evidence). No temporary probe files were left in the repo.

## Remaining gaps — reported, not silently patched

8. **F14.01/F14.02 are marked `completed` in `docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.json` without the acceptance they describe.**
   `F14.01-result.md` states plainly that "no cell is claimed accepted here" — the module builds a 12-cell matrix that, on the current host, is entirely `not_run`. `F14.02` is likewise a runner: no authorized live batch was executed, and without cost authorization the correct output is five `blocked` records. So the round delivered the acceptance *machinery* and zero accepted cells. Recording both as `completed` is the same "counted complete without evidence" pattern F14.05 was written to catch, one level up. This needs the owner to either re-run the probes with allocated Windows/macOS hosts and an explicit cost grant, or move the items to `external_pending`.

9. **The F14.05 closure gate fails on the delivered tree.**
   Running `bun ts/scripts/delivery-closure.ts` at `38eb7a4` exits 1 with `manifestConsistency=false`: `complete-project-manifest.json` is still the `61d5a71` baseline (177 changed, 308 added, 49 removed), and the ledger reports 5 complete / 1 external_pending / 17 open — 17 items still `open_for_alignment`. Regenerating the manifest is a large release-artifact rewrite (`bun ts/scripts/project-manifest.ts --write`) and should be done deliberately with the packaging step, not folded into a review commit, so it was left untouched. Until then the commit message claim "关闭差异账本并形成完整交付" is not supported by the phase's own gate.

## Pre-existing, out of F14 scope

`bun run typecheck` in `ts` reports 24 errors, all in `apps/server/src/agent-subagents.ts`, `apps/server/src/bundled-plugins.ts`, `plugins/subagents/test/channel-reply.test.ts` and `plugins/subagents/test/inheritance.test.ts` (`clampModelSelection`, `INHERITED_SOURCE`, `inheritableParentMessages` not exported). The count is identical with and without this review's changes and no F14 file appears in the list, so this is an earlier-round break that the F14 result files' "typecheck clean" claim did not surface.

## Verification

- `bun test` on the five F14 test files: **36 pass, 0 fail** (was 29 before the new regressions).
- `bun scripts/check-max-lines.ts`: ok — 835 files, largest 399/400.
- `bun scripts/check-plugins.ts`: ok — 34 plugins, 508 source files.
- `bun run typecheck`: 24 pre-existing errors outside F14; unchanged by this review.
