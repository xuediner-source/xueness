import { post } from "../../xuenessBridge";

export type SubagentActionReceipt = {
  task_id: string;
  childSessionId: string;
  status?: string;
  background?: boolean;
  evidence_eligible?: false;
};

export async function cancelSubagentTask(sessionId: string, taskId: string): Promise<{ cancelled: true; taskId: string }> {
  return post<{ cancelled: true; taskId: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
    {},
  );
}

export async function sendSubagentMessage(
  sessionId: string, taskId: string, message: string, requestId: string,
): Promise<{ task_id: string; childSessionId: string; receipt: { id: string; status: string }; delivery: string }> {
  return post<{ task_id: string; childSessionId: string; receipt: { id: string; status: string }; delivery: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/messages`,
    { message, requestId },
  );
}

export async function resumeSubagentTask(
  sessionId: string, taskId: string, message: string | undefined, requestId: string,
): Promise<SubagentActionReceipt> {
  return post<SubagentActionReceipt>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/resume`,
    { ...(message ? { message } : {}), requestId },
  );
}

export function newSubagentRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
