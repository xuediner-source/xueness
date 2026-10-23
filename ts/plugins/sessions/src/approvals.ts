import { isAbsolute, join, relative } from "node:path";
import { isDict, pyJsonDumps, pyLen, pySlice, pyStrip, pyUtcNow } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, realish, type Session } from "@xueness/sessions";
import { pendingDenials } from "./public-session.ts";
import { answerLiveApproval } from "./live-approvals.ts";
import type { LifecycleOptions, Row } from "./lifecycle-types.ts";
import type { SessionReply } from "./http-api.ts";
export function recordApproval(session: Session, action: string, kind: string, callId: unknown, subject: unknown): void {
  try {
    const rows = (session.approval_log ??= []) as Row[];
    rows.push({ at: pyUtcNow(), action, kind, tool_call_id: typeof callId === "string" ? callId : "", subject: subject == null ? "" : pySlice(String(subject), 200) });
    session.approval_log = rows.slice(-100);
  } catch { /* Audit must never change the permission decision. */ }
}
export async function approveSession(options: LifecycleOptions, sid: string, data: Row): Promise<SessionReply> {
  // A call waiting in process continues in the same turn; otherwise grant for the next run's replay.
  const live = answerLiveApproval(options, sid, data);
  if (live) return live;
  let lease: Awaited<ReturnType<typeof options.store.lease>> | null = null;
  try {
    lease = await options.store.lease(sid);
    const decision = data.decision ?? "approve";
    if (decision !== "approve" && decision !== "reject") return [400, { error: "decision must be 'approve' or 'reject'" }];
    let session: Session;
    try { session = await options.store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
    const pending = pendingDenials(session, options), callId = data.tool_call_id;
    let kind: unknown = data.kind ?? "";
    const generic = pending.find((p) => (p.kind === kind || p.name === kind) && p.tool_call_id === callId);
    if (generic) kind = generic.kind || generic.name;
    const owner = options.toolOwner?.(String(generic?.name ?? kind));
    if (owner && !options.enabled(owner)) return [403, { error: "tool plugin disabled", plugin: owner }];
    const pathOkay = (subject: string): boolean => { const target = realish(isAbsolute(subject) ? subject : join(String(session.root), subject)), rel = relative(realish(String(session.root)), target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };
    let subject: string, response: Row;
    if (generic) {
      subject = String(generic.subject);
      if (["write", "edit"].includes(String(kind)) || ["write", "edit"].includes(String(generic.name))) {
        if (!subject || !pyStrip(subject) || pyLen(subject) > 1024) return [400, { error: "subject must be a relative workspace path" }];
        if (!pathOkay(subject)) return [400, { error: "path outside workspace" }];
        if (Object.hasOwn(data, "subject") && (typeof data.subject !== "string" || pyStrip(data.subject) !== subject)) return [400, { error: "approval must reference an exact pending denied tool_call_id and subject" }];
      }
      response = { kind, tool_call_id: callId, subject };
    } else if (kind === "write" || kind === "edit") {
      const input = data.subject ?? "";
      if (typeof input !== "string" || !pyStrip(input) || pyLen(input) > 1024) return [400, { error: "subject must be a relative workspace path" }];
      subject = pyStrip(input);
      if (!pathOkay(subject)) return [400, { error: "path outside workspace" }];
      if (typeof callId !== "string" || !pending.some((p) => p.name === kind && p.subject === subject && p.tool_call_id === callId)) return [400, { error: "approval must reference an exact pending denied tool_call_id" }];
      response = { kind, tool_call_id: callId, subject };
    } else if (kind === "exec") {
      const argv = data.argv ?? data.subject;
      if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some((v) => typeof v !== "string" || !v || pyLen(v) > 1024)) return [400, { error: "argv must be a nonempty array of strings" }];
      subject = pyJsonDumps(argv, { separators: [",", ":"] });
      if (typeof callId !== "string" || !pending.some((p) => p.name === "exec" && p.subject === subject && p.tool_call_id === callId)) return [400, { error: "approval must reference an exact pending denied tool_call_id" }];
      response = { kind, tool_call_id: callId, argv };
    } else if (kind === "mcp") {
      const entry = pending.find((p) => String(p.name).startsWith("mcp__") && p.tool_call_id === callId);
      if (!entry || typeof callId !== "string") return [400, { error: "approval must reference an exact pending denied tool_call_id" }];
      subject = String(entry.subject); response = { kind, tool_call_id: callId, subject };
    } else return [400, { error: "kind must be 'write', 'edit', 'exec' or 'mcp'" }];
    if (typeof callId !== "string") return [400, { error: "approval must reference an exact pending denied tool_call_id" }];
    let buckets = options.approvals.get(sid); if (!buckets) { buckets = new Map(); options.approvals.set(sid, buckets); }
    let grants = buckets.get(String(kind)); if (!grants) { grants = new Map(); buckets.set(String(kind), grants); }
    if (decision === "reject") grants.delete(callId); else grants.set(callId, subject);
    recordApproval(session, decision === "reject" ? "cleared" : "granted", String(kind), callId, subject);
    try { await options.store.save(session); } catch { /* In-memory decision remains live, like Python. */ }
    return [200, { [decision === "reject" ? "rejected" : "approved"]: response }];
  } catch (e) { if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }]; throw e; }
  finally { await lease?.release(); }
}
