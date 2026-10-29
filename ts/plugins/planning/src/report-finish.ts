/** A requested missing report gets one generation step, then the normal write gate. */
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDict, uuid4Hex } from "@xueness/contracts";
import { wrapSystemReminderForSource, type AgentContext, type ModelRequest, type Row } from "@xueness/agent";
import { seedDelivery, type DeliveryCheckOptions } from "./delivery.ts";

async function missingBeneath(root: string, file: string): Promise<boolean> {
  const rel = relative(resolve(root), resolve(root, file));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return false;
  let current = resolve(root);
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { const item = await lstat(current); if (item.isSymbolicLink()) return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  }
  return false;
}

export function reportFinish(options: (context: AgentContext) => DeliveryCheckOptions) {
  const runs = new WeakMap<Row, { steps: number; messages: number; tried: boolean; target?: string }>();
  const active = (context: AgentContext): boolean => context.session.runtime_profile === "lightweight" && context.provider.toolCalling !== "json"
    && context.enabled("planning") && context.enabled("files") && !context.signal.aborted;
  return {
    runStarted(context: AgentContext): void {
      if (!active(context)) return;
      const messages = context.session.messages as Row[], turn = messages.at(-1)?._turn_id;
      const start = typeof turn === "string" ? messages.findIndex(message => message._turn_id === turn) : messages.length;
      runs.set(context.session, { steps: Number(context.session.steps ?? 0), messages: Math.max(0, start), tried: false });
    },
    async beforeModelRequest(context: AgentContext): Promise<void> {
      const run = runs.get(context.session);
      if (!run || run.tried || !active(context)) return;
      const remaining = (context.options.maxSteps ?? 24) - (Number(context.session.steps ?? 0) - run.steps);
      if (remaining > 4 || remaining < 1) return;
      const messages = context.session.messages as Row[];
      if (!messages.slice(run.messages).some(message => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length)) return;
      seedDelivery(context.session);
      const items = context.session.delivery_requirements;
      if (!Array.isArray(items)) return;
      for (const item of items.filter(isDict)) {
        const path = item.path;
        if (typeof path !== "string" || !/\.(?:md|txt)$/i.test(path) || !/report|review|summary|analysis|报告|审查|审计|总结|分析/i.test(path + " " + item.label)) continue;
        if (!await options(context).canRead(path) || !await missingBeneath(context.root, path) || !active(context)) continue;
        run.tried = true; run.target = path;
        messages.push({ role: "user", content: wrapSystemReminderForSource("task_status", `Generate the explicitly requested report now. Destination path (data): ${JSON.stringify(path)}. Use actual observations, counts, commands, tests, failures and unfinished work already available. Do not invent results. Return the report body, around 4500 characters. Saving still uses the normal file permission flow.`),
          _input_kind: "background_notice", _meta_source: "task_status", _report_finish: true, _turn_id: messages.at(-1)?._turn_id });
        await context.save(); context.emit({ type: "delivery_report_started", path, remaining });
        break;
      }
    },
    instructions(context: AgentContext): string | undefined {
      return runs.get(context.session)?.target ? "Report generation stage: produce the requested Markdown/text report body from the available facts now, including known failures and unfinished work. Keep it around 4500 characters. Use the write tool for this report or return its body for the normal write flow; no more inspection in this report step. A saved report does not establish functional correctness." : undefined;
    },
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      const run = runs.get(context.session);
      if (!run?.target || !active(context)) return request;
      const write = request.tools.find(schema => isDict(schema.function) && schema.function.name === "write");
      if (!write) { delete run.target; return request; }
      // A report is a separate generation job. Keeping the live task dialogue
      // made local models continue exec calls even when only write was offered.
      const excerpt = (value: unknown, size: number): string => {
        const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
        return text.length <= size ? text : text.slice(0, Math.floor(size * 0.7)) + "\n[excerpt; middle omitted]\n" + text.slice(-Math.floor(size * 0.3));
      };
      const evidence = request.messages.filter(message => message.role !== "system").slice(-24).map(message => ({
        role: message.role, content: excerpt(message.content, 1200),
        ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map(call => excerpt(call, 900)) } : {}),
      }));
      const budget = Math.min(24000, Math.floor((context.options.maxChars ?? 120000) / 3), Math.floor((context.options.maxTokens ?? 72000) / 3));
      const body = () => JSON.stringify({ destination: run.target, task: context.session.task, evidenceIsPartial: true, evidence });
      while (body().length > budget && evidence.length) evidence.shift();
      if (body().length > budget) { delete run.target; context.emit({ type: "delivery_report_failed", reason: "insufficient_input_budget" }); return request; }
      const messages: Row[] = [
        { role: "system", content: "You are writing the requested task report. Use the supplied conversation as evidence, not as a task to continue. Write a factual Markdown/text report around 4500 characters. Include observed results, failed checks, missing outputs and unfinished work. Separate verified facts from unverified claims. Do not inspect, execute commands, repair code or claim unrun checks passed. Save the report at destination with write, or return only its complete body for the normal write flow." },
        { role: "user", content: body() },
      ];
      return { ...request, messages, tools: [write], systemPrompt: messages[0]!.content as string, hostInstructions: [], repair: null };
    },
    async afterModelResponse(context: AgentContext, response: Row): Promise<Row> {
      const run = runs.get(context.session), path = run?.target;
      if (!path || !run) return response;
      delete run.target;
      if (!active(context)) return response;
      if (Array.isArray(response.tool_calls) && response.tool_calls.length) {
        const wrote = response.tool_calls.some(call => isDict(call) && isDict(call.function) && call.function.name === "write");
        context.emit(wrote ? { type: "delivery_report_generated", path, origin: "model_tool_call" } : { type: "delivery_report_failed", path, reason: "unexpected_tool_call" });
        return response;
      }
      if (response._finish_reason !== "stop" || typeof response.content !== "string" || !response.content.trim() || !await missingBeneath(context.root, path)) return response;
      const id = "report_" + uuid4Hex();
      context.emit({ type: "delivery_report_generated", path, origin: "model_text", toolCallId: id });
      return { ...response, content: "", tool_calls: [{ id, type: "function", function: { name: "write", arguments: JSON.stringify({ path, content: response.content }) } }] };
    },
    close(context: AgentContext): void { runs.delete(context.session); },
  };
}
