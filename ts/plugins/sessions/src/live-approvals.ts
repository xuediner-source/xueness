/**
 * Answer an approval that a running call is waiting for, without the run lease.
 *
 * ZCode v3.15.1 (aac4755, Apache-2.0) `core/permission/broker.ts` resolves a
 * pending request by call id; an id that is not pending is a miss. Here a miss
 * falls through to the journal path (approveSession), which records a grant for
 * the next run to replay: an older session, or one whose process restarted.
 */
import { isDict, pyJsonDumps, pyStrip } from "@xueness/contracts";
import { rememberProjectPermission } from "./tui-project-permissions.ts";
import type { SessionReply } from "./http-api.ts";
import type { LifecycleOptions, Row } from "./lifecycle-types.ts";

/** Structural view of the tool bridge's ApprovalWaits; the sessions plugin only answers. */
export interface LiveApprovalPort {
  get(sessionId: string, callId: string): { readonly tool: string; readonly kind: string; readonly subject: string; readonly code?: string; readonly remember?: { exact: readonly string[]; broad: readonly string[] } | null } | null;
  answered(sessionId: string, callId: string): "approve" | "reject" | null;
  answer(sessionId: string, callId: string, decision: "approve" | "reject", message?: string, scope?: "once" | "session" | "project"): { readonly status: string };
  close(sessionId: string, message?: string): number;
}

const MISMATCH: SessionReply = [400, { error: "approval must reference an exact pending denied tool_call_id and subject" }];

/** Null when no call waits (or waited) under this id: use the journal path. */
export function answerLiveApproval(options: LifecycleOptions, sid: string, data: Row): SessionReply | null {
  const live = options.liveApprovals, callId = data.tool_call_id;
  if (!live || typeof callId !== "string" || !callId) return null;
  const decision = data.decision ?? "approve";
  if (decision !== "approve" && decision !== "reject") return null;
  const waiting = live.get(sid, callId), earlier = waiting ? null : live.answered(sid, callId);
  if (!waiting && !earlier) return null;
  // Answered calls keep no request details; the journal still holds them.
  const approval = waiting ?? null;
  const kind = data.kind ?? approval?.kind ?? "";
  if (approval) {
    if (!(kind === approval.kind || kind === approval.tool || kind === "mcp" && approval.tool.startsWith("mcp__"))) return MISMATCH;
    if (Object.hasOwn(data, "subject") && (typeof data.subject !== "string" || pyStrip(data.subject) !== approval.subject)) return MISMATCH;
    if (Object.hasOwn(data, "argv")) {
      const argv = data.argv;
      if (!Array.isArray(argv) || !argv.every((part) => typeof part === "string")) return MISMATCH;
      if (pyJsonDumps(argv, { separators: [",", ":"] }) !== approval.subject && argv.join(" ") !== approval.subject) return MISMATCH;
    }
    const owner = options.toolOwner?.(approval.tool);
    if (owner && !options.enabled(owner)) return [403, { error: "tool plugin disabled", plugin: owner }];
  }
  const field = decision === "reject" ? "rejected" : "approved";
  const confirmation = (subject: string | undefined): Row => ({ [field]: { kind, tool_call_id: callId, ...(subject !== undefined ? { subject } : {}) }, resumed: true });
  if (earlier) {
    // ZCode: the first answer decides; a repeat is idempotent, a change is refused.
    if (earlier !== decision) return [409, { error: "approval already answered", code: "approval_already_answered", decision: earlier }];
    return [200, { ...confirmation(undefined), duplicate: true }];
  }
  const message = decision === "reject" && typeof data.message === "string" && pyStrip(data.message) ? pyStrip(data.message).slice(0, 2000) : undefined;
  // "Allow for this session" (scope: "session") lives in the waiting layer's memory only.
  const scope = decision === "approve" && data.scope === "session" ? "session" : "once";
  if (decision === "approve" && data.scope === "project") {
    const session = options.activeContext.get(sid)?.active_session;
    if (!approval || approval.code !== "approval_required" || !approval.remember?.exact.length || !isDict(session) || typeof session.root !== "string") return [400, { error: "this operation cannot be remembered for the project" }];
    try { rememberProjectPermission(options.stateDir, session.root, { code: approval.code, remember: approval.remember }, approval.remember.exact); }
    catch { return [500, { error: "cannot save project permission; operation was not approved" }]; }
  }
  const outcome = live.answer(sid, callId, decision, message, decision === "approve" && data.scope === "project" ? "project" : scope);
  if (outcome.status === "answered") return [200, confirmation(approval?.subject)];
  if (outcome.status === "duplicate") return [200, { ...confirmation(approval?.subject), duplicate: true }];
  if (outcome.status === "conflict") return [409, { error: "approval already answered", code: "approval_already_answered" }];
  return null; // The wait ended (stop, cancel) between the lookup and the answer.
}
