import { createHash } from "node:crypto";
import { isDict, pyJsonDumps, pyLen, pyStrip } from "@xueness/contracts";
type Dict = Record<string, unknown>;
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
function label(v: unknown): string | null { return typeof v === "string" && pyStrip(v) && pyLen(v) <= 120 && !/[\p{C}/\\<>@]/u.test(v) && !v.includes("://") ? pyStrip(v) : null; }
export function timelineMarkers(session: Dict, fork: Dict | null): Dict[] {
  const hidden = new Set(Array.isArray(session.history_hidden_message_ids) ? session.history_hidden_message_ids : []);
  const byId = new Map<string, Dict>();
  for (const key of ["archived_messages", "messages"]) for (const m of Array.isArray(session[key]) ? session[key] : []) if (isDict(m) && token(m._message_id) && !hidden.has(m._message_id)) byId.set(m._message_id, m);
  const result: Dict[] = [], seen = new Set<string>();
  const add = (kind: string, anchor: unknown, placement: string, payload: Dict = {}, receipt: unknown = null) => {
    if (!token(anchor)) return;
    const m = byId.get(anchor); if (!m || !["user", "assistant"].includes(String(m.role)) || placement === "before_user" && m.role !== "user") return;
    const data: Dict = { kind, message_id: anchor, placement, ...payload };
    const id = "fact:" + createHash("sha256").update(pyJsonDumps([data, receipt], { sortKeys: true, ensureAscii: true })).digest("hex").slice(0, 24);
    if (!seen.has(id)) { seen.add(id); result.push({ ...data, id }); }
  };
  if (fork && isDict(session.fork_parent)) add(fork.checkpointId ? "checkpoint_source" : "fork", session.fork_marker_message_id, "work_tail");
  for (const item of Array.isArray(session.model_history) ? session.model_history.slice(-100) : []) {
    if (!isDict(item) || typeof item.at !== "string" || pyLen(item.at) > 40 || !/(?:Z|[+-]\d\d:\d\d)$/.test(item.at) || !Number.isFinite(Date.parse(item.at))) continue;
    const model = isDict(item.to) ? label(item.to.model) : null;
    if (model && ["immediate", "next_run", "next_request"].includes(String(item.effect))) add("model", item.message_id, "work_tail", { label: model, effect: item.effect }, item.at);
  }
  for (const item of Array.isArray(session.message_edit_history) ? session.message_edit_history.slice(-100) : []) if (isDict(item) && typeof item.revision === "string" && /^sha256:[0-9a-f]{64}$/.test(item.revision)) add("edit", item.message_id, "before_user", {}, item.revision);
  for (const item of Array.isArray(session.input_context) ? session.input_context.slice(-100) : []) {
    if (!isDict(item) || !token(item.message_id)) continue;
    const m = byId.get(item.message_id); if (!m || m.role !== "user" || typeof m.content !== "string" || item.content_sha256 !== createHash("sha256").update(m.content).digest("hex") || !isDict(item.metadata)) continue;
    const metadata = item.metadata;
    for (const category of ["files", "sessions", "skills", "plugins"]) for (const v of Array.isArray(metadata[category]) ? metadata[category].slice(0, 20) : []) { const name = isDict(v) ? label(v.label) : null; if (name) add("context", item.message_id, "before_user", { label: name, context_kind: category }); }
    const capabilities = isDict(metadata.modelSelection) && Array.isArray(metadata.modelSelection.capabilities) ? metadata.modelSelection.capabilities : [];
    for (const c of capabilities.slice(0, 20)) if (["vision", "image", "audio", "video", "tools", "reasoning"].includes(c)) add("context", item.message_id, "before_user", { label: c, context_kind: "capabilities" });
  }
  return result.slice(-400);
}
