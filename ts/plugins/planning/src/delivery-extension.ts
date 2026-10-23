import type { AgentContext, AgentExtension } from "@xueness/agent";
import { pyTruthy } from "@xueness/contracts";
import { checkDelivery, requestsFileOutput, seedDelivery, type DeliveryCheckOptions } from "./delivery.ts";
import { workPolicy } from "./work-policy.ts";
import { goalReminder, mergeGoalCompletion, verifyGoalCompletion } from "./goal-completion.ts";
export const DELIVERY_GUIDANCE = "For a requested saved file or other file artifact, call delivery_plan before doing the work. Register only requested outputs: paths supplied for reading, reference, or analysis are inputs, not deliverables. A report or research answer written only in this chat does not need delivery_plan just because it is called a report. Add each explicit output path, requested content marker (contains), and required source-link count (min_links). Do not remove requirements to pass. The host checks actual file content or the final summary; successful tool execution alone does not prove the delivery is complete. Missing checks are reported separately.";
export function planningDeliveryExtension(options: (context: AgentContext) => DeliveryCheckOptions): AgentExtension {
  return { id: "planning", capabilities: ["planning.delivery"],
    completionInstructions(context) {
      seedDelivery(context.session);
      return [workPolicy(context.session), ...(pyTruthy(context.session.delivery_requirements) || requestsFileOutput(context.session.task) ? [DELIVERY_GUIDANCE] : []), ...goalReminder(context.session) ? [goalReminder(context.session)] : []];
    },
    async completionChecks(context, answer) { return { planning: mergeGoalCompletion(await checkDelivery(context.root, context.session, answer, options(context)), verifyGoalCompletion(context.session, answer)) }; },
  };
}
