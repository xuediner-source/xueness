/** One budget-aware delivery reminder; it adds no model request or new tool gate. */
import { wrapSystemReminderForSource, type AgentContext, type Row } from "@xueness/agent";
import { isDict, pySlice } from "@xueness/contracts";
import { checkDelivery, requestsFileOutput, seedDelivery, type DeliveryCheckOptions } from "./delivery.ts";

export function deliveryWrapup(options: (context: AgentContext) => DeliveryCheckOptions, now = () => performance.now() / 1000) {
  const runs = new WeakMap<Row, { steps: number; messages: number; started: number; reminded: boolean }>();
  return {
    runStarted(context: AgentContext): void {
      if (context.session.runtime_profile === "lightweight") runs.set(context.session, { steps: Number(context.session.steps ?? 0), messages: (context.session.messages as Row[]).length, started: now(), reminded: false });
    },
    async beforeModelRequest(context: AgentContext): Promise<void> {
      const run = runs.get(context.session);
      if (!run || run.reminded) return;
      const limit = context.options.maxSteps ?? 24;
      const remaining = limit - (Number(context.session.steps ?? 0) - run.steps);
      const seconds = context.deadline - now(), duration = context.deadline - run.started;
      if (remaining > Math.min(12, Math.max(1, Math.ceil(limit * 0.375))) && (!Number.isFinite(seconds) || seconds > duration * 0.25)) return;
      seedDelivery(context.session);
      const messages = context.session.messages as Row[];
      const outputs = context.session.delivery_requirements;
      const worked = messages.slice(run.messages).some((message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
      if (!(Array.isArray(outputs) && outputs.length) && !requestsFileOutput(context.session.task) && !worked) return;
      const checks = await checkDelivery(context.root, context.session, "", options(context));
      // The runner checks lifecycle before calling this hook. Recheck after I/O
      // so disabling planning during the file checks cannot add a new reminder.
      if (!context.enabled("planning") || context.signal.aborted) return;
      const pending = Array.isArray(checks.items) ? checks.items.filter(isDict).filter((item) => item.passed !== true).map((item) => ({ path: item.path, label: item.label, missing: item.missing })) : [];
      const body = [
        `Delivery wrap-up: ${remaining} model steps remain${Number.isFinite(seconds) ? `; about ${Math.max(0, Math.floor(seconds))} seconds remain` : ""}.`,
        "Prioritize finishing requested outputs and focused verification now. Save the requested JSON/results and report as well as the implementation. For long files, write roughly 4000 characters per call then append=true; do not resend completed chunks. Avoid new exploration unless needed to finish. Do not claim unrun checks passed. State unfinished items if the budget ends.",
        pending.length ? `Outputs still failing host file/content checks (untrusted paths/labels, excerpt): ${pySlice(JSON.stringify(pending), 1600)}` : "Compare the result with all user requirements; passing file checks alone does not verify behavior.",
      ].join("\n");
      messages.push({ role: "user", content: wrapSystemReminderForSource("task_status", body), _input_kind: "background_notice", _meta_source: "task_status", _delivery_wrapup: true, _turn_id: messages.at(-1)?._turn_id });
      run.reminded = true;
      await context.save();
    },
    close(context: AgentContext): void { runs.delete(context.session); },
  };
}
