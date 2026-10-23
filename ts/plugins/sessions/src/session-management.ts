import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyJsonLoads, pyLen, pyStrip, pyUtcIsoformat, pyUtcNow, PyValueError } from "@xueness/contracts";
import { isLink, readRegularBytes, type Session, type SessionStore } from "@xueness/sessions";
type Dict = Record<string, unknown>;
export const isoTimestamp = pyUtcNow;
const fileTimestamp = (path: string): string => {
  const s = statSync(path), seconds = s.mtimeMs / 1000, whole = Math.floor(seconds);
  return pyUtcIsoformat(BigInt(whole) * 1000000n + BigInt(Math.round((seconds - whole) * 1000000)));
};
export function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw new PyValueError("title must be 1..120 characters");
  const title = pyStrip(value);
  if (!title || pyLen(title) > 120 || /[\x00-\x1f\x7f]/.test(title)) throw new PyValueError("title must be 1..120 printable characters");
  return title;
}
export async function renameSession(store: SessionStore, sid: string, title: string): Promise<Session> {
  return store.update(sid, (session) => {
    const previous = session.title || session.task;
    if (previous !== title) {
      const history = (session.management_history ??= []) as Dict[];
      history.push({ action: "renamed", at: isoTimestamp(), previous_title: previous, title });
    }
    const changed = session.title !== title || session.title_source !== "manual";
    if (changed) { session.title = title; session.title_source = "manual"; }
    return changed;
  });
}
export async function pinSession(store: SessionStore, sid: string, pinned: boolean): Promise<Session> {
  const session = await store.load(sid);
  session.pinned = pinned;
  ((session.management_history ??= []) as Dict[]).push({ action: pinned ? "pinned" : "unpinned", at: isoTimestamp() });
  await store.save(session); return session;
}
export async function listSummaries(store: SessionStore): Promise<Dict[]> {
  const result: Dict[] = [];
  for (const summary of await store.list()) {
    const session = await store.load(String(summary.id));
    const updatedAt = fileTimestamp(store.pathFor(summary.id));
    result.push({ ...summary, title: session.title || session.task, pinned: session.pinned === true, root: session.root ?? "", updatedAt });
  }
  return result;
}
export function listArchived(store: SessionStore): Dict[] {
  const dir = join(store.directory, "deleted-sessions");
  if (isLink(dir) || !existsSync(dir)) return [];
  const result: Dict[] = [];
  for (const name of readdirSync(dir).sort().filter((n) => /^[a-f0-9]{32}\.json$/.test(n))) {
    const path = join(dir, name); if (isLink(path)) continue;
    try {
      const raw = readRegularBytes(path), session = pyJsonLoads(pyDecodeUtf8(raw));
      if (!isDict(session) || session.id !== name.slice(0, -5)) continue;
      let archivedAt: unknown = null;
      for (const item of (session.management_history || []) as unknown[]) if (isDict(item) && item.action === "deleted" && typeof item.at === "string") archivedAt = item.at;
      archivedAt ??= fileTimestamp(path);
      result.push({ id: session.id, task: session.task ?? "", title: session.title || session.task || "", archivedAt, revision: createHash("sha256").update(raw).digest("hex") });
    } catch { /* Untrusted archive entries are omitted. */ }
  }
  return result.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt))).slice(0, 200);
}
