/** Composer staging uses the same private files and OS lock as Python. */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pyLen } from "@xueness/contracts";
import { isLink, KeyedMutex, mkstemp, NativeFileLocks, protectPrivateDirectory, protectPrivateFile, readRegularBeneath, realish, replaceFile, writeAll, type Session } from "@xueness/sessions";
import { MediaArtifactStore } from "./media-store.ts";
import { Owner } from "./media-owner.ts";
import { AttachmentError, attachmentToken, digest, IMAGE_BYTES, ORIGINS, sessionSelection, validName, type AttachmentOptions, type AttachmentRow } from "./attachment-types.ts";
const threads = new KeyedMutex(), locks = new NativeFileLocks();
export class AttachmentFiles {
  readonly options: AttachmentOptions;
  constructor(options: AttachmentOptions) { this.options = options; }
  async root(value: unknown): Promise<string> {
    if (typeof value !== "string" || !value || pyLen(value) > 4096 || !isAbsolute(value)) throw new AttachmentError("workspace root not permitted");
    const root = realish(value), allowed = [this.options.projectDir, this.options.webRuns, ...(this.options.allowedRoots?.() ?? [])].map(realish);
    if (!allowed.some((base) => { const path = relative(base, root); return path === "" || !path.startsWith("..") && !isAbsolute(path); }) || !existsSync(root) || !lstatSync(root).isDirectory()) throw new AttachmentError("workspace root not permitted");
    return root;
  }
  privateDirectory(path: string): void {
    if (isLink(path) || existsSync(path) && !lstatSync(path).isDirectory()) throw new AttachmentError("attachment store unavailable");
    mkdirSync(path, { recursive: true, mode: 0o700 }); protectPrivateDirectory(path);
    if (isLink(path)) throw new AttachmentError("attachment store unavailable");
  }
  base(): string {
    if (isLink(this.options.stateDir)) throw new AttachmentError("attachment store unavailable");
    const directory = join(this.options.stateDir, "composer-attachments"); this.privateDirectory(directory); return directory;
  }
  scopeName(root: string, sid: string | null): string { return sid ? "s" + attachmentToken(sid) : "d" + digest(root).slice(0, 32); }
  /** Composer reads are bounded snapshots; they never repair or rewrite journals. */
  session(sid: string): Session | null {
    try {
      const path = this.options.store.pathFor(sid), maximum = 8 * 1024 * 1024;
      const read = readRegularBeneath(this.options.store.directory, basename(path), maximum + 1);
      if (!read || read.size > maximum || read.raw.length > maximum) return null;
      const value = pyJsonLoads(pyDecodeUtf8(read.raw), { lossless: true });
      return isDict(value) && value.id === sid ? value : null;
    } catch { return null; }
  }
  async scope(root: string, sid: string | null): Promise<string> {
    if (sid) { const session = this.session(sid); if (!session || typeof session.root !== "string" || realish(session.root) !== root) throw new AttachmentError("workspace root not permitted"); }
    const directory = join(this.base(), this.scopeName(root, sid)); this.privateDirectory(directory); return directory;
  }
  path(directory: string, id: string, suffix = ".json"): string { return join(directory, attachmentToken(id) + suffix); }
  readBytes(path: string, maximum = IMAGE_BYTES): Buffer {
    if (isLink(path) || !existsSync(path)) throw new AttachmentError();
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new AttachmentError("attachment exceeds its size limit");
    const result = readRegularBeneath(dirname(path), basename(path), maximum + 1, true);
    if (!result || result.size > maximum || result.raw.length > maximum) throw new AttachmentError();
    return result.raw;
  }
  readJson(path: string): AttachmentRow {
    const value = pyJsonLoads(pyDecodeUtf8(this.readBytes(path, 65536)), { lossless: true });
    if (!isDict(value)) throw new AttachmentError(); return value;
  }
  writeBytes(path: string, raw: Uint8Array): void {
    if (isLink(path) || existsSync(path) && !lstatSync(path).isFile()) throw new AttachmentError("attachment store unavailable");
    const temp = mkstemp(dirname(path), ".attachment-"); let fd: number | null = temp.fd;
    try { protectPrivateFile(fd); writeAll(fd, raw); fsyncSync(fd); closeSync(fd); fd = null; replaceFile(temp.path, path); this.syncDirectory(dirname(path)); }
    finally { if (fd !== null) closeSync(fd); if (existsSync(temp.path)) unlinkSync(temp.path); }
  }
  /** Allocation metadata must be durable before an owner is adopted or retired. */
  syncDirectory(path: string): void {
    if (process.platform === "win32") return;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  writeJson(path: string, record: AttachmentRow): void { this.writeBytes(path, pyEncodeUtf8(pyJsonDumps(record, { ensureAscii: false, indent: 2 }))); }
  draftOwner(record: AttachmentRow): Owner { return new Owner("draft", record.id, record.root, record.session_id || null); }
  chunks(directory: string, id: string): void {
    for (const name of readdirSync(directory).filter((name) => name.startsWith(id + ".") && name.endsWith(".chunk"))) {
      const path = join(directory, name); if (isLink(path) || !lstatSync(path).isFile()) throw new AttachmentError("attachment store unavailable"); unlinkSync(path);
    }
  }
  async remove(directory: string, id: string): Promise<void> {
    const metadata = this.path(directory, id);
    if (existsSync(metadata)) {
      const record = this.readJson(metadata);
      if (record.id !== id || this.scopeName(record.root, record.session_id || null) !== basename(directory)) throw new AttachmentError("invalid attachment disposal scope");
      await new MediaArtifactStore(this.options.stateDir).release(this.draftOwner(record));
    }
    this.chunks(directory, id);
    for (const path of [metadata, this.path(directory, id, ".bin")]) { if (isLink(path)) throw new AttachmentError("attachment store unavailable"); if (existsSync(path)) unlinkSync(path); }
  }
  async record(directory: string, id: string, root: string, sid: string | null, readOnly = false): Promise<AttachmentRow> {
    const r = this.readJson(this.path(directory, id));
    if (r.id !== id || r.root !== root || r.session_id !== (sid || "") || !["pending", "committed"].includes(r.status) || !["upload", "workspace"].includes(r.source) || !ORIGINS.has(r.origin) || !validName(r.name)) throw new AttachmentError();
    if (r.status === "pending" && Date.now() / 1000 - Number(r.created ?? 0) > 900) {
      if (!readOnly) await this.remove(directory, id);
      throw new AttachmentError("attachment upload expired; reattach the file", 410);
    }
    if (r.source === "workspace" && !r.path || r.source === "upload" && r.path) throw new AttachmentError(); return r;
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const release = await threads.acquire(realish(this.options.stateDir)); let held: Awaited<ReturnType<NativeFileLocks["acquire"]>> | undefined;
    try {
      held = await locks.acquire(join(this.options.stateDir, ".composer-attachment-locks"), "transactions.lock", 8);
      this.base();
      if (!this.options.enabled("sessions")) throw new AttachmentError("plugin disabled or dependency unavailable: sessions", 403);
      return await fn();
    } finally { await held?.release(); release(); }
  }
  async staged(keep: string): Promise<[string, AttachmentRow][]> {
    const base = this.base(), names = readdirSync(base), directories: string[] = [], records: [string, AttachmentRow][] = [];
    if (names.length > 1024) throw new AttachmentError("attachment staging cleanup is bounded; retry", 429);
    for (const name of names) {
      const path = join(base, name); if (isLink(path) || !lstatSync(path).isDirectory()) throw new AttachmentError("attachment store unavailable");
      if (path !== keep && readdirSync(path).length === 0) { rmdirSync(path); continue; }
      if (directories.length >= 512) throw new AttachmentError("attachment staging capacity reached", 429); directories.push(path);
    }
    let count = 0;
    for (const directory of directories) {
      const entries = readdirSync(directory); count += entries.length;
      if (count > 256 * 132 || entries.filter((name) => name.endsWith(".json")).length > 257) throw new AttachmentError("attachment staging capacity reached", 429);
      for (const name of entries.filter((name) => name.endsWith(".json"))) {
        const path = join(directory, name); let record: AttachmentRow;
        try { record = this.readJson(path); } catch { continue; }
        if (Number.isInteger(record.created) && record.status === "pending" && Date.now() / 1000 - record.created > 900 && name.length === 37) await this.remove(directory, name.slice(0, -5));
      }
      for (const name of entries) {
        const path = join(directory, name); if (!existsSync(path) && !isLink(path)) continue;
        if (isLink(path) || !lstatSync(path).isFile()) throw new AttachmentError("attachment store unavailable");
        if (name.endsWith(".json")) {
          const r = this.readJson(path); attachmentToken(r.id);
          if (name !== r.id + ".json" || !Number.isInteger(r.size) || r.size < 0 || !["pending", "committed"].includes(r.status)) throw new AttachmentError("attachment store unavailable");
          records.push([directory, r]); if (records.length > 256) throw new AttachmentError("attachment staging capacity reached", 429);
        } else if (Date.now() - lstatSync(path).mtimeMs > 900000) {
          const id = name.split(".")[0]!;
          if (name.startsWith(".attachment-") || name.startsWith(".resource-") || /^[a-f0-9]{32}$/.test(id) && !existsSync(this.path(directory, id))) unlinkSync(path);
        }
      }
    }
    for (const [directory, r] of records) if (r.version === 1 && r.status === "committed") this.chunks(directory, r.id);
    return records;
  }
  async target(data: AttachmentRow): Promise<{ root: string; sid: string | null; id: string; directory: string }> {
    const root = await this.root(data.root), sid = sessionSelection(data.session_id), id = attachmentToken(data.id);
    return { root, sid, id, directory: await this.scope(root, sid) };
  }
}
