/** Bounded transcript search, without creating a second private journal index. */
import { lstatSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDict, pyCasefold, pyLen, pyStr, pyStrip, pySubstring, PyValueError } from "@xueness/contracts";
import { isPyOSError } from "@xueness/sessions";
import { readPublished, timestamp } from "./published-read.ts";
import { validateWorkspace } from "./queue-http.ts";
import type { SessionReply, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
export const SEARCH_ROUTES = ["GET /api/sessions/search"];
export function visibleMessageText(message: unknown): string { if (!isDict(message) || !["user", "assistant"].includes(String(message.role))) return ""; return typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((v) => isDict(v) && v.type === "text" && typeof v.text === "string").map((v) => v.text).join("\n") : ""; }
function snippet(text: string, needle: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), match = new RegExp(escaped, "iu").exec(text), offset = match ? pyLen(text.slice(0, match.index)) : 0, start = Math.max(0, offset - 70), end = Math.min(pyLen(text), Math.max(start + 220, offset + pyLen(needle)));
  return (start ? "…" : "") + pySubstring(text, start, end).split(/[\s\u0085\u001c-\u001f]+/u).filter(Boolean).join(" ") + (end < pyLen(text) ? "…" : "");
}
export function matchConversation(s: Row, needle: string): Row | null {
  const hiddenRaw = s.history_hidden_message_ids ?? [], hidden = Array.isArray(hiddenRaw) && hiddenRaw.every((id) => typeof id === "string" && id) ? new Set(hiddenRaw) : null;
  for (const key of ["messages", "archived_messages"]) { const messages = Array.isArray(s[key]) ? s[key] : [];
    for (let index = messages.length - 1; index >= 0; index--) { const m = messages[index]; if (key === "archived_messages" && (!hidden || hidden.has(isDict(m) ? m._message_id : null))) continue; const text = visibleMessageText(m); if (text && pyCasefold(text).includes(pyCasefold(needle))) return { snippet: snippet(text, needle), messageIndex: index, role: m.role, compacted: key === "archived_messages" }; }
  }
  return null;
}
export async function searchPage(o: SessionsApiOptions, needle: string, after = ""): Promise<Row> {
  o.store.pathFor("0".repeat(32)); const ids = readdirSync(o.store.directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name) && name.slice(0, -5) > after).sort(), deadline = performance.now() + 200, matches: Row[] = [];
  let scanned = 0, skipped = 0, size = 0, cursor: string | null = null;
  for (const [index, name] of ids.entries()) {
    if (scanned && (scanned >= 32 || size >= 16 * 1024 * 1024 || matches.length >= 20 || performance.now() >= deadline)) { cursor = ids[index - 1]!.slice(0, -5); break; }
    scanned++; const sid = name.slice(0, -5);
    let s: Row, mtime: number;
    try { size += Math.min(lstatSync(o.store.pathFor(sid)).size, 16 * 1024 * 1024); const result = readPublished(o.store.directory, name, 8 * 1024 * 1024); if (!result || !isDict(result.value) || result.value.id !== sid) { skipped++; continue; } s = result.value; mtime = result.mtime; if (s.archived === true) continue; await validateWorkspace(o, s); }
    catch { skipped++; continue; }
    const hit = matchConversation(s, needle); if (!hit) continue;
    const updated = s.updated_at || timestamp(mtime);
    matches.push({ session: { id: sid, task: Array.from(pyStr(s.task ?? "")).slice(0, 5000).join(""), title: Array.from(pyStr(s.title ?? "")).slice(0, 500).join(""), root: s.root, status: pyStr(s.status ?? "pending"), updatedAt: typeof updated === "string" ? updated : "" }, ...hit });
  }
  return { query: needle, matches, nextCursor: cursor, scanned, skipped };
}
export function createSearchApi(o: SessionsApiOptions) {
  const owns = (_method: string, p: readonly string[]) => p.join("/") === "api/sessions/search";
  return { routes: SEARCH_ROUTES, owns,
    async dispatch(method: string, p: string[], query: Row): Promise<SessionReply | null> {
      if (!owns(method, p)) return null; if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }]; if (method !== "GET") return [405, { error: "method not allowed" }];
      if (Object.keys(query).some((k) => !["q", "after"].includes(k))) return [400, { error: "expected q and optional after" }];
      try { const one = (k: string): string => { const value = query[k] ?? [""]; if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") throw new PyValueError("invalid search parameters"); return value[0]; };
        const needle = pyStrip(one("q")), after = one("after"); if (pyLen(needle) < 1 || pyLen(needle) > 200 || /[\x00-\x1f]/.test(needle)) throw new PyValueError("query must be 1..200 characters"); if (after && !/^[0-9a-f]{32}$/.test(after)) throw new PyValueError("invalid search cursor"); return [200, await searchPage(o, needle, after)];
      } catch (e) { if (e instanceof PyValueError) return [400, { error: e.message }]; if (isPyOSError(e)) return [503, { error: "conversation search is temporarily unavailable" }]; throw e; }
    } };
}
