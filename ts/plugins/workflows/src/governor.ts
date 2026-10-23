/**
 * Cross-process AIMD provider slots with round-robin fairness between
 * workflows (Python `ProviderGovernor`). State and lock files are shared
 * with Python workers in the same state directory.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, isPyIntValue, JsonFloat, numericValue, pyDecodeUtf8, pyFloatValue, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { nowSeconds, resolvePath, type Row } from "./plan.ts";
import { isSymlink, lockPath, writeJsonAtomic } from "./state-file.ts";

interface Bucket { limit: number; active: Record<string, Row>; queue: Row[]; last_owner: unknown; failures?: unknown; cooldown_until?: unknown }

export class ProviderGovernor {
  readonly state: string;
  readonly path: string;
  readonly lockFile: string;
  readonly defaultLimit: number;
  constructor(state: string, defaultLimit = 2) {
    this.state = resolvePath(state);
    this.path = join(this.state, ".workflow-provider-governor.json");
    this.lockFile = join(this.state, ".workflow-provider-governor.lock");
    this.defaultLimit = defaultLimit;
  }

  #locked<T>(body: (data: { buckets: Record<string, unknown> }) => T): T {
    mkdirSync(this.state, { recursive: true });
    if (isSymlink(this.path) || isSymlink(this.lockFile)) throw new PyValueError("provider governor state cannot be a symlink");
    const held = lockPath(this.lockFile);
    try {
      let data: unknown = { buckets: {} };
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path);
        if (raw.length > 1_000_000) throw new PyValueError("provider governor state too large");
        data = pyJsonLoads(pyDecodeUtf8(raw), { lossless: true });
        if (!isDict(data) || !isDict(data.buckets)) throw new PyValueError("invalid provider governor state");
      }
      return body(data as { buckets: Record<string, unknown> });
    } finally { held.release(); }
  }

  #bucket(data: { buckets: Record<string, unknown> }, key: string): Bucket {
    if (!Object.hasOwn(data.buckets, key)) data.buckets[key] = { limit: this.defaultLimit, active: {}, queue: [], last_owner: null, failures: 0, cooldown_until: new JsonFloat(0) };
    const bucket = data.buckets[key] as Bucket;
    if (!isDict(bucket) || !isPyIntValue(bucket.limit) || !isDict(bucket.active) || !Array.isArray(bucket.queue)) throw new PyValueError("invalid provider governor bucket");
    const now = nowSeconds();
    const age = (row: Row): number => now - (Object.hasOwn(row, "at") ? Number(numericValue(row.at)) : now);
    bucket.active = Object.fromEntries(Object.entries(bucket.active).filter(([, lease]) => isDict(lease) && age(lease) < 7200)) as Record<string, Row>;
    bucket.queue = bucket.queue.filter((item) => isDict(item) && age(item) < 3600);
    return bucket;
  }

  #save(data: unknown): void { writeJsonAtomic(this.state, ".provider-governor-", this.path, data); }

  enqueue(key: string, owner: string, ticket: string): void {
    this.#locked((data) => {
      const bucket = this.#bucket(data, key);
      if (!bucket.queue.some((item) => item.id === ticket) && !Object.hasOwn(bucket.active, ticket)) {
        bucket.queue.push({ id: ticket, owner, at: pyFloatValue(nowSeconds()) });
        if (bucket.queue.length > 10000) bucket.queue = bucket.queue.slice(-10000);
      }
      this.#save(data);
    });
  }

  tryAcquire(key: string, ticket: string): boolean {
    return this.#locked((data) => {
      const bucket = this.#bucket(data, key);
      const now = nowSeconds();
      const cooldown = Object.hasOwn(bucket, "cooldown_until") ? Number(numericValue(bucket.cooldown_until)) : 0;
      if (now < cooldown || Object.keys(bucket.active).length >= Number(bucket.limit)) { this.#save(data); return false; }
      const owners = [...new Set(bucket.queue.map((item) => item.owner))];
      if (!owners.length) { this.#save(data); return false; }
      const last = bucket.last_owner;
      const owner = owners.includes(last) && owners.length > 1 ? owners[(owners.indexOf(last) + 1) % owners.length] : owners[0];
      const winner = bucket.queue.find((item) => item.owner === owner)!;
      if (winner.id !== ticket) { this.#save(data); return false; }
      bucket.queue.splice(bucket.queue.indexOf(winner), 1);
      bucket.active[ticket] = { owner, at: pyFloatValue(now) };
      bucket.last_owner = owner;
      this.#save(data);
      return true;
    });
  }

  finish(key: string, ticket: string, success: boolean | null = null, options: { congestion?: boolean; retryAfter?: number | null } = {}): void {
    this.#locked((data) => {
      const bucket = this.#bucket(data, key);
      delete bucket.active[ticket];
      if (success === true) {
        bucket.limit = Math.min(8, Number(bucket.limit) + 1);
        bucket.failures = 0;
        bucket.cooldown_until = new JsonFloat(0);
      } else if (options.congestion || success === false) {
        bucket.limit = Math.max(1, Math.floor(Number(bucket.limit) / 2));
        const failures = Math.min(10, (Object.hasOwn(bucket, "failures") ? Number(numericValue(bucket.failures)) : 0) + 1);
        bucket.failures = failures;
        const fallback = Math.min(30, 0.5 * 2 ** (failures - 1));
        const delay = options.retryAfter != null ? Math.max(0, Math.min(120, Number(options.retryAfter))) : fallback;
        bucket.cooldown_until = pyFloatValue(nowSeconds() + delay);
      }
      this.#save(data);
    });
  }

  cancel(key: string, ticket: string): void {
    this.#locked((data) => {
      const bucket = this.#bucket(data, key);
      bucket.queue = bucket.queue.filter((item) => item.id !== ticket);
      delete bucket.active[ticket];
      this.#save(data);
    });
  }
}
