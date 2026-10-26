/** Output-delivery probe used by the off-peak queue (kept out of off-peak-queue.ts for line budget). */
import { isDict, pyTruthy } from "@xueness/contracts";
import { pick, type Row } from "./off-peak.ts";

export type OutputSignal = (workflowId: string) => boolean | null;
export type WorkflowBridge = { load(workflowId: string): unknown };

/** Whether the run behind a workflow id has delivered output (null when unknowable). */
export function resolveOutputDelivered(
  workflowId: string,
  outputSignal: OutputSignal | null,
  bridge: WorkflowBridge | null,
): boolean | null {
  if (outputSignal !== null) {
    try { return outputSignal(workflowId); } catch { return null; }
  }
  if (bridge === null) return null;
  try {
    const nodes = pick(bridge.load(workflowId) as Row, "nodes");
    if (!isDict(nodes)) return null;
    return Object.values(nodes).some((node) => isDict(node)
      && (pyTruthy(pick(node, "session_id")) || pick(node, "status") !== "pending"));
  } catch { return null; }
}
