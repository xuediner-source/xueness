/**
 * ZCode v3.15.1 `core/src/tool/handlers/webfetch-cache.ts`: fetched pages are
 * kept 15 minutes, 50 MB in total, least recently used first out. Only a
 * successful `web_fetch` is stored; every call is still approved first.
 */
import type { Row } from "./errors.ts";

export const CACHE_TTL_MS = 15 * 60 * 1000;
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;

interface Entry { value: Row; sizeBytes: number; expiresAt: number }

export class FetchCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }

  get(key: string): Row | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.#now()) { this.#bytes -= entry.sizeBytes; return undefined; }
    this.#entries.set(key, entry);
    return entry.value;
  }

  put(key: string, value: Row, sizeBytes: number): void {
    if (sizeBytes > CACHE_MAX_BYTES) return;
    const previous = this.#entries.get(key);
    if (previous) { this.#entries.delete(key); this.#bytes -= previous.sizeBytes; }
    this.#entries.set(key, { value, sizeBytes, expiresAt: this.#now() + CACHE_TTL_MS });
    this.#bytes += sizeBytes;
    const now = this.#now();
    for (const [name, entry] of this.#entries) if (entry.expiresAt <= now) { this.#entries.delete(name); this.#bytes -= entry.sizeBytes; }
    for (const [name, entry] of this.#entries) { if (this.#bytes <= CACHE_MAX_BYTES) break; this.#entries.delete(name); this.#bytes -= entry.sizeBytes; }
  }

  clear(): void { this.#entries.clear(); this.#bytes = 0; }
  get size(): number { return this.#entries.size; }
  get bytes(): number { return this.#bytes; }
}
