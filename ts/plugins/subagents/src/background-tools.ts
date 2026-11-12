/**
 * Background delegation tools (ZCode `task_collect`, `task_resume`,
 * `task_send_message`). They are registered always but only reach a request
 * when the host bound a `TaskCoordinator` for the run — that binding is what
 * `subagents.coordination` means, and without it the plugin keeps the
 * foreground `task` tool alone.
 */
import { pyJsonDumps } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import type { TaskCoordinator } from "./coordinator.ts";
import type { Row } from "./definitions.ts";

export const COLLECT_TOOL_NAME = "task_collect";
export const RESUME_TOOL_NAME = "task_resume";
export const SEND_MESSAGE_TOOL_NAME = "task_send_message";
export const CANCEL_TOOL_NAME = "task_cancel";
/** The four tools that only exist with a coordinator. */
export const BACKGROUND_TOOL_NAMES: readonly string[] = Object.freeze([COLLECT_TOOL_NAME, RESUME_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, CANCEL_TOOL_NAME]);

export interface CoordinationBinding { coordinator: TaskCoordinator | null }

const failure = (code: string, message: string): ToolResult<never> => ({ ok: false, output: message, error: { code, message } });
const UNAVAILABLE = "background subagents require an active parent run that allows subagents";
const messageOf = (error: unknown, fallback: string): string =>
  typeof error === "string" && error ? error : fallback;

/** A coordinator outcome is a Python-shaped row; the model reads it as JSON. */
function settle(outcome: Row, code: string): ToolResult<Row> {
  const ok = outcome.ok === true;
  return { ok, output: pyJsonDumps(outcome, { separators: [",", ":"] }), data: outcome,
    ...(ok ? {} : { error: { code, message: messageOf(outcome.error, "subagent task refused") } }) };
}

export function collectTool(binding: CoordinationBinding): ToolDefinition<Row> {
  return {
    name: COLLECT_TOOL_NAME,
    description: "Collect this parent turn's subagent results. Keep working independently after task dispatch. Default wait_seconds=0. Wait only for a dependency or when no independent work remains; provide reason and detail. Every child result must be collected before finalizing.",
    inputSchema: {
      type: "object",
      properties: {
        task_ids: { type: "array", items: { type: "string" }, description: "Tasks to collect; every task of this turn when omitted." },
        wait_seconds: { type: "number", description: "0-30; 0 returns whatever is ready." },
        reason: { type: "string", enum: ["dependency", "no_independent_work"], description: "Required when waiting." },
        detail: { type: "string", description: "Why the wait is needed (required when waiting)." },
      },
      additionalProperties: false,
    },
    gate: "planning", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => Array.isArray(input.task_ids) ? input.task_ids.filter((id) => typeof id === "string").join(",") : "",
    async run(input) {
      const coordinator = binding.coordinator;
      if (!coordinator) return failure("agent_subagent_unavailable", UNAVAILABLE);
      return settle(await coordinator.collect(input), "agent_subagent_collect");
    },
  };
}

export function resumeTool(binding: CoordinationBinding): ToolDefinition<Row> {
  return {
    name: RESUME_TOOL_NAME,
    description: "Explicitly continue this parent's retained read-only child session. A completed child requires a followup message; cancelled children cannot resume. Returns a background receipt; collect its result with task_collect.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The child task to continue." },
        message: { type: "string", description: "Followup message; required for a completed child." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    gate: "planning", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => typeof input.task_id === "string" ? input.task_id : "",
    async run(input) {
      const coordinator = binding.coordinator;
      if (!coordinator) return failure("agent_subagent_unavailable", UNAVAILABLE);
      return settle(coordinator.resume(undefined, input), "agent_subagent_resume");
    },
  };
}

export function sendMessageTool(binding: CoordinationBinding): ToolDefinition<Row> {
  return {
    name: SEND_MESSAGE_TOOL_NAME,
    description: "Guide this parent's active child at its next safe provider/tool boundary. With escalation_id the message answers that child's pending blocking question. The child keeps its retained history and read-only permissions.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The running child task." },
        message: { type: "string", description: "The guidance to deliver; or the answer when escalation_id is set." },
        requestId: { type: "string", description: "Idempotency key for this message." },
        escalation_id: { type: "string", description: "Escalation to answer instead of enqueueing a plain message." },
        summary: { type: "string", description: "Optional 1..200 char hint shown with the delivery receipt." },
      },
      required: ["task_id", "message", "requestId"],
      additionalProperties: false,
    },
    gate: "planning", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => typeof input.task_id === "string" ? input.task_id : "",
    async run(input) {
      const coordinator = binding.coordinator;
      if (!coordinator) return failure("agent_subagent_unavailable", UNAVAILABLE);
      return settle(coordinator.sendMessage(input, input.requestId), "agent_subagent_send_message");
    },
  };
}

export function cancelTool(binding: CoordinationBinding): ToolDefinition<Row> {
  return {
    name: CANCEL_TOOL_NAME,
    description: "Stop exactly one of this parent's running children. The child observes the cancellation at its next safe provider/tool boundary; its exclusive resources are released and a diagnosable termination reason is retained. Collect the cancelled result like any other.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The running child task to cancel." },
        detail: { type: "string", description: "Why the child is being cancelled (kept for diagnosis)." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    gate: "planning", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => typeof input.task_id === "string" ? input.task_id : "",
    async run(input) {
      const coordinator = binding.coordinator;
      if (!coordinator) return failure("agent_subagent_unavailable", UNAVAILABLE);
      return settle(coordinator.cancelTask(input.task_id, input.detail), "agent_subagent_cancel");
    },
  };
}

export const RESPOND_TOOL_NAME = "respond_to_coordinator";

/**
 * The child side of the escalation protocol (F08.03): ask the coordinating
 * parent one blocking question. The tool exists on the kernel so a subagent
 * child can reach it, but it only runs where the host bound `escalationPort`
 * — everywhere else (any parent session) it refuses, which is the message vs.
 * authorization boundary drawn at the tool contract, not the caller's word.
 */
export function respondToCoordinatorTool(): ToolDefinition<Row> {
  return {
    name: RESPOND_TOOL_NAME,
    description: "Ask the coordinating parent one blocking question when you cannot proceed without its answer. One pending question per task; the answer arrives as a coordinator message at your next safe boundary.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The single question to raise (1..24000 characters)." },
        requestId: { type: "string", description: "Idempotency key for this escalation." },
      },
      required: ["question", "requestId"],
      additionalProperties: false,
    },
    gate: "planning", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => typeof input.question === "string" ? input.question : "",
    async run(input, env) {
      const port = env.escalationPort;
      if (!port) return failure("agent_subagent_not_child", "respond_to_coordinator is only available to a delegated subagent child");
      if (typeof input.question !== "string" || !input.question.trim()) return failure("invalid_argument", "question must contain 1..24000 characters");
      if (typeof input.requestId !== "string" || !input.requestId.trim()) return failure("invalid_argument", "requestId is required");
      try {
        const outcome = port.escalate(input.question, input.requestId);
        return { ok: true, output: pyJsonDumps(outcome, { separators: [",", ":"] }), data: outcome };
      } catch (error) {
        return failure("agent_subagent_escalation_refused", error instanceof Error ? error.message : "escalation refused");
      }
    },
  };
}

export function backgroundTools(binding: CoordinationBinding): readonly ToolDefinition<Row>[] {
  return [collectTool(binding), resumeTool(binding), sendMessageTool(binding), cancelTool(binding)];
}
