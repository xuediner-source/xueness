import { isDict, isPyIntValue, numericValue, pyJsonLoads, pyLen, pySlice } from "@xueness/contracts";
import type { SessionStore } from "@xueness/sessions";
import { pendingDenials, defaultToolInfo } from "./public-session.ts";
import { questionIdentity } from "./question-id.ts";
import { readPublished, timestamp } from "./published-read.ts";
type Row = Record<string, any>;
const TERMINAL = new Set(["completed", "failed", "cancelled", "stopped", "error", "provider_error"]);
export const rowText = (v: unknown, limit: number): string => typeof v === "string" ? pySlice(v.split(/[\s\u0085\u001c-\u001f]+/u).filter(Boolean).join(" ").replace(/[\x00-\x1f\x7f\ud800-\udfff]/gu, ""), limit) : "";
const pathText = (v: unknown, max: number): string => typeof v === "string" && pyLen(v) <= max && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(v) ? v : "";
function phase(status: string): string { return ["running", "pending", "queued", "stopping"].includes(status) ? "running" : ["awaiting_user", "needs_review", "paused", "stalled"].includes(status) ? "waiting" : ["failed", "error", "provider_error"].includes(status) ? "error" : TERMINAL.has(status) ? "completed" : status || "unknown"; }
function projection(s: Row, tools: ReadonlySet<string>, enabled: (id: string) => boolean): Row {
  const messages: Row[] = [];
  for (const m of Array.isArray(s.messages) ? s.messages : []) if (isDict(m) && Array.isArray(m.tool_calls)) { const active = m.tool_calls.filter((c) => isDict(c) && typeof c.id === "string" && isDict(c.function) && typeof c.function.name === "string" && (tools.has(c.function.name) || enabled("mcp") && c.function.name.startsWith("mcp__"))); if (active.length) messages.push({ tool_calls: active }); }
  return { messages, results: isDict(s.results) ? s.results : {} };
}
function changed(projection: Row, enabled: (id: string) => boolean): Row | null {
  if (!enabled("files")) return null; const paths: string[] = [];
  for (const m of projection.messages) for (const c of m.tool_calls) { const result = projection.results[c.id]; if (!isDict(result) || !result.ok || !isDict(c.function) || !["write", "edit"].includes(String(c.function.name))) continue;
    try { const args = pyJsonLoads(c.function.arguments ?? "{}"); if (!isDict(args)) continue; const info = defaultToolInfo(c.function.name as string, args); if (info?.subject && !paths.includes(info.subject)) paths.push(info.subject); } catch { /* Corrupt calls are not changed path evidence. */ }
  }
  const count = paths.length, bounded = paths.slice(0, 20); if (!bounded.length) return null; const details = bounded.map((p) => pathText(p, 512)).filter(Boolean).map((path) => ({ path }));
  return { fileCount: bounded.length, files: bounded.length, fileDetails: details, ...(count > 20 || details.length < bounded.length ? { truncated: true } : {}) };
}
function unread(store: SessionStore, sid: string, mtime: bigint): boolean {
  const marker = readPublished(store.directory, `.xueness-session-read/${sid}.json`, 2048)?.value;
  if (!isDict(marker) || !isPyIntValue(marker.readThroughMtimeNs) || BigInt(marker.readThroughMtimeNs) < 0n || typeof marker.viewedAt === "boolean") return true;
  const at = numericValue(marker.viewedAt); return at === null || at < 0 || BigInt(marker.readThroughMtimeNs) < mtime;
}
export function indexRow(store: SessionStore, s: Row, mtime: number, mtimeNs: bigint, enabled: (id: string) => boolean, tools: ReadonlySet<string>): Row | null {
  if (typeof s.id !== "string" || !/^[0-9a-f]{32}$/.test(s.id)) return null;
  const status = rowText(s.status, 40) || "unknown", workspace = pathText(s.workspace, 4096) || pathText(s.root, 4096), title = rowText(s.title || s.task, 120) || "未命名任务", updated = timestamp(mtime), p = projection(s, tools, enabled), denials = pendingDenials(p), permissionCount = Math.min(denials.length, 8);
  let interaction: Row | null = null;
  for (const denial of denials.slice(0, 8)) { const id = rowText(denial.tool_call_id, 80), name = rowText(denial.name, 80); if (id) { interaction = { interactionId: id, kind: "permission", ...(name ? { toolName: name } : {}) }; break; } }
  const userCount = s.status === "awaiting_user" && typeof s.pending_question === "string" && !!s.pending_question.trim() ? 1 : 0;
  if (!interaction && userCount) interaction = { interactionId: questionIdentity(s, s.pending_question), kind: "userInput", ...(tools.has("ask_user") ? { toolName: "ask_user" } : {}) };
  const sidecar: Row = { status, updatedAt: updated }, row: Row = { sessionId: s.id, id: s.id, title, workspace, workspaceId: workspace, purpose: rowText(s.workspacePurpose ?? s.workspace_purpose ?? s.purpose ?? "project", 32) || "project", status, pinned: s.pinned === true, root: workspace, updatedAt: updated, phase: phase(status), sessionEnded: TERMINAL.has(status), hasBackgroundWork: ["running", "pending", "queued", "stopping"].includes(status), lastActivityAt: updated, sidecar };
  const created = s.createdAt ?? s.created_at; let createdAt: string | null = null;
  const createdNumber = typeof created === "boolean" ? Number(created) : numericValue(created);
  if (createdNumber !== null) createdAt = timestamp(createdNumber); else if (typeof created === "string" && created) createdAt = rowText(created, 64);
  if (createdAt) row.createdAt = createdAt;
  if (interaction) row.pendingInteraction = sidecar.pendingInteraction = interaction;
  if (permissionCount || userCount) row.pendingInteractionSummary = sidecar.pendingInteractionSummary = { permissionCount, userInputCount: userCount };
  row.unread = sidecar.unread = unread(store, s.id, mtimeNs); const changeSummary = changed(p, enabled); if (changeSummary) row.changeSummary = sidecar.changeSummary = changeSummary;
  for (const m of Array.isArray(s.messages) ? s.messages.slice(-200).reverse() : []) if (isDict(m) && m.role === "assistant") { const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((v) => isDict(v) && v.type === "text" && typeof v.text === "string").map((v) => v.text).join(" ") : "", preview = rowText(content, 120); if (preview) { row.lastAssistantPreview = preview; break; } }
  return row;
}
