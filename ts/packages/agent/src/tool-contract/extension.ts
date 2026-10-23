/**
 * Agent extension for the ZCode tool contracts (see projection.ts). It runs
 * after the prompt view, so the view's tool-name guidance sees the ZCode names.
 * The lightweight runtime keeps the Xueness names: it has its own short prompt
 * and tool policy.
 */
import { isDict } from "@xueness/contracts";
import type { AgentContext, AgentExtension, ModelRequest, Row } from "../types.ts";
import type { AdapterContext } from "./adapters.ts";
import { modelInputOf } from "../tool-media.ts";
import { journalCall, modelMessages, modelTools } from "./projection.ts";

interface ContractState { errors: Map<string, string>; properties: Map<string, Set<string>> }
const states = new WeakMap<AgentContext, ContractState>();
function stateOf(context: AgentContext): ContractState {
  let state = states.get(context);
  if (!state) states.set(context, state = { errors: new Map(), properties: new Map() });
  return state;
}
const lightweight = (context: AgentContext): boolean => (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";

function adapterContext(context: AgentContext): AdapterContext {
  const state = stateOf(context);
  return { root: context.root, accepts: (tool, property) => state.properties.get(tool)?.has(property) ?? false };
}

export function toolContractExtension(): AgentExtension {
  return {
    id: "sessions", capabilities: ["sessions.tool_contract"],
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      const state = stateOf(context);
      for (const tool of request.tools) {
        const fn = isDict(tool.function) ? tool.function : null;
        const properties = fn && isDict(fn.parameters) && isDict(fn.parameters.properties) ? Object.keys(fn.parameters.properties) : [];
        if (fn && typeof fn.name === "string") state.properties.set(fn.name, new Set(properties));
      }
      if (lightweight(context)) return request;
      return { ...request, tools: modelTools(request.tools, { pdf: modelInputOf(context.provider).pdf }), messages: modelMessages(request.messages, adapterContext(context)) };
    },
    afterModelResponse(context: AgentContext, response: Row): Row {
      if (!Array.isArray(response.tool_calls)) return response;
      const state = stateOf(context);
      const calls = response.tool_calls.map((call: unknown) => {
        if (!isDict(call)) return call;
        const inbound = journalCall(call, adapterContext(context));
        if (inbound.error && typeof call.id === "string") state.errors.set(call.id, inbound.error);
        return inbound.call;
      });
      return { ...response, tool_calls: calls };
    },
    beforeTool(context, call): Row | null {
      const state = stateOf(context);
      const error = state.errors.get(call.id);
      if (error === undefined) return null;
      state.errors.delete(call.id);
      return { ok: false, output: error, error: { code: "invalid_argument", message: error } };
    },
  };
}
