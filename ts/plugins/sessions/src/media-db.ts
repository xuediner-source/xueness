import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, constants, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { fsyncDirectory, KeyedMutex, NativeFileLocks, mkstemp, protectPrivateDirectory, protectPrivateFile, replaceFile, writeAll, type FileLockProvider } from "@xueness/sessions";
import { Owner } from "./media-owner.ts";
export const MAX_SELECTION = 8, MAX_IMAGE_BYTES = 20 * 1024 * 1024, MAX_SELECTION_BYTES = 64 * 1024 * 1024, MAX_STAGED_BYTES = 64 * 1024 * 1024, MAX_DISK_BYTES = 512 * 1024 * 1024, MAX_RECORDS = 4096, MAX_INDEX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export class MediaArtifactError extends PyValueError { override name = "MediaArtifactError"; }
export interface MediaRef { id: string; name: string; mimeType: string; size: number; sha256: string; }
export interface MediaRecord extends MediaRef { owners: string[]; }
export interface Admission { binding: { commandId: string; destination: string; sources: [string, string[]][]; fingerprint: string }; ids: string[]; status: "reserved" | "finalized"; target: string | null; }
export interface MediaDb { version: number; artifacts: Record<string, MediaRecord>; admissions: Record<string, Admission>; retiredCommandBefore?: number; }
export function privateDir(path: string, protect = true): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new MediaArtifactError("invalid media directory");
  if (protect) protectPrivateDirectory(path);
}
export function readMedia(path: string, limit: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.isSymbolicLink()) throw new MediaArtifactError("invalid media file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const after = fstatSync(fd);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw new MediaArtifactError("media file changed");
    const blocks: Buffer[] = []; let count = 0;
    while (count <= limit) {
      const block = Buffer.alloc(Math.min(65536, limit + 1 - count));
      const n = readSync(fd, block, 0, block.length, null); if (!n) break;
      blocks.push(block.subarray(0, n)); count += n;
    }
    if (count > limit) throw new MediaArtifactError("media file too large");
    return Buffer.concat(blocks);
  } finally { closeSync(fd); }
}
const MUTEX = new KeyedMutex(), DEFAULT_LOCKS = new NativeFileLocks();
export class MediaDatabase {
  readonly directory: string;
  readonly blobs: string;
  readonly index: string;
  readonly locks: FileLockProvider;
  constructor(stateDir: string, locks?: FileLockProvider) {
    const state = lstatSync(stateDir);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new MediaArtifactError("invalid state directory");
    this.directory = join(stateDir, "media-artifacts"); privateDir(this.directory, false);
    this.blobs = join(this.directory, "blobs"); privateDir(this.blobs, false);
    this.index = join(this.directory, "index.json"); this.locks = locks ?? DEFAULT_LOCKS;
  }
  async transaction<T>(body: (db: MediaDb) => T): Promise<T> {
    const release = await MUTEX.acquire(this.directory);
    try {
      const lock = await this.locks.acquire(this.directory, "store.lock", 8);
      try {
        privateDir(this.directory); privateDir(this.blobs);
        let db: MediaDb = { version: 1, artifacts: {}, admissions: {} };
        // lexists includes a broken symlink, which readMedia must reject.
        let present = false; try { lstatSync(this.index); present = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (present) {
          const v = pyJsonLoads(pyDecodeUtf8(readMedia(this.index, MAX_INDEX_BYTES)));
          if (!isDict(v) || v.version !== 1 || !isDict(v.artifacts) || !isDict(v.admissions)) throw new MediaArtifactError("invalid media index");
          db = v as unknown as MediaDb;
        }
        return body(db);
      } finally { await lock.release(); }
    } finally { release(); }
  }
  save(db: MediaDb): void {
    const bytes = Buffer.from(pyJsonDumps(db, { ensureAscii: true, separators: [",", ":"] }));
    if (bytes.length > MAX_INDEX_BYTES) throw new MediaArtifactError("media metadata budget exceeded");
    const temp = mkstemp(this.directory, ".index-"); let fd: number | null = temp.fd;
    try { protectPrivateFile(fd); writeAll(fd, bytes); fsyncSync(fd); closeSync(fd); fd = null; replaceFile(temp.path, this.index); fsyncDirectory(this.directory); }
    finally { if (fd !== null) closeSync(fd); if (existsSync(temp.path)) unlinkSync(temp.path); }
  }
  ref(record: MediaRecord): MediaRef { const { id, name, mimeType, size, sha256 } = record; return { id, name, mimeType, size, sha256 }; }
  owned(db: MediaDb, owner: Owner, id: string): MediaRecord {
    if (!(owner instanceof Owner) || typeof id !== "string" || !/^[0-9a-f]{48}$/.test(id)) throw new MediaArtifactError("invalid media reference");
    const r = db.artifacts[id];
    if (!r || !r.owners.includes(owner.token())) throw new MediaArtifactError("media reference unavailable in this scope");
    return r;
  }
  quota(db: MediaDb, owner: Owner, records: MediaRecord[]): void {
    const selected = new Map(Object.values(db.artifacts).filter((r) => r.owners.includes(owner.token())).map((r) => [r.id, r]));
    for (const r of records) selected.set(r.id, r);
    if (owner.kind === "draft") {
      const staged = new Map(Object.values(db.artifacts).filter((r) => r.owners.some((o) => JSON.parse(o)[0] === "draft")).map((r) => [r.id, r]));
      for (const [id, r] of selected) staged.set(id, r);
      if ([...staged.values()].reduce((sum, r) => sum + r.size, 0) > MAX_STAGED_BYTES) throw new MediaArtifactError("media staged budget exceeded");
    }
    if (selected.size > MAX_SELECTION || [...selected.values()].reduce((sum, r) => sum + r.size, 0) > MAX_SELECTION_BYTES) throw new MediaArtifactError("media selection budget exceeded");
  }
}
