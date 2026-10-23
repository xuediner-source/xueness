import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isDict, isPyIntValue, pyDecodeUtf8, pyJsonLoads, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { isLink, type SessionStore } from "@xueness/sessions";
import { messageRefs } from "./media-history.ts";
export type Row = Record<string, any>;
export class ForkError extends PyValueError { override name = "ForkError"; readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export const MAX_PREFIX_BYTES = 4 * 1024 * 1024;
export function validForkText(value: unknown, limit: number): value is string { return typeof value === "string" && pyLen(value) <= limit && !!pyStrip(value) && !/[\x00-\x1f\x7f]/.test(value); }
export function readForkSnapshot(store: SessionStore, sid: string): [Row, string] {
  const path = store.pathFor(sid), max = 16 * 1024 * 1024;
  if (isLink(path)) throw new ForkError("session file is a symbolic link");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ForkError("session not found", 404); if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new ForkError("session file is a symbolic link"); throw e; }
  let raw: Buffer;
  try {
    const info = fstatSync(fd), current = lstatSync(path);
    if (!info.isFile() || isLink(path) || info.dev !== current.dev || info.ino !== current.ino) throw new ForkError("session file is not regular");
    if (info.size > max) throw new ForkError("session journal exceeds fork size limit", 413);
    const chunks: Buffer[] = []; let size = 0;
    while (size <= max) { const part = Buffer.allocUnsafe(Math.min(1024 * 1024, max + 1 - size)), n = readSync(fd, part, 0, part.length, null); if (!n) break; chunks.push(part.subarray(0, n)); size += n; }
    raw = Buffer.concat(chunks); if (raw.length > max) throw new ForkError("session journal exceeds fork size limit", 413);
  } finally { closeSync(fd); }
  let s: unknown; try { s = pyJsonLoads(pyDecodeUtf8(raw), { lossless: true }); } catch { throw new ForkError("session journal is invalid JSON"); }
  if (!isDict(s) || s.id !== sid) throw new ForkError("session journal is invalid");
  if (typeof s.task !== "string" || !pyStrip(s.task) || pyLen(s.task) > 5000 || !validForkText(s.root, 4096)) throw new ForkError("session task or workspace is invalid");
  if (!Array.isArray(s.messages) || s.messages.length > 5000) throw new ForkError("session message count exceeds fork limit", 413);
  if (s.results != null && !isDict(s.results)) throw new ForkError("session results are invalid");
  return [s, "sha256:" + createHash("sha256").update(raw).digest("hex")];
}
export function canonicalForkMessage(message: Row): Row {
  const role = message.role, content = message.content;
  if (!["system", "user", "assistant", "tool"].includes(role)) throw new ForkError("session contains an unsupported message role");
  if (content != null && (typeof content !== "string" || pyLen(content) > 2_000_000)) throw new ForkError("session message content exceeds fork limits", 413);
  if (["system", "user", "tool"].includes(role) && typeof content !== "string") throw new ForkError("session message content is invalid");
  if (role === "system") return { role, content };
  const identity: Row = {};
  for (const key of ["_message_id", "_turn_id"] as const) if (typeof message[key] === "string") identity[key] = message[key];
  if (role === "user") {
    const refs = messageRefs(message), markers: Row = { ...identity };
    if (["guide", "background_notice", "summary"].includes(String(message._input_kind))) markers._input_kind = message._input_kind;
    if (message._meta_source === "task_status") markers._meta_source = message._meta_source;
    if (typeof message._background_task_notice === "string") markers._background_task_notice = message._background_task_notice;
    for (const key of ["_semantic_summary", "_compact_summary", "_summary"] as const) if (message[key] === true) markers[key] = true;
    return { role, content, ...markers, ...(refs.length ? { _media_refs: refs } : {}) };
  }
  if (role === "tool") { if (!validForkText(message.tool_call_id, 200)) throw new ForkError("session tool result has an invalid call id"); return { role, tool_call_id: message.tool_call_id, content, ...identity }; }
  const clean: Row = { role, content: typeof content === "string" ? content : "", ...identity }, calls = message.tool_calls;
  if (calls != null) {
    if (!Array.isArray(calls) || calls.length > 64) throw new ForkError("session tool call list exceeds fork limits", 413);
    if (calls.length) clean.tool_calls = calls.map((c: unknown) => {
      if (!isDict(c) || c.type !== "function") throw new ForkError("session contains an invalid tool call");
      const f = c.function;
      if (!validForkText(c.id, 200) || !isDict(f) || !validForkText(f.name, 256) || typeof f.arguments !== "string" || pyLen(f.arguments) > 250000) throw new ForkError("session contains an invalid tool call");
      let args: unknown; try { args = pyJsonLoads(f.arguments || "{}"); } catch { throw new ForkError("session tool call arguments are invalid JSON"); }
      if (!isDict(args)) throw new ForkError("session tool call arguments must be an object");
      return { id: c.id, type: "function", function: { name: f.name, arguments: f.arguments } };
    });
  }
  return clean;
}
export function forkTruncation(s: Row, messages: Row[]): [boolean, string | null] {
  const dropped = Array.isArray(s.compactions) && s.compactions.some((r: unknown) => isDict(r) && ["removed", "masked"].some((key) => isPyIntValue(r[key]) && Number(r[key]) > 0));
  const summary = messages.slice(1).some((m) => isDict(m) && m.role === "system" && (m._compact_summary === true || m._semantic_summary === true || typeof m.content === "string" && m.content.startsWith("Older history compacted;")));
  const truncated = !!(Array.isArray(s.archived_messages) && s.archived_messages.length || dropped || summary);
  return [truncated, truncated ? "Only the current retained messages are used. Compaction archives have no reliable cross-turn order, so archived messages and generated system summaries are omitted." : null];
}
