/** Durable restore identities fence cancellation and late retries across runtimes. */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pyLen } from "@xueness/contracts";
import { isLink, type Session } from "@xueness/sessions";
import { AttachmentFiles } from "./attachment-fs.ts";
import { AttachmentError, attachmentKeys, sessionSelection, type AttachmentRow as Row } from "./attachment-types.ts";
const MAX_BYTES = 512 * 1024, MAX_RECEIPTS = 64;
export function restoreIdentity(root: string, sid: string, data: Row): Row {
  const { restoreId, messageIndex, revision, restoreEpoch } = data;
  if (typeof restoreId !== "string" || !/^[0-9a-f]{32}$/.test(restoreId) || !Number.isSafeInteger(restoreEpoch) || restoreEpoch < 0 || !Number.isInteger(messageIndex) || messageIndex < 0 || typeof revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(revision)) throw new AttachmentError("invalid restore request identity");
  return { restoreId, root, sessionId: sid, messageIndex, revision, restoreEpoch };
}
export async function restoreSession(files: AttachmentFiles, sid: string | null): Promise<Session | null> {
  return sid ? files.session(sid) : null;
}
export class RestoreReceipts {
  readonly files: AttachmentFiles;
  readonly directory: string;
  constructor(files: AttachmentFiles, directory: string) { this.files = files; this.directory = directory; }
  path(ident: Row): string {
    const base = join(this.files.options.stateDir, "composer-restore-receipts"), scope = join(base, basename(this.directory));
    this.files.privateDirectory(base); this.files.privateDirectory(scope); this.files.syncDirectory(dirname(base)); this.files.syncDirectory(base);
    return join(scope, ident.restoreId + ".json");
  }
  read(path: string): Row | null {
    if (isLink(path)) throw new AttachmentError("restore receipt store unavailable");
    if (!existsSync(path)) return null;
    const record = pyJsonLoads(pyDecodeUtf8(this.files.readBytes(path, MAX_BYTES)), { lossless: true });
    if (!isDict(record)) throw new AttachmentError("restore receipt invalid", 409);
    return record;
  }
  load(ident: Row): Row | null {
    const r = this.read(this.path(ident)); if (r === null) return null;
    if (!isDict(r) || Object.entries(ident).some(([k, v]) => r[k] !== v)) throw new AttachmentError("restoreId belongs to a different request", 409);
    if (!["preparing", "committed", "aborted"].includes(r.status as string) || !Array.isArray(r.refs) || r.refs.length > 8 || r.refs.some((v) => typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) || new Set(r.refs).size !== r.refs.length) throw new AttachmentError("restore receipt invalid", 409);
    return r;
  }
  epoch(ident: Row, create = true): number {
    const path = join(dirname(this.path(ident)), "epoch.json");
    if (!existsSync(path)) {
      if (!create) throw new AttachmentError("original restore ownership unavailable", 404);
      this.files.writeJson(path, { root: ident.root, sessionId: ident.sessionId, restoreEpoch: 0 });
    }
    const value = this.files.readJson(path);
    if (value.root !== ident.root || value.sessionId !== ident.sessionId || !Number.isSafeInteger(value.restoreEpoch) || value.restoreEpoch < 0) throw new AttachmentError("restore epoch ownership mismatch", 409);
    return value.restoreEpoch;
  }
  retire(ident: Row): number {
    let epoch = this.epoch(ident); const parent = dirname(this.path(ident)), settled: string[] = [], names = readdirSync(parent).filter((n) => n.endsWith(".json"));
    if (names.length > MAX_RECEIPTS + 1) throw new AttachmentError("restore receipt capacity exceeded", 429);
    for (const name of names) {
      if (name === "epoch.json") continue;
      if (!/^[0-9a-f]{32}\.json$/.test(name)) throw new AttachmentError("restore receipt store invalid", 409);
      const path = join(parent, name), raw = this.read(path);
      if (!isDict(raw)) throw new AttachmentError("restore receipt invalid", 409);
      const candidate = Object.fromEntries(["restoreId", "root", "sessionId", "messageIndex", "revision", "restoreEpoch"].map((k) => [k, raw[k]]));
      if (candidate.root !== ident.root || candidate.sessionId !== ident.sessionId || candidate.restoreId !== name.slice(0, -5)) throw new AttachmentError("restore receipt ownership mismatch", 409);
      const r = this.load(candidate)!; if (r.status === "aborted" && r.cleanupComplete === true) settled.push(path);
    }
    if (settled.length) {
      if (epoch >= Number.MAX_SAFE_INTEGER) throw new AttachmentError("restore epoch exhausted", 429);
      epoch++; this.files.writeJson(join(parent, "epoch.json"), { root: ident.root, sessionId: ident.sessionId, restoreEpoch: epoch });
      for (const path of settled) unlinkSync(path); this.files.syncDirectory(parent);
    }
    return epoch;
  }
  save(ident: Row, record: Row, fresh = false): void {
    const path = this.path(ident);
    if (fresh && !existsSync(path)) {
      if (this.epoch(ident) !== ident.restoreEpoch) throw new AttachmentError("restore epoch changed; request a new ticket", 409);
      if (readdirSync(dirname(path)).filter((n) => n.endsWith(".json") && n !== "epoch.json").length >= MAX_RECEIPTS) {
        this.retire(ident);
        if (this.epoch(ident) !== ident.restoreEpoch) throw new AttachmentError("restore epoch changed; request a new ticket", 409);
        throw new AttachmentError("restore receipt capacity exhausted; unresolved ownership is retained", 429);
      }
    }
    if (pyEncodeUtf8(pyJsonDumps(record, { ensureAscii: false })).length > MAX_BYTES) throw new AttachmentError("restore receipt exceeds bounded size", 413);
    this.files.writeJson(path, record);
  }
  begin(ident: Row, result: Row): Row {
    if (this.load(ident)) throw new AttachmentError("restore request already admitted; query its receipt", 409);
    const record = { ...ident, status: "preparing", refs: result.refs.map((r: Row) => r.id), result }; this.save(ident, record, true); return record;
  }
}
export function replayRestore(record: Row): Row {
  if (record.status !== "committed") throw new AttachmentError("restore request aborted or outcome unknown; query original restoreId", 409);
  const r = record.result;
  if (!isDict(r) || r.root !== record.root || typeof r.text !== "string" || pyLen(r.text) > 50000 || !Array.isArray(r.refs) || r.refs.length !== record.refs.length || r.refs.some((ref, i) => !isDict(ref) || ref.id !== record.refs[i])) throw new AttachmentError("restore result unavailable", 409);
  return r;
}
export async function restoreEpoch(files: AttachmentFiles, data: unknown): Promise<Row> {
  attachmentKeys(data, ["root", "session_id"], "restore epoch");
  const sid = sessionSelection(data.session_id), session = await restoreSession(files, sid);
  if (!session) throw new AttachmentError("session not found", 404);
  const root = await files.root(session.root);
  if (Object.hasOwn(data, "root") && await files.root(data.root) !== root) throw new AttachmentError("workspace root not permitted");
  const ident = { root, sessionId: sid, restoreId: "0".repeat(32) };
  return files.transaction(async () => ({ root, sessionId: sid, restoreEpoch: new RestoreReceipts(files, await files.scope(root, sid)).retire(ident) }));
}
export async function restoreOperation(files: AttachmentFiles, data: unknown, abort = false): Promise<Row> {
  attachmentKeys(data, ["root", "session_id", "restoreId", "messageIndex", "revision", "restoreEpoch"], "restore receipt");
  const sid = sessionSelection(data.session_id); if (!sid) throw new AttachmentError("restore receipt requires session");
  const session = await restoreSession(files, sid), deleted = !session;
  if (deleted && typeof data.root !== "string") throw new AttachmentError("original restore root required for cleanup");
  const root = await files.root(session ? session.root : data.root);
  if (Object.hasOwn(data, "root") && await files.root(data.root) !== root) throw new AttachmentError("workspace root not permitted");
  const ident = restoreIdentity(root, sid, data);
  return files.transaction(async () => {
    const directory = deleted ? join(files.base(), files.scopeName(root, sid)) : await files.scope(root, sid);
    if (isLink(directory)) throw new AttachmentError("attachment store unavailable");
    const receipts = new RestoreReceipts(files, directory), current = receipts.epoch(ident, !deleted); let r = receipts.load(ident);
    if (!r && ident.restoreEpoch < current) return { ...ident, status: "aborted", cleanupComplete: true };
    if (!r && ident.restoreEpoch > current) throw new AttachmentError("restore epoch is not current", 409);
    if (abort) {
      const fresh = r === null; r = r ? { ...r, status: "aborted", cleanupComplete: false } : { ...ident, status: "aborted", refs: [], cleanupComplete: false };
      receipts.save(ident, r, fresh);
      for (const token of r.refs) {
        const path = files.path(directory, token);
        if (existsSync(path)) {
          const staged = files.readJson(path);
          if (staged.restoreId !== ident.restoreId || staged.id !== token || staged.root !== root || staged.session_id !== sid) throw new AttachmentError("restore cleanup ownership mismatch", 409);
        }
        if (existsSync(directory)) await files.remove(directory, token);
      }
      if (existsSync(directory)) files.syncDirectory(directory);
      r.cleanupComplete = true; receipts.save(ident, r);
    }
    if (!r) return { ...ident, status: "unknown" };
    return { ...ident, status: r.status, cleanupComplete: r.cleanupComplete ?? false, ...(deleted ? { cleanupOnly: true } : r.status === "committed" ? { result: replayRestore(r) } : {}) };
  });
}
