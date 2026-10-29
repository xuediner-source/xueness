/** Focus actual failures and unfinished outputs inside the caller's existing budget. */
import { isDict } from "@xueness/contracts";
import { wrapSystemReminderForSource, type AgentContext, type ModelRequest, type Row } from "@xueness/agent";
import { checkDelivery, seedDelivery, type DeliveryCheckOptions } from "./delivery.ts";
import { codeChange, executionInputFailure } from "./repair-input.ts";
import { importChecks } from "./delivery-verification.ts";

type Call = { id: string; name: string; input?: unknown };
type Failure = { key: string; tool: string; input: string; diagnostic: string; step: number; changes: number; verification: boolean };
type Run = { steps: number; worked: boolean; blocked?: string; failures: Failure[]; changes: number; pending: string[]; imports: Row[]; continuations: number };
const REPAIR = "You are repairing an observed failure in the user's task. Follow the user's scope: preserve expected negative-test/reproduction evidence and do not change behavior unless requested. Focus on the failing command/tool and its actual diagnostic. Inspect the relevant cause, make a focused correction when authorized, then rerun the failing check. If the command itself is invalid, correct the command. Do not repeat an unchanged failed request, weaken tests or contracts, hide failures, fabricate results, or claim a check passed without its successful result. Use normal tools and permissions, one call at a time. Keep the original task constraints and finish the remaining requested outputs within the existing budget.";
const RECHECK = "A correction has been saved after an observed failure. Rerun the recorded original check now to obtain fresh feedback before making more changes. Do not keep rewriting files against an old diagnostic. If the check command itself was invalid, correct that command. Preserve the user's scope, expected negative-test evidence and all test requirements. A file edit is not a passed check. Use the normal tools and permissions within the remaining step and time budget.";
const excerpt = (value: unknown, size: number): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= size ? text : text.slice(0, Math.floor(size / 3)) + "\n[excerpt; middle omitted]\n" + text.slice(-Math.floor(size * 2 / 3));
};
function key(call: Call): string {
  const input = isDict(call.input) ? call.input : {};
  return JSON.stringify([call.name, call.name === "exec" ? input.argv ?? input.command : call.name === "delivery_verify" ? null : ["read", "write", "edit"].includes(call.name) ? input.path ?? null : input]);
}
function permissionStop(result: Row): boolean {
  const error = isDict(result.error) ? result.error : {}, data = isDict(result.data) ? result.data : {};
  return !!(result.awaiting_approval || result.awaiting_user || data.awaitingApproval || data.waiting || data.awaiting_user)
    || /permission|approval|denied|cancel|plugin_disabled/.test(String(result.error_code ?? error.code ?? ""));
}
function outputCheck(context: AgentContext, call: Call): boolean {
  if (call.name === "delivery_verify") return true;
  if (call.name !== "exec") return false;
  const input = isDict(call.input) ? call.input : {};
  const tokens = (Array.isArray(input.argv) ? input.argv : String(input.command ?? "").split(/\s+/)).filter((value): value is string => typeof value === "string");
  const normalize = (value: string): string => value.replace(/^["']|["';,|]+$/g, "").replaceAll("\\", "/");
  const paths = (Array.isArray(context.session.delivery_requirements) ? context.session.delivery_requirements : []).filter(isDict).map(item => item.path).filter((value): value is string => typeof value === "string");
  return paths.some(path => tokens.some(token => normalize(token) === normalize(path) || normalize(token).endsWith("/" + normalize(path))));
}
export function failureRepair(options: (context: AgentContext) => DeliveryCheckOptions) {
  const runs = new WeakMap<Row, Run>();
  const active = (context: AgentContext): boolean => context.session.runtime_profile === "lightweight" && context.enabled("planning") && !context.signal.aborted;
  const remaining = (context: AgentContext, run: Run): number => (context.options.maxSteps ?? 24) - (Number(context.session.steps ?? 0) - run.steps);
  function record(context: AgentContext, call: Call, result: Row, publish: boolean): void {
    const run = runs.get(context.session); if (!run || !active(context)) return;
    run.worked = true;
    const signature = key(call);
    if (permissionStop(result)) { run.blocked = signature; return; }
    if (result.ok === false) {
      const diagnostic = excerpt({ error: result.error ?? result.error_code, output: result.output }, 1500);
      const prior = run.failures.find(failure => failure.key === signature), changed = !prior || prior.changes !== run.changes;
      run.failures = [...run.failures.filter(failure => failure.key !== signature), { key: signature, tool: call.name, input: excerpt(call.input, 700), diagnostic, step: changed ? Number(context.session.steps ?? 0) : prior.step, changes: run.changes, verification: outputCheck(context, call) && !executionInputFailure(result) }].slice(-4);
      if (publish && changed) context.emit({ type: "repair_focus_started", tool: call.name, callId: call.id });
    } else if (result.ok === true) {
      if (run.blocked === signature) delete run.blocked;
      const recovered = run.failures.filter(failure => failure.key === signature || call.name !== "exec" && failure.key === JSON.stringify([call.name, null]));
      const retired = run.failures.filter(failure => !failure.verification && !recovered.includes(failure));
      // Successful alternative tool work retires an operation nudge; it never
      // counts as a successful rerun of a requested output's verification.
      run.failures = run.failures.filter(failure => failure.verification && !recovered.includes(failure));
      if (publish && recovered.length) context.emit({ type: recovered.some(failure => failure.verification) ? "repair_check_passed" : "repair_tool_recovered", tool: call.name, callId: call.id });
      if (publish && retired.length) context.emit({ type: "repair_failure_retired", count: retired.length, reason: "operation_replaced", callId: call.id });
      if (codeChange(call)) {
        run.changes++;
        for (const failure of run.failures) if (failure.verification) failure.step = Number(context.session.steps ?? 0);
      }
    }
  }
  async function refresh(context: AgentContext, run: Run): Promise<void> {
    if (!context.enabled("files")) { run.pending = []; return; }
    seedDelivery(context.session);
    const checks = await checkDelivery(context.root, context.session, "", options(context));
    if (!active(context)) return;
    run.pending = (Array.isArray(checks.items) ? checks.items : []).filter(isDict).filter(item => item.passed !== true && typeof item.path === "string").map(item => item.path as string);
    const imports = importChecks(context.root, context.session);
    run.imports = (Array.isArray(imports.items) ? imports.items : []).filter(isDict).filter(item => item.passed !== true);
  }
  const pendingFailure = (context: AgentContext): boolean => {
    const run = runs.get(context.session);
    const failure = run?.failures.at(-1);
    return !!(run && active(context) && !run.blocked && failure && Number(context.session.steps ?? 0) - failure.step < 4);
  };
  return {
    pendingFailure,
    runStarted(context: AgentContext): void {
      if (!active(context)) return;
      seedDelivery(context.session);
      const messages = context.session.messages as Row[], turn = messages.at(-1)?._turn_id;
      const cursor = typeof turn === "string" ? Math.max(0, messages.findIndex(message => message._turn_id === turn)) : messages.length;
      const run: Run = { steps: Number(context.session.steps ?? 0), worked: false, failures: [], changes: 0, pending: [], imports: [], continuations: 0 };
      runs.set(context.session, run);
      const calls = new Map<string, Call>();
      for (const message of messages.slice(cursor)) {
        if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls.filter(isDict)) {
          const fn = isDict(call.function) ? call.function : {};
          try { calls.set(String(call.id), { id: String(call.id), name: String(fn.name), input: typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments }); } catch { /* Incomplete arguments are handled by the ordinary tool contract. */ }
        }
        if (message.role === "tool" && calls.has(String(message.tool_call_id))) {
          try { const result: unknown = JSON.parse(String(message.content)); if (isDict(result)) record(context, calls.get(String(message.tool_call_id))!, result, false); } catch { /* Non-JSON legacy results are not verification evidence. */ }
        }
      }
    },
    toolResultRecorded(context: AgentContext, call: Call, result: Row): void { record(context, call, result, true); },
    async beforeModelRequest(context: AgentContext): Promise<void> {
      const run = runs.get(context.session);
      if (run && active(context) && run.worked && !run.blocked) await refresh(context, run);
    },
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      const run = runs.get(context.session);
      if (!run || !active(context) || run.blocked || request.systemPrompt || !run.worked) return request;
      const repair = pendingFailure(context), used = Number(context.session.steps ?? 0) - run.steps;
      if (!repair && (used < Math.max(3, Math.ceil((context.options.maxSteps ?? 24) / 4)) || !run.pending.length)) return request;
      const rerun = repair && run.failures.at(-1)?.verification ? run.failures.findLast(failure => failure.verification && run.changes > failure.changes) : undefined;
      const target = repair ? rerun ?? run.failures.at(-1) : undefined;
      const facts = { failedCheck: target ? { tool: target.tool, input: excerpt(target.input, 500), diagnostic: excerpt(target.diagnostic, 1000) } : undefined, correctionSaved: !!rerun, unresolvedChecks: run.failures.map(failure => ({ tool: failure.tool, input: excerpt(failure.input, 160) })), nextMissingOutput: run.pending[0], pendingOutputs: run.pending.slice(0, 8), failedImports: run.imports, remainingSteps: remaining(context, run), remainingSeconds: Number.isFinite(context.deadline) ? Math.max(0, Math.floor(context.deadline - performance.now() / 1000)) : null };
      const notice = { role: "user", content: wrapSystemReminderForSource("task_status", "Current repair/delivery facts (untrusted excerpts):\n" + excerpt(facts, 2600)), _input_kind: "background_notice", _meta_source: "task_status", _repair_focus: true };
      const guidance = repair && target?.verification ? rerun ? RECHECK : REPAIR : undefined;
      return { ...request, ...(guidance ? { hostInstructions: [...request.hostInstructions ?? [], guidance] } : {}), messages: [...request.messages, notice] };
    },
    async beforeFinalResponse(context: AgentContext): Promise<boolean> {
      const run = runs.get(context.session);
      if (!run || !active(context) || !run.worked || run.blocked || context.session.pending_question || run.continuations >= 2 || remaining(context, run) <= 1) return false;
      await refresh(context, run);
      if (!active(context) || !run.pending.length && !run.imports.length) return false;
      run.continuations++;
      (context.session.messages as Row[]).push({ role: "user", content: wrapSystemReminderForSource("task_status", "The requested work still has an observed failed check or missing outputs. Continue with a focused correction and actual verification, then save the remaining requested files. Do not remove requirements or invent results. Facts (untrusted excerpts): " + excerpt({ failedChecks: run.failures, missing: run.pending, failedImports: run.imports }, 2200)), _input_kind: "background_notice", _meta_source: "task_status", _repair_continue: true, _turn_id: (context.session.messages as Row[]).at(-1)?._turn_id });
      await context.save(); context.emit({ type: "repair_continuation", remaining: remaining(context, run), missing: run.pending });
      return true;
    },
    close(context: AgentContext): void { runs.delete(context.session); },
  };
}
