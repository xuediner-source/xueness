/** Shared private sidecar publication and native locks; never opens a link. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { fsyncDirectory, isLink, KeyedMutex, mkstemp, NativeFileLocks, protectPrivateDirectory, protectPrivateFile, readRegularBytes, replaceFile, writeAll } from "@xueness/sessions";
import { SID, type Row } from "./queue-types.ts";
const threads = new KeyedMutex(), native = new NativeFileLocks();
export class Sidecar {
  readonly root: string;
  readonly directory: string;
  readonly privateDirectory: boolean;
  constructor(root: string, folder: string, privateDirectory = false) { this.root = root; this.directory = join(root, folder); this.privateDirectory = privateDirectory; }
  path(sid: string): string {
    if (sid !== "create_session" && !SID.test(sid)) throw new PyValueError("invalid session id");
    return join(this.directory, `${sid}.json`);
  }
  checkDirectory(path = this.directory): void {
    if (isLink(path) || existsSync(path) && !lstatSync(path).isDirectory()) throw new PyValueError("message queue path is a reparse point");
  }
  async locked<T>(sid: string, body: () => T | Promise<T>): Promise<T> {
    this.path(sid); this.checkDirectory(this.root);
    const release = await threads.acquire(this.directory.toLowerCase());
    let handle: Awaited<ReturnType<NativeFileLocks["acquire"]>> | undefined;
    let global: Awaited<ReturnType<NativeFileLocks["acquire"]>> | undefined;
    try {
      if (this.privateDirectory) global = await native.acquire(join(this.root, ".locks"), "session-command-receipts.lock", 8);
      this.checkDirectory(); mkdirSync(this.directory, { mode: 0o700, recursive: true }); this.checkDirectory(); if (this.privateDirectory) protectPrivateDirectory(this.directory);
      const locks = join(this.directory, ".locks"); this.checkDirectory(locks); mkdirSync(locks, { mode: 0o700, recursive: true }); this.checkDirectory(locks); if (this.privateDirectory) protectPrivateDirectory(locks);
      handle = await native.acquire(locks, `${sid}.lock`, 8);
      return await body();
    } finally { if (handle) await handle.release(); if (global) await global.release(); release(); }
  }
  read(sid: string, limit: number): Row | null {
    this.checkDirectory(); const path = this.path(sid);
    if (!existsSync(path)) { if (isLink(path)) throw new PyValueError("invalid message queue file"); return null; }
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new PyValueError("invalid message queue file");
    if (info.size > limit) throw new PyValueError("message queue file is too large");
    const raw = readRegularBytes(path);
    if (raw.length > limit) throw new PyValueError("message queue file is too large");
    const record = pyJsonLoads(pyDecodeUtf8(raw), { lossless: true });
    if (!isDict(record)) throw new PyValueError("invalid sidecar record");
    return record;
  }
  save(sid: string, record: Row, limit: number, indent?: number): void {
    const path = this.path(sid);
    if (isLink(path) || existsSync(path) && !lstatSync(path).isFile()) throw new PyValueError("invalid message queue file");
    const bytes = pyEncodeUtf8(pyJsonDumps(record, { ensureAscii: false, ...(indent ? { indent } : { separators: [",", ":"] as [string, string] }) }));
    if (bytes.length > limit) throw new PyValueError("message queue is full");
    const temp = mkstemp(this.directory, ".queue-"); let fd: number | null = temp.fd;
    try {
      protectPrivateFile(fd); writeAll(fd, bytes); fsyncSync(fd); closeSync(fd); fd = null;
      replaceFile(temp.path, path); fsyncDirectory(this.directory);
    } finally { if (fd !== null) closeSync(fd); if (existsSync(temp.path)) unlinkSync(temp.path); }
  }
}
