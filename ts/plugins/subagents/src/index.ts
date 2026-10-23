/**
 * Sub-agents as a TypeScript plugin (Python `bundled_plugins/subagents`; the
 * model contract and agent types from ZCode v3.15.1, see profiles.ts and the
 * agent package's `tool-contract/agent-contract.ts`).
 *
 * The Xueness tool stays `task` (journal, Python and the sessions projection
 * key on it); the model sees ZCode's `Agent`. With no coordinator bound the
 * call runs one read-only child in the foreground and returns its final
 * message. When the host binds a `TaskCoordinator` for the run, the same tool
 * dispatches in the background and the three coordination tools
 * (`task_collect`, `task_resume`, `task_send_message`) become available; that
 * binding is exactly what `subagents.coordination` advertises, so a session
 * with uncollected rows never reaches a backend that lacks it.
 */
import { isDict } from "@xueness/contracts";
import { modelToolName, wrapSystemReminderForSource, type AgentContext, type AgentExtension, type ModelRequest } from "@xueness/agent";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { backgroundTools, BACKGROUND_TOOL_NAMES, type CoordinationBinding } from "./background-tools.ts";
import type { TaskCoordinator } from "./coordinator.ts";
import { loadSubagents, TASK_TOOL_NAME, type Row } from "./definitions.ts";
import { agentListing } from "./profiles.ts";

export * from "./definitions.ts";
export * from "./profiles.ts";
export * from "./records.ts";
export * from "./resources-http.ts";
export * from "./task-registry.ts";
export * from "./child-journal.ts";
export * from "./coordinator.ts";
export * from "./tasks-http.ts";
export * from "./background-tools.ts";

export const AGENT_LISTING_SOURCE = "agent_listing_delta";
/**
 * Tools a child never gets: delegation itself, the plan-mode switches (ZCode
 * `SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS`), and the planning tools that act
 * on the parent's session (questions, task list, delivery plan); Python's
 * durable workflow writes.
 */
export const CHILD_DENIED_TOOLS: readonly string[] = Object.freeze([TASK_TOOL_NAME, "enter_plan_mode", "exit_plan_mode", "ask_user", "todo_read", "todo_write", "delivery_plan", "workflow_create", "workflow_amend"]);

/**
 * The host's binding for the run in progress. `run` is the foreground child
 * runner; `background` starts the same child under a task id the coordinator
 * already allocated; `coordinator` is present only when this run advertises
 * `subagents.coordination`.
 */
export interface SubagentsBinding extends CoordinationBinding {
  run: ((input: Row, signal: AbortSignal | undefined) => Promise<ToolResult>) | null;
  /** Runs one child under an already-allocated task id (dispatch, then resume). */
  background: ((taskId: string, stopped: () => boolean, args: Row) => Promise<Row>) | null;
}
export const subagentsBinding = (): SubagentsBinding => ({ run: null, background: null, coordinator: null });

const failure = (code: string, message: string): ToolResult<never> => ({ ok: false, output: message, error: { code, message } });

/** A coordinator outcome is a Python-shaped row; the model reads it as JSON. */
const receipt = (outcome: Row, code: string): ToolResult<Row> => {
  const ok = outcome.ok === true;
  const message = typeof outcome.error === "string" && outcome.error ? outcome.error : "subagent task refused";
  return { ok, output: ok ? JSON.stringify(outcome) : message, data: outcome, ...(ok ? {} : { error: { code, message } }) };
};

export function taskTool(binding: SubagentsBinding): ToolDefinition<Row> {
  return {
    name: TASK_TOOL_NAME,
    description: "Run a focused read-only subagent. Without background coordination it returns the final report; with it, the call returns a task_id and the report arrives through task_collect. The prompt must carry everything it needs.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, agent: { type: "string" }, description: { type: "string" }, inherit_history: { type: "boolean" } },
      required: ["prompt"], additionalProperties: false },
    gate: "planning", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => typeof input.prompt === "string" ? input.prompt : "",
    async run(input, env) {
      const coordinator = binding.coordinator;
      const background = binding.background;
      if (coordinator && background) {
        // `dispatch` starts the executor without a third argument, so the call's
        // own input is the fallback for a new child.
        const outcome = coordinator.dispatch(undefined, input, (taskId, stopped, args) => background(taskId, stopped, args ?? input));
        return receipt(outcome, "agent_subagent_dispatch");
      }
      const run = binding.run;
      if (!run) return failure("agent_subagent_unavailable", "task requires an active parent run that allows subagents");
      return run(input, env.signal);
    },
  };
}

export function createSubagents(binding: SubagentsBinding): BundledPlugin {
  const tools: readonly ToolDefinition<Row>[] = [taskTool(binding), ...backgroundTools(binding)];
  return { manifest, plugin: definePlugin({ name: "subagents", apply(ctx) { for (const tool of tools) ctx.tool(tool as ToolDefinition); } }) };
}

const nameOf = (tool: Row): string | null => isDict(tool.function) && typeof tool.function.name === "string" ? tool.function.name : null;
const lightweight = (context: AgentContext): boolean => (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";

/**
 * `subagents.tasks` (and `subagents.coordination` once the host binds a
 * coordinator): the task tool is offered only when the request allows
 * delegation; the standard runtime then gets ZCode's agent-type listing as a
 * request-only system reminder after the system prompt, rebuilt from the
 * definitions on every request (it survives compaction, never enters the journal).
 */
export function subagentsExtension(options: { stateDir: string; allowed: boolean; binding?: CoordinationBinding }): AgentExtension {
  return {
    id: "subagents",
    get capabilities(): readonly string[] {
      return options.binding?.coordinator ? ["subagents.tasks", "subagents.coordination"] : ["subagents.tasks"];
    },
    prepareRequest(context, request): ModelRequest {
      const names = request.tools.map(nameOf);
      if (!names.includes(TASK_TOOL_NAME)) return request;
      const coordination = options.binding?.coordinator != null;
      // A remote-bound session runs no local child at all.
      if (context.session.remote_connection) {
        const denied = new Set<string>([TASK_TOOL_NAME, ...BACKGROUND_TOOL_NAMES]);
        return { ...request, tools: request.tools.filter((tool) => !denied.has(nameOf(tool) ?? "")) };
      }
      // Without a coordinator the model must not see a tool that could never
      // run; `task` itself stays, as the foreground runner still backs it.
      const withoutBackground = options.binding?.coordinator ? request.tools
        : request.tools.filter((tool) => !BACKGROUND_TOOL_NAMES.includes(nameOf(tool) ?? ""));
      // This request may not dispatch new children, but results already
      // recorded for the turn still have to be collectable.
      if (!options.allowed) return { ...request, tools: withoutBackground.filter((tool) => nameOf(tool) !== TASK_TOOL_NAME) };
      const offered = { ...request, tools: withoutBackground };
      if (lightweight(context)) return offered;
      const available = names.filter((name): name is string => !!name && !CHILD_DENIED_TOOLS.includes(name)).map(modelToolName);
      const listing = agentListing(loadSubagents(options.stateDir), available);
      const message = { role: "user", content: wrapSystemReminderForSource(AGENT_LISTING_SOURCE, listing), _meta_source: AGENT_LISTING_SOURCE };
      return { ...offered, messages: [request.messages[0]!, message, ...request.messages.slice(1)] };
    },
  };
}

/** The bundled entry (catalog, plugin gate); the server binds its own runner. */
export const subagents: BundledPlugin = createSubagents(subagentsBinding());
