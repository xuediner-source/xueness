/** Answer (or defer, as a restart would) every approval a run waits for until the run settles. */
import type { ApprovalWaits } from "@xueness/tool-bridge";

export async function answerWaits<T>(waits: ApprovalWaits, running: Promise<T>, action: "approve" | "reject" | "defer"): Promise<T> {
  let done = false;
  const settled = running.finally(() => { done = true; });
  while (!done) {
    for (const approval of waits.waiting()) {
      if (action === "defer") waits.defer(approval.sessionId);
      else waits.answer(approval.sessionId, approval.callId, action);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return settled;
}
