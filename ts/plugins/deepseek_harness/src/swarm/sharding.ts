/** H07.02: swarm task sharding with non-overlapping file scopes.
 *
 * Partitions a task's file scope into N shards such that every file lands in
 * exactly one shard (no overlap), greedy-balanced by per-file weight so agents
 * get roughly even loads. Deterministic: sorted inputs, stable tie-breaking.
 */

export interface FileScope {
  /** Repo-relative path; uniqueness is enforced by the planner. */
  readonly path: string;
  /** Estimated work (lines, bytes, or any monotone cost); defaults to 1. */
  readonly weight?: number;
}

export interface Shard {
  readonly index: number;
  readonly files: readonly string[];
  readonly weight: number;
}

export interface ShardingOptions {
  /** Reject overlapping inputs by throwing; on by default. */
  readonly strict?: boolean;
}

export class ShardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShardingError";
  }
}

/**
 * Plans `shardCount` disjoint shards over `files`. Greedy LPT: heaviest file
 * goes to the currently-lightest shard, ties broken by shard index.
 */
export function planShards(
  files: readonly FileScope[],
  shardCount: number,
  options: ShardingOptions = {},
): Shard[] {
  const strict = options.strict !== false;
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new ShardingError(`shardCount must be a positive integer, got ${shardCount}`);
  }
  if (files.length === 0) return emptyShards(shardCount);

  const seen = new Set<string>();
  for (const file of files) {
    if (file.path.length === 0) throw new ShardingError("file path must be non-empty");
    if (seen.has(file.path)) {
      if (strict) throw new ShardingError(`duplicate file in task scope: ${file.path}`);
      continue;
    }
    seen.add(file.path);
  }

  const ordered = [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const weightOf = new Map(ordered.map((p) => [p, normalizeWeight(files.find((f) => f.path === p))]));
  const loads: number[] = Array.from({ length: shardCount }, () => 0);
  const buckets: string[][] = Array.from({ length: shardCount }, () => []);

  // Heaviest first (stable by path), always onto the lightest shard.
  const descending = [...ordered].sort(
    (a, b) => weightOf.get(b)! - weightOf.get(a)! || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const path of descending) {
    let target = 0;
    for (let i = 1; i < shardCount; i++) {
      const loadI = loads[i] ?? 0;
      const loadT = loads[target] ?? 0;
      const bucketI = buckets[i] ?? [];
      const bucketT = buckets[target] ?? [];
      if (loadI < loadT || (loadI === loadT && bucketI.length < bucketT.length)) {
        target = i;
      }
    }
    (buckets[target] as string[]).push(path);
    loads[target] = (loads[target] ?? 0) + (weightOf.get(path) ?? 1);
  }

  return buckets.map((bucket, index) => ({
    index,
    files: bucket,
    weight: bucket.reduce((sum, p) => sum + weightOf.get(p)!, 0),
  }));
}

/** True when no path appears in more than one shard (vacuously true for disjoint arrays). */
export function shardsAreDisjoint(shards: readonly Shard[]): boolean {
  const owner = new Map<string, number>();
  for (const shard of shards) {
    for (const path of shard.files) {
      const seen = owner.get(path);
      if (seen !== undefined && seen !== shard.index) return false;
      owner.set(path, shard.index);
    }
  }
  return true;
}

/** True when the union of shard files equals `expected` exactly. */
export function shardsCover(shards: readonly Shard[], expected: readonly string[]): boolean {
  const planned = new Set(expected);
  for (const shard of shards) {
    for (const path of shard.files) {
      if (!planned.delete(path)) return false; // unknown or duplicated path
    }
  }
  return planned.size === 0;
}

/** Max shard weight minus min shard weight; 0 when perfectly balanced. */
export function shardWeightSpread(shards: readonly Shard[]): number {
  if (shards.length === 0) return 0;
  const loads = shards.map((s) => s.weight);
  return Math.max(...loads) - Math.min(...loads);
}

/** Convenience: paths → shards sized to the coordinator's parallelism N. */
export function shardPaths(
  paths: readonly string[],
  shardCount: number,
  options: ShardingOptions = {},
): Shard[] {
  return planShards(
    paths.map((path) => ({ path })),
    shardCount,
    options,
  );
}

function emptyShards(shardCount: number): Shard[] {
  return Array.from({ length: shardCount }, (_, index) => ({ index, files: [], weight: 0 }));
}

function normalizeWeight(file: FileScope | undefined): number {
  const weight = file?.weight ?? 1;
  if (!Number.isFinite(weight) || weight < 0) {
    throw new ShardingError(`weight for ${file?.path} must be a non-negative number`);
  }
  return weight;
}
