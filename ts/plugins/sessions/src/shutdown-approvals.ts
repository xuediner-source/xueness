import { isDict, pyJsonDumps } from "@xueness/contracts";
import type { Session, SessionStore } from "@xueness/sessions";

type Row = Record<string, unknown>;
export function captureShutdownApprovals(waiting: readonly { sessionId: string; callId: string }[], sessions: ReadonlyMap<string, Session>) {
  const captured = new Map<string, Map<string, Row>>();
  for (const { sessionId, callId } of waiting) {
    const session = sessions.get(sessionId), results = session?.results;
    const result = isDict(results) ? results[callId] : null;
    if (!isDict(result) || !isDict(result.error) || result.error.code !== "approval_required") continue;
    let calls = captured.get(sessionId);
    if (!calls) { calls = new Map(); captured.set(sessionId, calls); }
    calls.set(callId, { ...result, data: { ...isDict(result.data) ? result.data : {}, waiting: false } });
  }
  return captured;
}

export async function restoreShutdownApprovals(store: SessionStore, captured: Map<string, Map<string, Row>>): Promise<void> {
  for (const [sid, calls] of captured) await store.update(sid, session => {
    const results = isDict(session.results) ? session.results : {};
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (const [id, pending] of calls) {
      results[id] = pending;
      const message = messages.find(m => isDict(m) && m.role === "tool" && m.tool_call_id === id);
      if (isDict(message)) message.content = pyJsonDumps(pending);
    }
    session.results = results; session.status = "paused";
    session.pause_code = "approval_required";
    session.pause_reason = "应用已关闭，待审批操作已保留；批准后继续，不会自动执行。";
    if (isDict(session.runtime_activity)) session.runtime_activity.phase = "paused";
    return true;
  });
}
