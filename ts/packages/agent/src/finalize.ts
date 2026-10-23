import { isDict } from "@xueness/contracts";
import { assess, currentTurnAliases, currentTurnToolIds, evidenceAliases, recordCompletionHistory, toolExecutionStatus, turnId, type Assessment } from "./completion.ts";
import type { AgentContext, AgentExtension, Row } from "./types.ts";

export function effectiveExtensions(context: AgentContext, extensions: readonly AgentExtension[]): AgentExtension[] {
  return extensions.filter((extension) => context.enabled(extension.id));
}
export function assessFinal(context: AgentContext, content: string): Assessment {
  return assess(content, context.session.results as Row, currentTurnAliases(evidenceAliases(context.session), currentTurnToolIds(context.session)), context.enabled("sessions") && (context.provider.toolCalling ?? "native") === "native");
}
export async function finalize(context: AgentContext, extensions: readonly AgentExtension[], completion: Assessment): Promise<void> {
  const session = context.session;
  const ids = currentTurnToolIds(session);
  const status = toolExecutionStatus(session, ids);
  let required = !!ids.length;
  if (context.enabled("sessions")) {
    const policies = effectiveExtensions(context, extensions).filter((extension) => extension.completionRequiresEvidence);
    if (!policies.length) required ||= Array.isArray(session.delivery_requirements) ? !!session.delivery_requirements.length : !!session.delivery_requirements;
    for (const extension of policies) required = await extension.completionRequiresEvidence!(context, ids) || required;
  } else required = true;
  completion.tool_execution_status = status; completion.tool_execution_success = status === "succeeded";
  if (status !== "succeeded" && status !== "not_applicable") { completion.verified = false; completion.error_code = "tool_execution_" + status; }
  if (!required) { completion.verified = false; completion.status = "not_applicable"; completion.evidence = []; }
  else completion.status = completion.verified && status === "succeeded" ? "verified" : "unverified";
  completion.turn_id = turnId(session); completion.evidence_count = completion.evidence.length;
  const checks: Row = {};
  for (const extension of effectiveExtensions(context, extensions)) {
    if (extension.completionChecks) Object.assign(checks, await extension.completionChecks(context, completion.summary));
  }
  completion.delivery_checks = checks;
  const assessed = Object.values(checks).filter(isDict).filter((item) => item.status !== "not_assessed");
  completion.delivery_status = assessed.some((item) => item.status !== "passed") ? "failed" : assessed.length ? "passed" : "not_assessed";
  completion.delivery_check_passed = completion.delivery_status === "passed";
  session.completion = completion; delete session.pause_reason; delete session.pause_code;
  // ZCode-style: verification is a hint, not a gate. Only a failed host delivery check asks for review.
  session.status = completion.delivery_status === "failed" ? "needs_review" : "completed";
  recordCompletionHistory(session, completion); await context.save();
  context.emit({ type: "status", status: session.status, steps: session.steps, verified: completion.verified, completion_status: completion.status,
    tool_execution_status: completion.tool_execution_status, delivery_status: completion.delivery_status, turn_id: completion.turn_id });
}
