/** Parent metadata alone owns row identity; no child journal is opened. */
import { isDict, isPyIntValue, pyJsonLoads, pyLen, pySlice } from "@xueness/contracts";
type Row = Record<string, any>;
const taskId = (v: unknown): string | null => typeof v === "string" && /^task-[A-Za-z0-9_-]{1,160}$/.test(v) ? v : null;
const callId = (v: unknown): string | null => typeof v === "string" && v && pyLen(v) <= 200 && !/[\s\p{C}]/u.test(v) ? v : null;
const text = (v: unknown, limit: number): string => typeof v === "string" ? pySlice(pySlice(v, limit * 4).replace(/\p{C}/gu, " ").split(/\s+/u).filter(Boolean).join(" "), limit) : "";
const parentTask = (r: Row, parent: string): boolean => ["parent", "parentSessionId"].some((k) => Object.hasOwn(r, k)) && ["parent", "parentSessionId"].every((k) => !Object.hasOwn(r, k) || r[k] === parent);
const resultId = (v: unknown): string | null => isDict(v) ? taskId(v.task_id) : null;
const statuses = new Set(["running", "completed", "failed", "cancelled"]);
export function projectSubagents(session: Row, messages: unknown, enabled: boolean, liveTasks: unknown = null): Row[] {
  if (!Array.isArray(messages) || typeof session.id !== "string" || !session.id || !Array.isArray(session.task_runs)) return [];
  const tasks = new Map<string, Row>();
  for (const r of session.task_runs.slice(-100)) if (isDict(r) && parentTask(r, session.id)) { const id = taskId(r.id); if (id) tasks.set(id, r); }
  const calls: string[] = [], eligible = new Set<string>(), seen = new Set<string>(), duplicate = new Set<string>(), page = messages.slice(0, 500);
  for (const m of page) if (isDict(m) && m.role === "assistant") for (const c of Array.isArray(m.tool_calls) ? m.tool_calls.slice(0, 40) : []) {
    if (!isDict(c)) continue; const id = callId(c.id); if (!id) continue; if (seen.has(id)) duplicate.add(id); else seen.add(id);
    if (isDict(c.function) && ["task", "task_resume"].includes(String(c.function.name)) && !eligible.has(id)) { calls.push(id); eligible.add(id); }
  }
  const candidates = new Map(calls.filter((id) => !duplicate.has(id)).map((id) => [id, new Set<string>()]));
  const bind = (id: string | null, task: string | null) => { if (id && task) candidates.get(id)?.add(task); };
  if (isDict(session.subagent_coordination)) for (const task of tasks.keys()) { const r = session.subagent_coordination[task]; if (isDict(r)) bind(callId(r.call_id), task); }
  if (isDict(session.results)) for (const id of candidates.keys()) bind(id, resultId(session.results[id]));
  for (const m of page) if (isDict(m) && m.role === "tool") { const id = callId(m.tool_call_id); if (id && candidates.has(id) && typeof m.content === "string" && pyLen(m.content) <= 16000) try { bind(id, resultId(pyJsonLoads(m.content))); } catch { /* Invalid result cannot establish identity. */ } }
  const live = new Map<string, Row>(), ambiguous = new Set<string>();
  for (const r of Array.isArray(liveTasks) ? liveTasks.slice(-100) : []) if (isDict(r) && parentTask(r, session.id)) { const id = taskId(r.id); if (!id || ambiguous.has(id)) continue; if (live.has(id)) { live.delete(id); ambiguous.add(id); } else live.set(id, r); }
  const rows: Row[] = [];
  for (const [id, identities] of candidates) {
    if (identities.size !== 1) continue; const task = [...identities][0]!, r = tasks.get(task); if (!r) continue;
    const agent = text(r.agent, 80), latest = live.get(task); let status = r.status, summary = text(r.summary, 600) || text(r.error, 600), steps = r.steps;
    if (latest) { status = statuses.has(String(latest.status)) ? latest.status : "unknown"; summary = text(latest.summary, 600) || text(latest.error, 600) || summary; steps = latest.steps; }
    const row: Row = { tool_call_id: id, task_id: task, agent, label: text(r.label, 80) || agent || pySlice(task, 80), status: statuses.has(String(status)) ? status : "unknown", summary };
    if (isPyIntValue(steps) && Number(steps) >= 1 && Number(steps) <= 64) row.steps = steps;
    if (enabled && typeof r.childSessionId === "string" && /^[0-9a-f]{32}$/.test(r.childSessionId) && r.childSessionId.toLowerCase() !== session.id.toLowerCase()) row.child_session_id = r.childSessionId;
    rows.push(row); if (rows.length >= 32) break;
  }
  return rows;
}
