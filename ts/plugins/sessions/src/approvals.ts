import { isAbsolute, join, relative } from "node:path";
import { isDict, pyJsonDumps, pyLen, pySlice, pyStrip, pyUtcNow } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, realish, type Session } from "@xueness/sessions";
import { pendingDenials } from "./public-session.ts";
import { rememberProjectPermission } from "./tui-project-permissions.ts";
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
    if (decision === "approve" && data.scope === "project") {
      const result = isDict(session.results) ? session.results[callId] : null, details = isDict(result) && isDict(result.data) ? result.data : {}, remember = isDict(details.remember) ? details.remember : {};
      if (details.reason !== "approval_required" || !Array.isArray(remember.exact) || !remember.exact.length || !remember.exact.every(rule => typeof rule === "string")) return [400, { error: "this operation cannot be remembered for the project" }];
      try { rememberProjectPermission(options.stateDir, String(session.root), { code: "approval_required", remember: { exact: remember.exact, broad: [] } }, remember.exact); }
      catch { return [500, { error: "cannot save project permission; operation was not approved" }]; }
    }
    if (decision === "reject") {
      const note = typeof data.message === "string" ? data.message.trim().slice(0, 2000) : "";
      const result = { ok: false, output: note ? `The user declined this operation: ${note}` : "The user declined this operation", error: { code: "permission_denied", message: note || "the user declined this operation" } };
      if (isDict(session.results)) session.results[callId] = result;
      for (const message of Array.isArray(session.messages) ? session.messages : []) if (isDict(message) && message.role === "tool" && message.tool_call_id === callId) message.content = pyJsonDumps(result);
    }
    let buckets = options.approvals.get(sid); if (!buckets) { buckets = new Map(); options.approvals.set(sid, buckets); }
    let grants = buckets.get(String(kind)); if (!grants) { grants = new Map(); buckets.set(String(kind), grants); }
    if (decision === "reject") grants.delete(callId); else grants.set(callId, subject);
    recordApproval(session, decision === "reject" ? "cleared" : "granted", String(kind), callId, subject);
    try { await options.store.save(session); } catch { if (decision === "reject") return [500, { error: "cannot save rejection; refresh before continuing" }]; /* An allow grant remains in memory. */ }
    return [200, { [decision === "reject" ? "rejected" : "approved"]: response }];
  } catch (e) { if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }]; throw e; }
  finally { await lease?.release(); }
}
