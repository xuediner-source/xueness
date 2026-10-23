/** Soft archives preserve journals; permanent deletion validates every retained copy first. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pyUtcNow, PyValueError } from "@xueness/contracts";
import { fsyncDirectory, isLink, mkstemp, protectPrivateFile, PyOSError, readRegularBytes, replaceFile, SessionStore, writeAll, type Session } from "@xueness/sessions";
import { retainedOwners } from "./media-history.ts";
import { MediaArtifactStore } from "./media-store.ts";
import { Owner } from "./media-owner.ts";
import { MessageQueue } from "./queue.ts";
import { SqliteSessionLibrary } from './sqlite-library.ts';
import { syncSessionLibrary } from './session-storage.ts';
type Row = Record<string, unknown>;
const missing = (message: string) => Object.assign(new PyOSError(message, "ENOENT"), { name: "FileNotFoundError" });
const conflict = (message: string) => Object.assign(new PyOSError(message, "EEXIST"), { name: "FileExistsError" });
export function privateJson(path: string, value: unknown, ensureAscii = true): void {
  const parent = join(path, ".."), temp = mkstemp(parent, ".session-meta-"); let fd: number | null = temp.fd;
  try { protectPrivateFile(fd); writeAll(fd, pyEncodeUtf8(pyJsonDumps(value, { ensureAscii }))); fsyncSync(fd); closeSync(fd); fd = null; replaceFile(temp.path, path); }
  finally { if (fd !== null) closeSync(fd); if (existsSync(temp.path)) unlinkSync(temp.path); }
}
function readSession(path: string): Session { return pyJsonLoads(pyDecodeUtf8(readRegularBytes(path)), { lossless: true }) as Session; }
function archiveDir(store: SessionStore): string { const path = join(store.directory, "deleted-sessions"); if (isLink(path)) throw new PyValueError("archive directory is a symbolic link or reparse point"); return path; }
export async function archiveSession(store: SessionStore, sid: string, stateDir = store.directory): Promise<Session> {
  const queue = new MessageQueue(store, { stateDir });
  return queue.locked(sid, async () => {
    const source = store.pathFor(sid), session = await store.load(sid), dir = archiveDir(store);
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const destination = join(dir, basename(source));
    if (existsSync(destination) || isLink(destination)) throw conflict("session archive already exists");
    const qpath = queue.path(sid); if (isLink(qpath) || existsSync(qpath) && !lstatSync(qpath).isFile()) throw new PyValueError("invalid message queue file");
    ((session.management_history ??= []) as Row[]).push({ action: "deleted", at: pyUtcNow() });
    await store.save(session); renameSync(source, destination);
    try { await queue.atomicSave(sid, { schema: 1, accepting: false, items: [] }); }
    catch (e) { try { renameSync(destination, source); } catch (rollback) { throw new PyOSError("queue cleanup failed and session archive rollback failed"); } throw e; }
    try { const marker = join(store.directory, ".xueness-session-read", `${sid}.json`); if (!isLink(marker) && existsSync(marker)) unlinkSync(marker); } catch { /* Auxiliary read marks are best effort. */ }
    return session;
  });
}
export async function restoreSession(store: SessionStore, sid: string): Promise<Session> {
  const live = store.pathFor(sid), dir = archiveDir(store), source = join(dir, basename(live));
  if (isLink(source) || !existsSync(source)) throw new PyValueError("session is not archived");
  if (existsSync(live) || isLink(live)) throw new PyValueError("a live session with this id already exists");
  const session = readSession(source);
  if (!isDict(session) || session.id !== sid) throw new PyValueError("invalid archived session identity");
  ((session.management_history ??= []) as Row[]).push({ action: "restored", at: pyUtcNow() });
  await new SessionStore(dir).save(session); renameSync(source, live); syncSessionLibrary(store, session); return session;
}
async function finishMediaDelete(store: SessionStore, sid: string, revision: string, path: string): Promise<void> {
  const v = readSession(path);
  if (v.id !== sid || v.revision !== revision) throw new PyValueError("media cleanup revision mismatch");
  if (!Array.isArray(v.owners)) throw new PyValueError("invalid media cleanup scope");
  const owners = v.owners.map((row: Row) => new Owner(String(row.kind), String(row.key), String(row.root), row.session_id as string | null));
  if (owners.some((o) => o.kind !== "message" || o.sessionId !== sid)) throw new PyValueError("invalid media cleanup scope");
  const media = new MediaArtifactStore(store.directory);
  for (const owner of owners) await media.release(owner);
  unlinkSync(path); fsyncDirectory(join(path, ".."));
}
/** Permanent deletion also drops the session's tool media and visualizations (best effort; links are left alone). */
export function removeSessionArtifacts(stateDir: string, sid: string): void {
  if (!/^[0-9a-f]{32}$/.test(sid)) return;
  new SqliteSessionLibrary(stateDir).delete(sid);
  for (const name of ["tool-media", "visualizations", 'file-history']) {
    const root = join(stateDir, name), path = join(root, sid);
    try { if (!isLink(root) && !isLink(path) && existsSync(path) && lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true }); } catch { /* Derived artifacts only. */ }
  }
  const events = join(stateDir, 'session-events');
  if (!isLink(events)) for (const suffix of ['.jsonl', '.lock']) {
    const path = join(events, sid + suffix);
    if (!isLink(path) && existsSync(path) && lstatSync(path).isFile()) unlinkSync(path);
  }
}
export async function deleteArchivedSession(store: SessionStore, sid: string, revision: string): Promise<void> {
  const live = store.pathFor(sid);
  if (!/^[0-9a-f]{64}$/.test(revision)) throw new PyValueError("invalid archived session revision");
  const dir = archiveDir(store), source = join(dir, basename(live)), cleanup = join(dir, `${sid}.media-release.json`);
  if (isLink(source)) throw new PyValueError("archived session is a symbolic link or reparse point");
  if (isLink(cleanup)) throw new PyValueError("media cleanup receipt is a symbolic link");
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    if (!existsSync(cleanup)) throw missing("archived session not found");
    await store.withJournalLock(sid, async () => { if (existsSync(live) || isLink(live)) throw conflict("session is live; media cleanup refused"); fsyncDirectory(dir); fsyncDirectory(store.directory); await finishMediaDelete(store, sid, revision, cleanup); }); removeSessionArtifacts(store.directory, sid); return;
  }
  const archived = new SessionStore(dir), queue = new MessageQueue(store, { stateDir: store.directory });
  await queue.locked(sid, () => store.withJournalLock(sid, () => archived.withJournalLock(sid, async () => {
    if (existsSync(live) || isLink(live)) throw conflict("session is live; archive deletion refused");
    const raw = readRegularBytes(source), session = pyJsonLoads(pyDecodeUtf8(raw), { lossless: true });
    if (!isDict(session) || session.id !== sid) throw new PyValueError("invalid archived session identity");
    if (createHash("sha256").update(raw).digest("hex") !== revision) throw conflict("archived session changed; refresh before deleting");
    const backups = [live + ".bak", source + ".bak"], histories = [join(store.directory, `${sid}.history.jsonl`), join(dir, `${sid}.history.jsonl`)];
    for (const path of histories) if (isLink(path) || existsSync(path) && !lstatSync(path).isFile()) throw new PyValueError("session history is not a regular file");
    const backupStates: Session[] = [];
    for (const path of backups) { if (isLink(path)) throw new PyValueError("session backup is a symbolic link or reparse point"); if (existsSync(path)) { const s = readSession(path); if (!isDict(s) || s.id !== sid) throw new PyValueError("invalid archived session backup identity"); backupStates.push(s); } }
    const owners = new Map(retainedOwners(session, histories, backupStates).map((o) => [o.token(), o]));
    if (existsSync(cleanup)) {
      const prior = readSession(cleanup);
      if (prior.id !== sid || !Array.isArray(prior.owners)) throw new PyValueError("invalid media cleanup identity");
      for (const row of prior.owners as Row[]) { const o = new Owner(String(row.kind), String(row.key), String(row.root), row.session_id as string | null); if (o.kind !== "message" || o.sessionId !== sid) throw new PyValueError("invalid media cleanup scope"); owners.set(o.token(), o); }
    }
    if (owners.size) privateJson(cleanup, { id: sid, revision, owners: [...owners.values()].map((o) => ({ kind: o.kind, key: o.key, root: o.root, session_id: o.sessionId })) });
    const q = queue.read(sid); q.withdrawals = []; await queue.atomicSave(sid, q);
    for (const path of [...backups, ...histories]) if (existsSync(path)) unlinkSync(path);
    unlinkSync(source); fsyncDirectory(dir); fsyncDirectory(store.directory);
    if (existsSync(cleanup)) await finishMediaDelete(store, sid, revision, cleanup);
  })));
  removeSessionArtifacts(store.directory, sid);
}
