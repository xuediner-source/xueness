/** Read-only sidebar rows: bounded handles, no Store.load/recovery or read marks. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { isDict, pyEncodeUtf8, pyJsonDumps } from "@xueness/contracts";
import { isLink, isPyOSError } from "@xueness/sessions";
import { readPublished } from "./published-read.ts";
import { indexRow } from "./index-rows.ts";
import type { SessionReply, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
export const SESSIONS_INDEX_ROUTES = ["GET /api/sessions/index"];
const DEFAULT_TOOLS: Record<string, string[]> = { files: ["read", "list", "glob", "grep", "write", "edit"], shell: ["exec", "exec_start", "exec_poll"], planning: ["goal_read", "todo_read", "todo_write", "ask_user"], sessions: ["read_session_context", "read_state"], subagents: ["task", "task_resume", "task_status", "task_result", "task_cancel"], mcp: ["mcp"] };
function paths(o: SessionsApiOptions): string[] {
  if (isLink(o.store.directory)) return [];
  const rows: { name: string; mtime: bigint }[] = [];
  try { for (const name of readdirSync(o.store.directory).slice(0, 400)) if (/^[0-9a-f]{32}\.json$/.test(name)) { try { const info = lstatSync(o.store.pathFor(name.slice(0, -5)), { bigint: true }); if (info.isFile() && !info.isSymbolicLink() && info.size <= 512n * 1024n) rows.push({ name, mtime: info.mtimeNs }); } catch { /* Invalid entries do not become rows. */ } } } catch { return []; }
  return rows.sort((a, b) => a.mtime > b.mtime ? -1 : a.mtime < b.mtime ? 1 : a.name > b.name ? -1 : a.name < b.name ? 1 : 0).slice(0, 200).map((r) => r.name);
}
export async function sessionsIndex(o: SessionsApiOptions): Promise<Row | null> {
  const tools = new Set((o.indexTools?.() ?? Object.entries(DEFAULT_TOOLS).flatMap(([owner, names]) => names.map((name) => ({ owner, name })))).filter((t) => o.enabled(t.owner)).map((t) => t.name)), rows: Row[] = []; let remaining = 4 * 1024 * 1024;
  for (const name of paths(o)) {
    if (remaining <= 0) break;
    try { const sid = name.slice(0, -5); o.store.pathFor(sid); const r = readPublished(o.store.directory, name, Math.min(512 * 1024, remaining)); if (!r) continue; remaining -= r.size;
      if (!isDict(r.value) || r.value.id !== sid) continue;
      if (o.enabled("remote") && r.value.remote_connection && !o.indexRemoteSummary) return null;
      const row = indexRow(o.store, r.value, r.mtime, r.mtimeNs, o.enabled, tools); if (!row) continue;
      const remote = o.enabled("remote") ? await o.indexRemoteSummary?.(r.value) : null; if (remote != null) row.remote = row.sidecar.remote = remote; rows.push(row);
    } catch { /* Polling never repairs or exposes a malformed private journal. */ }
  }
  const workspaceId = typeof o.projectDir === "string" && o.projectDir.length <= 4096 && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(o.projectDir) ? o.projectDir || "local" : "local";
  return { protocolVersion: 1, workspaceId, logEpoch: createHash("sha256").update(pyEncodeUtf8(pyJsonDumps(rows, { sortKeys: true, separators: [",", ":"] }))).digest("hex").slice(0, 32), sessions: rows };
}
export function createSessionsIndexApi(o: SessionsApiOptions) {
  const owns = (_method: string, p: readonly string[]) => p.join("/") === "api/sessions/index";
  return { routes: SESSIONS_INDEX_ROUTES, owns,
    async dispatch(method: string, p: string[], query: Row): Promise<SessionReply | null> {
      if (!owns(method, p)) return null; if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }]; if (method !== "GET") return [405, { error: "method not allowed" }]; if (Object.keys(query).length) return [400, { error: "sessions-index does not accept query parameters" }];
      try { const result = await sessionsIndex(o); return result === null ? null : [200, result]; } catch (e) { if (isPyOSError(e)) return [503, { error: "sessions index is temporarily unavailable" }]; throw e; }
    } };
}
