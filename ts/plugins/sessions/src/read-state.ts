import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, isPyIntValue, JsonFloat, numericValue, pyDecodeUtf8, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { isLink, readRegularBytes, type SessionStore } from "@xueness/sessions";
import { archiveSession, privateJson } from "./archive.ts";
import { pendingDenials, type PublicSessionOptions } from "./public-session.ts";
type Row = Record<string, unknown>;
function markerPath(store: SessionStore, sid: string, create = false): string {
  store.pathFor(sid); const directory = join(store.directory, ".xueness-session-read");
  if (isLink(directory)) throw new PyValueError("session read state directory is a symbolic link");
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  return join(directory, sid + ".json");
}
function readState(store: SessionStore, sid: string): { through: bigint; at: number } | null {
  try {
    const path = markerPath(store, sid); if (isLink(path)) return null;
    const v = pyJsonLoads(pyDecodeUtf8(readRegularBytes(path)), { lossless: true });
    if (!isDict(v) || !isPyIntValue(v.readThroughMtimeNs) || BigInt(v.readThroughMtimeNs) < 0n || typeof v.viewedAt === "boolean") return null;
    const at = numericValue(v.viewedAt); if (at === null || at < 0) return null;
    return { through: BigInt(v.readThroughMtimeNs), at };
  } catch { return null; }
}
export async function markViewed(store: SessionStore, sid: string, observed?: bigint): Promise<void> {
  const lease = await store.lease(sid);
  try {
    const current = statSync(store.pathFor(sid), { bigint: true }).mtimeNs;
    if (observed !== undefined && observed !== current) return;
    const now = Date.now() / 1000, previous = readState(store, sid);
    if (previous && previous.through === current && now - previous.at < 60) return;
    const path = markerPath(store, sid, true); if (isLink(path)) throw new PyValueError("session read state is a symbolic link");
    privateJson(path, { readThroughMtimeNs: current, viewedAt: new JsonFloat(now) });
  } finally { await lease.release(); }
}
export async function archiveStale(store: SessionStore, days: number, options: { running?: ReadonlySet<string>; toolInfo?: PublicSessionOptions["toolInfo"] } = {}): Promise<string[]> {
  if (![3, 7, 14, 30].includes(days)) throw new PyValueError("invalid task auto-archive retention");
  const cutoff = Date.now() / 1000 - days * 86400, cutoffNs = BigInt(Math.trunc(cutoff * 1e9)), archived: string[] = [];
  let names: string[]; try { names = readdirSync(store.directory).filter((n) => /^[0-9a-f]{32}\.json$/.test(n)).sort(); } catch { return []; }
  const candidate = async (sid: string): Promise<boolean> => {
    if (options.running?.has(sid)) return false;
    const path = store.pathFor(sid); if (statSync(path, { bigint: true }).mtimeNs > cutoffNs) return false;
    const s = await store.load(sid), read = readState(store, sid);
    if (s.status !== "completed" || s.pinned === true || s.pending_question || !read || read.through < statSync(path, { bigint: true }).mtimeNs || read.at > cutoff) return false;
    try { return pendingDenials(s, options).length === 0; } catch { return false; }
  };
  for (const name of names) {
    const sid = name.slice(0, -5);
    try {
      if (isLink(join(store.directory, name)) || !await candidate(sid)) continue;
      const lease = await store.lease(sid);
      try { if (!await candidate(sid)) continue; await archiveSession(store, sid); archived.push(sid); const marker = markerPath(store, sid); if (!isLink(marker) && existsSync(marker)) unlinkSync(marker); }
      finally { await lease.release(); }
    } catch { /* Locked, malformed or unread sessions remain live. */ }
  }
  return archived;
}
