/** Selected transcript sharing carries text only; imports receive fresh execution state. */
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pySlice, pyStrip, pyUtcNow, PyValueError, uuid4Hex } from "@xueness/contracts";
import { fsyncDirectory, isLink, isPyOSError, isPyValueError, protectPrivateDirectory, pyExceptionName, readRegularBeneath, realish, SYSTEM_PROMPT } from "@xueness/sessions";
import { privateJson } from "./archive.ts";
import { messageRevision } from "./journal-http.ts";
import { displayRows } from "./snapshot-rows.ts";
import { validateTitle } from "./session-management.ts";
import type { SessionReply, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
const SCHEMA = "xueness.conversation-share.v1", MAX_BYTES = 4 * 1024 * 1024;
export const SHARING_ROUTES = ["GET /api/sessions/:id/share", "POST /api/sessions/:id/share", "GET /api/conversation_shares/:id", "DELETE /api/conversation_shares/:id", "POST /api/conversation_shares/:id/import"];
function sharePath(o: SessionsApiOptions, id: string): string {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new PyValueError("invalid conversation share id");
  const directory = join(o.stateDir, "conversation_shares"); if (isLink(o.stateDir) || isLink(directory)) throw new PyValueError("invalid conversation share directory"); const path = join(directory, id + ".json"); if (isLink(path)) throw new PyValueError("invalid conversation share file"); return path;
}
function readShare(o: SessionsApiOptions, id: string): Row {
  const path = sharePath(o, id), info = lstatSync(path); if (!info.isFile() || info.size > MAX_BYTES) throw new PyValueError("invalid conversation share file"); const read = readRegularBeneath(o.stateDir, `conversation_shares/${id}.json`, MAX_BYTES + 1); if (!read || read.size > MAX_BYTES || read.raw.length > MAX_BYTES) throw new PyValueError("invalid conversation share file"); const raw = read.raw;
  const value = pyJsonLoads(pyDecodeUtf8(raw), { lossless: true }); if (!isDict(value) || value.schema !== SCHEMA || value.id !== id || !Array.isArray(value.rows)) throw new PyValueError("invalid conversation share"); return value;
}
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.filter((v) => isDict(v) && v.type === "text" && typeof v.text === "string").map((v) => v.text).join("\n") : "";
export function sharingRows(s: Row): Row[] {
  const rows: Row[] = []; let turn = 0;
  for (const [index, [message]] of displayRows(s, false).entries()) { if (!isDict(message) || !["user", "assistant"].includes(String(message.role))) continue; if (message.role === "user" && message._input_kind !== "guide") turn++; const content = text(message.content); if (content) rows.push({ id: message._message_id || `message-${index}`, turnId: message._turn_id || `turn-${Math.max(1, turn)}`, role: message.role, text: content }); }
  return rows;
}
async function publish(o: SessionsApiOptions, sid: string, data: Row): Promise<SessionReply> {
  if (Object.keys(data).some((k) => !["title", "turn_ids", "expected_revision"].includes(k))) throw new PyValueError("unsupported conversation share field");
  const s = await o.store.load(sid); if (data.expected_revision !== messageRevision(s)) return [409, { error: "conversation changed; review the selected messages again" }];
  let rows = sharingRows(s); const turns = data.turn_ids;
  if (turns != null) { const valid = new Set(rows.map((r) => r.turnId)); if (!Array.isArray(turns) || !turns.length || turns.length > 500 || turns.some((t) => typeof t !== "string" || !/^turn-[1-9][0-9]*$/.test(t) || !valid.has(t))) throw new PyValueError("invalid selected conversation turns"); const selected = new Set(turns); rows = rows.filter((r) => selected.has(r.turnId)); }
  if (!rows.length || rows.length > 2000) throw new PyValueError("select 1..2000 conversation messages");
  const title = validateTitle(data.title || s.title || pySlice(String(s.task), 120)), id = uuid4Hex(), record = { schema: SCHEMA, id, title, rows, createdAt: pyUtcNow() };
  if (pyEncodeUtf8(pyJsonDumps(record)).length > MAX_BYTES) throw new PyValueError("selected conversation is too large to share");
  const path = sharePath(o, id), directory = join(path, ".."); mkdirSync(directory, { recursive: true, mode: 0o700 }); protectPrivateDirectory(directory); privateJson(path, record, false); fsyncDirectory(directory);
  return [201, { id, url: "/share/" + id, title }];
}
async function importShare(o: SessionsApiOptions, id: string, data: Row): Promise<SessionReply> {
  if (Object.keys(data).some((k) => !["root", "title"].includes(k))) throw new PyValueError("unsupported conversation import field"); const record = readShare(o, id); let root: string;
  if (Object.hasOwn(data, "root")) { if (typeof data.root !== "string" || !pyStrip(data.root)) throw new PyValueError("workspace root must be a path"); root = realish(data.root); const allowed = [o.webRuns, o.projectDir, ...(o.allowedRoots?.() ?? [])].map(realish); if (!allowed.some((base) => { const rel = relative(base, root); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); })) throw new PyValueError("workspace root not permitted"); }
  else { const workspace = o.lifecycle?.settings?.().workspace; root = o.defaultRoot?.() ?? (o.enabled("settings") && isDict(workspace) && typeof workspace.defaultRoot === "string" && existsSync(workspace.defaultRoot) ? realish(workspace.defaultRoot) : realish(o.projectDir)); }
  const title = validateTitle(data.title || record.title), s = await o.store.new(title, root);
  if (root === realish(o.webRuns)) { root = join(root, String(s.id)); mkdirSync(root, { recursive: true }); s.root = root; }
  const messages = record.rows.filter((r: unknown) => isDict(r) && ["user", "assistant"].includes(String(r.role)) && typeof r.text === "string").map((r: Row) => ({ role: r.role, content: r.text }));
  if (!messages.length || messages[0]!.role !== "user") messages.unshift({ role: "user", content: title });
  Object.assign(s, { messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages], status: "paused", title, task: messages[0]!.content, imported_share: { id, title }, title_source: "manual" }); await o.store.save(s); return [201, { id: s.id }];
}
export function createSharingApi(o: SessionsApiOptions) {
  const owns = (method: string, p: readonly string[]) => p[0] === "api" && (p[1] === "sessions" && p.length === 4 && p[3] === "share" && ["GET", "POST"].includes(method) || p[1] === "conversation_shares" && [3, 4].includes(p.length));
  return { routes: SHARING_ROUTES, owns,
    async dispatch(method: string, p: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      if (!owns(method, p)) return null; if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      try {
        if (p[1] === "sessions" && method === "GET") { const s = await o.store.load(p[2]!), rows = sharingRows(s); if (rows.length > 2000 || pyEncodeUtf8(pyJsonDumps(rows)).length > MAX_BYTES) return [400, { error: "conversation is too large to share" }]; return [200, { title: s.title || s.task, rows, message_revision: messageRevision(s) }]; }
        if (p[1] === "sessions" && method === "POST") return await publish(o, p[2]!, isDict(data) ? data : {});
        if (p.length === 3 && method === "GET") return [200, readShare(o, p[2]!)];
        if (p.length === 3 && method === "DELETE") { const path = sharePath(o, p[2]!); readShare(o, p[2]!); unlinkSync(path); fsyncDirectory(join(path, "..")); return [200, { id: p[2], revoked: true }]; }
        if (p.length === 4 && p[3] === "import" && method === "POST") return await importShare(o, p[2]!, isDict(data) ? data : {});
        return [405, { error: "method not allowed" }];
      } catch (e) { if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "conversation share not found or revoked" }]; if (isPyOSError(e) || isPyValueError(e)) return [400, { error: "invalid conversation share request" }]; throw e; }
    } };
}
