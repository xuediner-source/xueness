/**
 * The remote-session tool boundary (Python `tool_registry.REMOTE_ALLOWED_TOOL_NAMES`,
 * the `core.run` catalog filter and the `dispatch` checks). A session bound to a
 * saved SSH target sees and runs only remote-safe tools; `remote_exec` must name
 * the bound connection and digest. Python applies this outside any plugin
 * switch, so the extension carries the always-on `sessions` id.
 */
import { isDict } from "@xueness/contracts";
import { internalToolName, type AgentExtension, type Row } from "@xueness/agent";

export const REMOTE_ALLOWED_TOOLS: readonly string[] = Object.freeze(["remote_exec", "web_fetch", "web_search", "image_search", "ask_user", "todo_read",
  "todo_write", "workflow_create", "workflow_amend", "workflow_status", "tool_search", "tool_result_read"]);
const ALLOWED = new Set(REMOTE_ALLOWED_TOOLS);

/** `permission_result` for a PermissionError: a policy refusal, never an approval wait. */
export function remoteDenied(): Row {
  return { ok: false, error: "denied", error_code: "permission_denied", awaiting_approval: false, retryable: false, user_reason: "当前权限策略禁止此工具；请调整权限或任务要求。" };
}

/** Local tool names a remote-bound run must never execute (`REMOTE_LOCAL_TOOL_NAMES`). */
export function remoteLocalTools(names: Iterable<string>): string[] {
  return [...new Set(names)].filter((name) => !ALLOWED.has(name));
}

const schemaName = (schema: Row): string => isDict(schema.function) && typeof schema.function.name === "string" ? internalToolName(schema.function.name) : "";

export function remoteSessionExtension(): AgentExtension {
  return {
    id: "sessions",
    capabilities: ["remote.execution"],
    prepareRequest(context, request) {
      if (!context.session.remote_connection) return request;
      return { ...request, tools: request.tools.filter((schema) => ALLOWED.has(schemaName(schema))) };
    },
    beforeTool(context, call) {
      const bound = context.session.remote_connection;
      if (!bound) return null;
      const name = internalToolName(call.name);
      if (!ALLOWED.has(name)) return remoteDenied();
      if (name !== "remote_exec") return null;
      const input = isDict(call.input) ? call.input : {};
      if (!isDict(bound) || input.connection !== bound.id || input.connection_digest !== bound.digest) return remoteDenied();
      return null;
    },
  };
}
