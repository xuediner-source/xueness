/** Private atomic JSON records and native workspace runner leases for memory dreams. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, PyValueError, uuid4Hex } from "@xueness/contracts";
import { foldHostPath, isLink, mkstemp, NativeFileLocks, protectPrivateDirectory, protectPrivateFile, realish, replaceFile, writeAll, fsyncDirectory, type FileLockHandle } from "@xueness/sessions";
import type { MemoryDreamRecord } from "./memory-dream-types.ts";

const ID = /^[a-f0-9]{32}$/;
const LOCK_SECONDS = 60;
const now = (): string => new Date().toISOString();
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function asRecord(value: unknown, id: string): MemoryDreamRecord {
  if (!isDict(value) || value.schemaVersion !== 1 || value.id !== id || typeof value.parentSessionId !== "string"
      || typeof value.root !== "string" || typeof value.startDigest !== "string" || !Array.isArray(value.sources)
      || !Array.isArray(value.sourceSessionIds) || !["draft", "running", "ready", "applied", "reverted", "failed", "cancelled"].includes(String(value.status))) {
    throw new PyValueError("invalid memory dream record");
  }
  return value as unknown as MemoryDreamRecord;
}

/** Records live only under `<stateDir>/memory-dreams`; no workspace path is used as a filename. */
export class MemoryDreamStore {
  readonly stateDir: string;
  readonly directory: string;
  readonly #locks = new NativeFileLocks();
  readonly #lockDirectory: string;

  constructor(stateDir: string) {
    const supplied = resolve(stateDir);
    if (isLink(supplied)) throw new PyValueError("memory dream state directory cannot be a link");
    this.stateDir = realish(supplied);
    this.directory = join(this.stateDir, "memory-dreams");
    this.#lockDirectory = join(this.directory, ".locks");
    if (isLink(this.stateDir) || isLink(this.directory)) throw new PyValueError("memory dream directory cannot be a link");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    protectPrivateDirectory(this.directory);
    if (isLink(this.#lockDirectory)) throw new PyValueError("memory dream lock directory cannot be a link");
    mkdirSync(this.#lockDirectory, { recursive: true, mode: 0o700 });
    protectPrivateDirectory(this.#lockDirectory);
  }

  #safe(): void {
    if (isLink(this.stateDir) || isLink(this.directory) || isLink(this.#lockDirectory)) {
      throw new PyValueError("memory dream directory cannot be a link");
    }
  }

  #path(id: unknown): string {
    this.#safe();
    if (typeof id !== "string" || !ID.test(id)) throw new PyValueError("invalid memory dream id");
    const path = join(this.directory, `${id}.json`);
    if (isLink(path)) throw new PyValueError("memory dream record cannot be a link");
    return path;
  }

  async #withRecordLock<T>(id: string, body: () => T | Promise<T>): Promise<T> {
    this.#path(id);
    const held = await this.#locks.acquire(this.#lockDirectory, `${id}.record`, LOCK_SECONDS);
    try { return await body(); } finally { held.release(); }
  }

  #loadUnlocked(id: string): MemoryDreamRecord {
    const path = this.#path(id);
    return asRecord(pyJsonLoads(pyDecodeUtf8(readFileSync(path)), { lossless: true }), id);
  }

  #write(record: MemoryDreamRecord): void {
    const path = this.#path(record.id), temp = mkstemp(this.directory, ".memory-dream-");
    try {
      protectPrivateFile(temp.fd);
      try {
        writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(record, { ensureAscii: false })));
        fsyncSync(temp.fd);
      } finally { closeSync(temp.fd); }
      this.#path(record.id);
      replaceFile(temp.path, path);
      fsyncDirectory(this.directory);
    } finally {
      if (existsSync(temp.path)) unlinkSync(temp.path);
    }
  }

  async create(input: Omit<MemoryDreamRecord, "id">): Promise<MemoryDreamRecord> {
    this.#safe();
    const record = { ...input, id: uuid4Hex() } as MemoryDreamRecord;
    if (existsSync(this.#path(record.id))) throw new PyValueError("memory dream id collision");
    this.#write(record);
    return record;
  }

  async load(id: string): Promise<MemoryDreamRecord> {
    return this.#withRecordLock(id, () => this.#loadUnlocked(id));
  }

  async update(id: string, change: (record: MemoryDreamRecord) => void): Promise<MemoryDreamRecord> {
    return this.#withRecordLock(id, () => {
      const record = this.#loadUnlocked(id);
      change(record);
      record.updatedAt = now();
      this.#write(record);
      return record;
    });
  }

  async list(): Promise<MemoryDreamRecord[]> {
    this.#safe();
    const names = readdirSync(this.directory).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
    const records: MemoryDreamRecord[] = [];
    for (const name of names) records.push(await this.load(name.slice(0, -5)));
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async acquireWorkspace(root: string): Promise<FileLockHandle> {
    this.#safe();
    const canonical = realish(root);
    const key = sha256(foldHostPath(canonical));
    return this.#locks.tryAcquire(this.#lockDirectory, `workspace-${key}.runner`);
  }

  async close(): Promise<void> { await this.#locks.close(); }
}
