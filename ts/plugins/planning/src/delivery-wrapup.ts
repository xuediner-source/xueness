/** Bounded progress/save milestones; no extra model request or tool gate. */
import { wrapSystemReminderForSource, type AgentContext, type Row } from "@xueness/agent";
import { isDict, pySlice } from "@xueness/contracts";
import { checkDelivery, requestsFileOutput, seedDelivery, type DeliveryCheckOptions } from "./delivery.ts";

export function deliveryWrapup(options: (context: AgentContext) => DeliveryCheckOptions, now = () => performance.now() / 1000) {
  const runs = new WeakMap<Row, { steps: number; messages: number; started: number; stage: number }>();
  return {
    runStarted(context: AgentContext): void {
      if (context.session.runtime_profile === "lightweight") runs.set(context.session, { steps: Number(context.session.steps ?? 0), messages: (context.session.messages as Row[]).length, started: now(), stage: 0 });
    },
    async beforeModelRequest(context: AgentContext): Promise<void> {
      const run = runs.get(context.session);
      if (!run || run.stage === 3) return;
      const limit = context.options.maxSteps ?? 24;
      const remaining = limit - (Number(context.session.steps ?? 0) - run.steps);
      const seconds = context.deadline - now(), duration = context.deadline - run.started;
      const final = remaining <= Math.min(4, Math.max(1, Math.ceil(limit / 8))) || Number.isFinite(seconds) && seconds <= duration * 0.05;
      const wrap = remaining <= Math.min(12, Math.max(1, Math.ceil(limit * 0.375))) || Number.isFinite(seconds) && seconds <= duration * 0.25;
      const explored = limit - remaining >= Math.max(3, Math.ceil(limit / 4));
      const stage = final ? 3 : wrap ? 2 : explored ? 1 : 0;
      if (stage <= run.stage) return;
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
      const files = Array.isArray(checks.items) ? checks.items.filter(isDict).filter(item => typeof item.path === "string") : [];
      if (stage === 1 && (!files.length || files.some(item => item.passed === true)) || stage === 3 && run.stage >= 2 && !pending.length) { run.stage = stage; return; }
      const body = [
        `${stage === 1 ? "Implementation checkpoint" : final ? "Delivery final save" : "Delivery wrap-up"}: ${remaining} model steps remain${Number.isFinite(seconds) ? `; about ${Math.max(0, Math.floor(seconds))} seconds remain` : ""}.`,
        stage === 1 ? "A quarter of the step budget has been used and no requested file has passed the host file checks. Start saving the reusable implementation and observed findings next, before further broad inspection. Use the implementation for subsequent audits instead of repeating one-off inspection commands. Save only actual findings; do not invent results or claim unrun checks passed."
          : "Save the missing requested artifacts now with the actual results available. A report must include observed failures and unfinished work even when tests are still failing; update it after fixes. Run the implementation on the supplied input to produce requested result files; never invent their contents. Then use the remaining budget for focused fixes and verification. For long files, write roughly 4000 characters per call then append=true. Do not claim unrun checks passed.",
        pending.length ? `Outputs still failing host file/content checks (untrusted paths/labels, excerpt): ${pySlice(JSON.stringify(pending), 1600)}` : "Compare the result with all user requirements; passing file checks alone does not verify behavior.",
      ].join("\n");
      messages.push({ role: "user", content: wrapSystemReminderForSource("task_status", body), _input_kind: "background_notice", _meta_source: "task_status", _delivery_wrapup: true, _turn_id: messages.at(-1)?._turn_id });
      run.stage = stage;
      await context.save();
    },
    close(context: AgentContext): void { runs.delete(context.session); },
  };
}
