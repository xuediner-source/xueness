import type { AgentContext, AgentExtension } from "@xueness/agent";
import { pyTruthy } from "@xueness/contracts";
import { checkDelivery, requestsFileOutput, seedDelivery, type DeliveryCheckOptions } from "./delivery.ts";
import { workPolicy } from "./work-policy.ts";
import { goalReminder, mergeGoalCompletion, verifyGoalCompletion } from "./goal-completion.ts";
import { deliveryWrapup } from "./delivery-wrapup.ts";
import { reportFinish } from "./report-finish.ts";
import { failureRepair } from "./failure-repair.ts";
import { deliveryVerification } from "./delivery-verify-extension.ts";
import { importContract } from "./delivery-verification.ts";
export const DELIVERY_GUIDANCE = "The host registers explicit saved output paths from the task. Use delivery_plan to add missing requested outputs, content markers (contains), or source-link counts (min_links); do not register input/reference paths or repeat an already registered plan. A report written only in chat does not require a saved file unless requested. Save requested results and a truthful report during the work, including failed tests and unresolved issues; update them after fixes instead of waiting for every check to pass before creating them. Do not remove requirements to pass. Host file/content checks and successful tools do not establish behavioral correctness.";
export function planningDeliveryExtension(options: (context: AgentContext) => DeliveryCheckOptions): AgentExtension {
  const repair = failureRepair(options), wrapup = deliveryWrapup(options), report = reportFinish(options, repair.pendingFailure), verification = deliveryVerification();
  return { id: "planning", capabilities: ["planning.delivery", "planning.lightweight_wrapup", "planning.report_finish", "planning.failure_repair", "planning.delivery_verification"],
    runStarted(context) { repair.runStarted(context); wrapup.runStarted(context); report.runStarted(context); verification.runStarted(context); },
    async toolResultRecorded(context, call, result) { await verification.toolResultRecorded(context, call, result); repair.toolResultRecorded(context, call, result); },
    beforeTool: verification.beforeTool,
    modelRequestStarted: report.modelRequestStarted,
    async beforeModelRequest(context) { await repair.beforeModelRequest(context); await wrapup.beforeModelRequest(context); await report.beforeModelRequest(context); },
    prepareRequest(context, request) { return verification.prepareRequest(context, report.prepareRequest(context, repair.prepareRequest(context, request))); },
    async afterModelResponse(context, response) { return verification.afterModelResponse(context, await report.afterModelResponse(context, response)); },
    beforeFinalResponse: repair.beforeFinalResponse,
    close(context) { repair.close(context); wrapup.close(context); report.close(context); verification.close(context); },
    completionInstructions(context) {
      seedDelivery(context.session);
      const instructions = report.instructions(context);
      return [workPolicy(context.session), ...(pyTruthy(context.session.delivery_requirements) || requestsFileOutput(context.session.task) ? [DELIVERY_GUIDANCE] : []), ...importContract(context.session).paths.length ? ["For the explicit Node module import contract, planning schedules delivery_verify after code changes. Fix its actual diagnostics and save missing files. A successful CLI does not prove an import passed."] : [], ...goalReminder(context.session) ? [goalReminder(context.session)] : [], ...instructions ? [instructions] : []];
    },
    async completionChecks(context, answer) { return { planning: mergeGoalCompletion(await checkDelivery(context.root, context.session, answer, options(context)), verifyGoalCompletion(context.session, answer)), module_import: verification.checks(context) }; },
  };
}
