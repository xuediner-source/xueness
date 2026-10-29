/** Planning schedules its own gated verifier; the model does not decide its verdict. */
import { resolve } from "node:path";
import { isDict, uuid4Hex } from "@xueness/contracts";
import type { AgentContext, ModelRequest, Row } from "@xueness/agent";
import { deliveryFingerprint, importChecks, importContract } from "./delivery-verification.ts";
import { codeChange } from "./repair-input.ts";

export function deliveryVerification() {
  const runs = new WeakMap<Row, { available: boolean; blocked: boolean; generated: Set<string> }>();
  const active = (context: AgentContext): boolean => context.session.runtime_profile === "lightweight" && context.enabled("planning") && context.enabled("files")
    && context.provider.toolCalling !== "json" && (context.session.permission_mode === "yolo" || !context.session.read_only && context.session.mode !== "plan") && !context.signal.aborted;
  return {
    runStarted(context: AgentContext): void { runs.set(context.session, { available: false, blocked: false, generated: new Set() }); },
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      const run = runs.get(context.session);
      const required = importContract(context.session).paths.length > 0;
      if (!required && context.session.runtime_profile === "lightweight") request = { ...request, tools: request.tools.filter(tool => !isDict(tool.function) || tool.function.name !== "delivery_verify") };
      if (run) run.available = required && active(context) && request.tools.some(tool => isDict(tool.function) && tool.function.name === "delivery_verify");
      return request;
    },
    async afterModelResponse(context: AgentContext, response: Row): Promise<Row> {
      const run = runs.get(context.session), remaining = context.deadline - performance.now() / 1000;
      if (!run?.available || run.blocked || !active(context) || remaining <= 1 || response._protocol_error || response._finish_reason === "length") return response;
      const calls = Array.isArray(response.tool_calls) ? response.tool_calls.filter(isDict) : [];
      if (calls.some(call => isDict(call.function) && /^(?:delivery_verify|ask_user|AskUserQuestion|exit_plan_mode|ExitPlanMode)$/.test(String(call.function.name)))) return response;
      const changes = calls.flatMap(call => {
        const fn = isDict(call.function) ? call.function : {};
        try {
          const input: unknown = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
          if (!isDict(input)) return [];
          const path = input.path ?? input.file_path;
          const change = { name: String(fn.name).toLowerCase(), input: { ...input, path } };
          return codeChange(change) && typeof path === "string" ? [path] : [];
        } catch { return []; }
      });
      const { paths } = importContract(context.session);
      if (!paths.length || paths.some(path => !deliveryFingerprint(context.root, path) && !changes.some(changed => resolve(context.root, changed) === resolve(context.root, path)))) return response;
      const checks = importChecks(context.root, context.session);
      const unchecked = Array.isArray(checks.items) && checks.items.some(item => isDict(item) && item.assessed === false);
      if (!changes.length && !unchecked) return response;
      const id = "delivery_verify_" + uuid4Hex(); run.generated.add(id);
      context.emit({ type: "delivery_verification_scheduled", callId: id, paths });
      return { ...response, tool_calls: [...calls, { id, type: "function", function: { name: "delivery_verify", arguments: JSON.stringify({ timeout_ms: Math.min(10000, Math.floor(remaining * 1000) - 1000) }) } }] };
    },
    beforeTool(context: AgentContext, call: { id: string; name: string }): Row | undefined {
      const run = runs.get(context.session);
      if (call.name === "delivery_verify" && run?.generated.has(call.id) && (run.blocked || !active(context))) return { ok: false, error_code: "run_paused", output: "Independent verification paused with the run or preceding permission refusal" };
    },
    async toolResultRecorded(context: AgentContext, call: { id: string; name: string; input?: unknown }, result: Row): Promise<void> {
      const run = runs.get(context.session), error = isDict(result.error) ? result.error : {};
      if (run && (result.awaiting_approval || /permission|approval|denied|cancel|plugin_disabled/.test(String(result.error_code ?? error.code ?? "")))) run.blocked = true;
      if (result.ok === true && codeChange(call)) {
        context.session.delivery_code_version = Number(context.session.delivery_code_version ?? 0) + 1;
        await context.save();
      }
      if (call.name === "delivery_verify") { await context.save(); context.emit({ type: "delivery_verification_recorded", callId: call.id, passed: result.ok === true }); }
    },
    checks(context: AgentContext): Row { return importChecks(context.root, context.session); },
    close(context: AgentContext): void { runs.delete(context.session); },
  };
}
