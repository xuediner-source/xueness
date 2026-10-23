/** Display-only bounded stream facts; partial input never becomes tool intent. */
import { isDict, isPyIntValue, pyEquals, pyLen, pySlice } from "@xueness/contracts";
import type { AgentExtension } from "@xueness/agent";
import type { Session } from "@xueness/sessions";
type Row = Record<string, any>;
export interface ActivityOptions { enabled(id: string): boolean; toolOwner?: (name: string) => string | null; }
const INPUT = new Set(["read", "read_file", "read_text", "list", "glob", "grep", "exec", "exec_start", "exec_poll"]);
export function defaultActivityOwner(name: string): string | null {
  if (["read", "read_file", "read_text", "list", "glob", "grep", "write", "edit"].includes(name)) return "files";
  if (["exec", "exec_start", "exec_poll"].includes(name)) return "shell";
  if (["task", "task_status", "task_result", "task_cancel"].includes(name)) return "subagents";
  if (name === "mcp") return "mcp";
  if (name === "ask_user") return "planning";
  return null;
}
function activeTool(o: ActivityOptions, name: unknown): name is string {
  if (typeof name !== "string") return false;
  try { const owner = (o.toolOwner ?? defaultActivityOwner)(name); const dependencies: Record<string, string[]> = { browser: ["files"], subagents: ["files"], workflows: ["files", "shell"] }; return !!owner && o.enabled("sessions") && [owner, ...dependencies[owner] ?? []].every((id) => o.enabled(id)); }
  catch { return false; }
}
export function observeToolActivity(s: Session, streamId: string, fact: unknown, o: ActivityOptions): boolean {
  const stream = isDict(s.streaming) ? s.streaming : {};
  if (typeof streamId !== "string" || !streamId || pyLen(streamId) > 128 || s.status !== "running" || stream.id !== streamId || stream.status !== "streaming" || stream.tool_input_closed === true || !isDict(fact)) return false;
  const index = fact.index, name = fact.name, turn = s.active_turn_id;
  if (!isPyIntValue(index) || Number(index) < 0 || Number(index) >= 32 || typeof name !== "string" || !name || pyLen(name) > 128 || !activeTool(o, name) || typeof turn !== "string" || !turn || pyLen(turn) > 128) return false;
  const rows = (Array.isArray(s.tool_activity) ? s.tool_activity : []).filter((r): r is Row => isDict(r) && r.stream_id === streamId && r.turn_id === turn).slice(0, 32);
  const id = `${streamId}:${index}`, previous = rows.find((r) => r.id === id), chars = fact.input_chars;
  if (!isPyIntValue(chars) || Number(chars) < 0 || Number(chars) > 1e8 || previous && Number(chars) < Number(previous.input_chars ?? 0)) return false;
  const cid = typeof fact.call_id === "string" && pyLen(fact.call_id) <= 256 ? fact.call_id : "";
  if (previous?.call_id && cid && previous.call_id !== cid) return false;
  const row = { id, stream_id: streamId, turn_id: turn, call_id: cid || previous?.call_id || "", name, phase: "input_streaming", input_chars: chars, partial_input: INPUT.has(name) && typeof fact.partial_input === "string" ? pySlice(fact.partial_input, 4096) : "", truncated: fact.truncated === true || Number(chars) > 4096 };
  if (pyEquals(row, previous)) return false;
  s.tool_activity = previous ? rows.map((r) => r.id === id ? row : r) : [...rows, row].slice(0, 32); return true;
}
export function publicToolActivity(s: Session, o: ActivityOptions): Row[] {
  const stream = isDict(s.streaming) ? s.streaming : {};
  if (s.status !== "running" || stream.status !== "streaming" || stream.tool_input_closed === true) return [];
  const ids = new Set(Object.keys(isDict(s.results) ? s.results : {}));
  for (const message of Array.isArray(s.messages) ? s.messages : []) if (isDict(message)) for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) if (isDict(call)) ids.add(call.id as string);
  const result: Row[] = [];
  for (const row of (Array.isArray(s.tool_activity) ? s.tool_activity : []).slice(-32)) {
    if (!isDict(row) || row.stream_id !== stream.id || row.turn_id !== s.active_turn_id || typeof row.call_id !== "string" || ids.has(row.call_id) || !activeTool(o, row.name)) continue;
    const raw = String(row.id).split(":").at(-1); if (!raw || !/^[+-]?[0-9]+$/.test(raw)) continue;
    const scratch: Session = { status: "running", streaming: stream, active_turn_id: s.active_turn_id };
    if (observeToolActivity(scratch, String(stream.id), { ...row, index: Number(raw) }, o)) result.push(...scratch.tool_activity as Row[]);
  }
  return result;
}
export function closeToolActivity(s: Session): void { if (isDict(s.streaming)) s.streaming.tool_input_closed = true; delete s.tool_activity; }
export function sessionsToolActivityExtension(toolOwner?: ActivityOptions["toolOwner"]): AgentExtension {
  return { id: "sessions", capabilities: ["sessions.live_tool_activity"],
    observeToolDelta(c, fact, id) { observeToolActivity(c.session, id, fact, { enabled: c.enabled, toolOwner }); },
    afterModelResponse(c, response) { closeToolActivity(c.session); return response; },
    settleRun(c) { closeToolActivity(c.session); }, close(c) { closeToolActivity(c.session); } };
}
