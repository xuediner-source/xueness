/**
 * Writes the factual work segments the conversation view reads
 * (`session.work_segments`, `@xueness/sessions` work-activity).
 *
 * Each round of a run opens one segment once the driver has marked the
 * session running and picked its turn; the store's save hook closes it when a
 * save observes a waiting or terminal state, and `settleRun` closes whatever
 * that left open. The measured time includes in-process approval waits: the
 * run is still running while a tool waits for its answer.
 */
import type { AgentExtension } from "@xueness/agent";
import { settleWork, startWork } from "@xueness/sessions";

export function sessionsWorkActivityExtension(): AgentExtension {
  return { id: "sessions", capabilities: ["sessions.work_activity"],
    runStarted(context) { startWork(context.session); },
    settleRun(context, returned) { settleWork(context.session, { returned }); },
  };
}
