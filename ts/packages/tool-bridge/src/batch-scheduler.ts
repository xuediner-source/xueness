/**
 * Safe concurrency barriers & execution order (C-TOOL-07): only calls
 * explicitly marked concurrency-safe (and not destructive) run in parallel
 * under a configurable cap; every other call is a serial barrier, approval
 * suspension blocks later parallel expansion, and call/result order is
 * preserved. `dependsOn` is accepted vocabulary but defaults to empty — no
 * dependency edges are ever fabricated.
 */

/** How many concurrency-safe calls of one batch run at once unless configured lower. */
export const DEFAULT_BATCH_CONCURRENCY = 10;

/** Safety metadata vocabulary used for scheduling (mirrors engine-tools tool flags). */
export interface ScheduledCall {
  /** Stable call id; `dependsOn` references these. */
  id?: string;
  /** Explicitly safe to run beside other safe calls; only this makes a call parallel-eligible. */
  concurrencySafe?: boolean;
  /** Pure read (advisory metadata; does not by itself grant parallelism). */
  readOnly?: boolean;
  /** Changes state. */
  mutating?: boolean;
  /** Destroys or irreversibly changes state; always a barrier. */
  destructive?: boolean;
  /** Ids of earlier calls that must settle first; default [] (no edges). */
  dependsOn?: readonly string[];
}

/** One execution group: a parallel run of consecutive eligible calls, or a single barrier call. */
export interface BatchGroup { readonly start: number; readonly end: number; readonly parallel: boolean }

/** Eligibility: explicitly concurrency-safe AND not destructive. readOnly/mutating alone never qualify. */
export function parallelEligible(call: ScheduledCall): boolean {
  return call.concurrencySafe === true && call.destructive !== true;
}

/** True when the call carries no dependency edges; unknown shapes simply count as dependent (barrier). */
function noDependencies(call: unknown): boolean {
  const dependsOn = (call as ScheduledCall | undefined)?.dependsOn;
  return dependsOn === undefined || (Array.isArray(dependsOn) && dependsOn.length === 0);
}

/**
 * Plan execution groups over the calls in model order. Pure and
 * deterministic: an eligible call joins the current parallel group (up to
 * `concurrencyCap` members) unless a dependency is declared or `suspended()`
 * holds; anything else closes the group and runs alone as a barrier.
 */
export function planBatches<T>(options: {
  calls: readonly T[];
  /** Max size of one parallel group; integer >= 1; default DEFAULT_BATCH_CONCURRENCY; otherwise TypeError. */
  concurrencyCap?: number;
  /** True while parallel expansion must stop (approval suspension, stopTurn, blocked effects). */
  suspended?: () => boolean;
  /** Eligibility override (call metadata may live elsewhere, e.g. a kernel tool registry). */
  eligible?: (call: T, index: number) => boolean;
}): BatchGroup[] {
  const cap = options.concurrencyCap ?? DEFAULT_BATCH_CONCURRENCY;
  if (!Number.isInteger(cap) || cap < 1) throw new TypeError(`concurrencyCap must be an integer >= 1 (got ${String(options.concurrencyCap)})`);
  const eligible = options.eligible ?? ((call: T) => parallelEligible(call as ScheduledCall));
  const groups: BatchGroup[] = [];
  let open: { start: number; end: number } | null = null;
  const close = (): void => {
    if (open) groups.push({ start: open.start, end: open.end, parallel: true });
    open = null;
  };
  for (let index = 0; index < options.calls.length; index += 1) {
    const call = options.calls[index] as T;
    const parallelizable = eligible(call, index) && noDependencies(call) && !(options.suspended?.() ?? false);
    if (parallelizable && open && open.end - open.start >= cap) close();
    if (parallelizable) {
      if (!open) open = { start: index, end: index };
      open = { start: open.start, end: index + 1 };
      continue;
    }
    close();
    groups.push({ start: index, end: index + 1, parallel: false });
  }
  close();
  return groups;
}

/**
 * Execute planned groups in order: a parallel group runs its members on
 * bounded workers that claim indices from a shared counter, a barrier group
 * runs its single call alone, and group N+1 never starts before group N
 * settles. `execute` rejections propagate to the caller.
 */
export async function runBatches<T>(options: {
  calls: readonly T[];
  groups: readonly BatchGroup[];
  /** Runs one call; settles results by index itself; rejections propagate to the caller. */
  execute: (call: T, index: number) => Promise<void>;
}): Promise<void> {
  for (const group of options.groups) {
    if (!group.parallel) {
      await options.execute(options.calls[group.start] as T, group.start);
      continue;
    }
    let next = group.start;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < group.end; index = next++) await options.execute(options.calls[index] as T, index);
    };
    await Promise.all(Array.from({ length: group.end - group.start }, worker));
  }
}
