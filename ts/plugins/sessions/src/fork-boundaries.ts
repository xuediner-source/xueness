import { createHash } from "node:crypto";
import { isDict, pyDeepCopy, pyIsSpace, pyJsonDumps, pyLen, pySubstring } from "@xueness/contracts";
import { SYSTEM_PROMPT } from "@xueness/sessions";
import { pendingDenials } from "./public-session.ts";
import { canonicalForkMessage, ForkError, forkTruncation, MAX_PREFIX_BYTES, type Row } from "./fork-common.ts";
import { anchorForBoundary, stableAnchorId } from "./stable-boundaries.ts";
const encoded = (v: unknown) => pyLen(pyJsonDumps(v, { ensureAscii: false, separators: [",", ":"] }));
function sameTurnInput(message: Row): boolean {
  return message.role === "user" && (message._input_kind === "guide"
    || message._input_kind === "background_notice" && message._meta_source === "task_status");
}
export function forkBoundaries(s: Row, revision: string): Row {
  const messages = s.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 5000) throw new ForkError("session messages are invalid or exceed fork limits", 413);
  if (s.results != null && !isDict(s.results)) throw new ForkError("session results are invalid");
  const results = isDict(s.results) ? s.results : {}, allCalls = new Set<string>(), completed: Row = Object.create(null), boundaries: Row[] = [], copied: Row[] = [];
  let active: Row | null = null, pending = new Map<string, Row>(), turn = 0, total = 0, cost = encoded({ role: "system", content: SYSTEM_PROMPT }) + 2;
  let copyable = true, boundariesTruncated = false, unclosed = false, awaiting = false;
  if (!isDict(messages[0]) || messages[0].role !== "system") throw new ForkError("session does not begin with a system message");
  for (const [index, raw] of messages.entries()) {
    if (!isDict(raw)) { unclosed = true; break; }
    const message = canonicalForkMessage(raw), role = message.role;
    if (role === "system") continue;
    const size = encoded(message);
    if (copyable) { if (cost + size + 1 <= MAX_PREFIX_BYTES) { copied.push(message); cost += size + 1; } else { copyable = false; boundariesTruncated = true; } }
    if (role === "user") {
      if (sameTurnInput(message)) continue;
      const answer = awaiting && !pending.size && message.content.startsWith("Operator answer: ");
      if (active !== null && !answer) { unclosed = true; break; }
      turn++; active = message; pending = new Map(); awaiting = false; continue;
    }
    if (!active) { unclosed = true; break; }
    if (role === "assistant") {
      const calls = message.tool_calls ?? [];
      if (calls.length) {
        if (pending.size) { unclosed = true; break; }
        total += calls.length; if (total > 2000) throw new ForkError("session tool call count exceeds fork limit", 413);
        for (const c of calls) { if (allCalls.has(c.id)) { unclosed = true; break; } allCalls.add(c.id); pending.set(c.id, c); }
        if (unclosed) break; continue;
      }
      if (pending.size) { unclosed = true; break; }
      const prefixResults = Object.fromEntries(Object.keys(completed).filter((id) => Object.hasOwn(results, id)).map((id) => [id, pyDeepCopy(results[id])]));
      if (copyable && !pendingDenials({ messages: [{ role: "system", content: SYSTEM_PROMPT }, ...copied], results: prefixResults }).length) {
        const token = "fb1-" + createHash("sha256").update(`xueness-fork-v1\0${revision}\0${index}\0${turn}`).digest("hex");
        const preview = Array.from(String(active.content || ""), (ch) => pyIsSpace(ch.charCodeAt(0)) ? " " : ch).join("").replace(/ +/g, " ").trim();
        boundaries.push({ token, turn, endIndex: index, preview: pySubstring(preview, 0, 240) });
      }
      active = null; pending = new Map(); continue;
    }
    const id = message.tool_call_id;
    if (!pending.has(id) || Object.hasOwn(completed, id) || !isDict(results[id])) { unclosed = true; break; }
    try { if (encoded(results[id]) > 2_000_000) throw new ForkError("tool result exceeds fork limits", 413); }
    catch (e) { if (e instanceof ForkError) throw e; unclosed = true; break; }
    completed[id] = results[id]; if (pending.get(id)!.function.name === "ask_user" && results[id].awaiting_user === true) awaiting = true; pending.delete(id);
  }
  if (active || pending.size) unclosed = true;
  const last = messages.findLastIndex((m) => isDict(m) && m.role !== "system" && !sameTurnInput(m));
  if (s.status === "running" && boundaries.length && boundaries.at(-1)!.endIndex === last) { boundaries.pop(); unclosed = true; }
  const [historyTruncated, truncationReason] = forkTruncation(s, messages);
  const offered = boundaries.map((boundary) => {
    const anchor = anchorForBoundary(s, boundary);
    return anchor ? { ...boundary, anchorId: stableAnchorId(anchor) } : boundary;
  });
  return { sourceId: s.id, revision, boundaries: offered, historyTruncated, truncationReason, hasUnclosedTurn: unclosed, boundariesTruncated,
    boundaryLimitReason: boundariesTruncated ? "Some later closed turns exceed the fork transcript size limit and are not offered." : null,
    unclosedReason: unclosed ? "The current tail has no complete user turn; only earlier closed turns can be forked." : null };
}
