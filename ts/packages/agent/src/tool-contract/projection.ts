/**
 * What the model sees of a request, and what a model call becomes in the journal.
 *
 * Outbound (request view, journal untouched): contract tools are advertised with
 * their ZCode name, description and schema in ZCode's provider order; journal
 * tool calls are shown as the model sent them (`_model_call`), or rebuilt from
 * the Xueness input for older sessions; their results read as ZCode tool
 * results (the output text, `<tool_use_error>…</tool_use_error>` on failure,
 * `(<Tool> completed with no output)` when empty).
 *
 * Inbound: a call to a ZCode name is coerced and checked against the ZCode
 * schema, then stored under the Xueness name and input with the original call
 * kept in `_model_call`. Calls to Xueness names (old sessions) pass unchanged.
 */
import { isDict } from "@xueness/contracts";
import type { AdapterContext } from "./adapters.ts";
import { contractFor, TOOL_CONTRACTS, type ToolContract } from "./contracts.ts";
import { readPdfDescription } from "./descriptions.ts";
import { READ_PDF_SCHEMA } from "./schemas-files.ts";
import { isModelContractName, orderProviderVisibleTools } from "./names.ts";
import { inputValidationError, semanticBoolean, semanticNumber } from "./validation.ts";

type Row = Record<string, unknown>;
export interface ModelCall { name: string; arguments: string }

function parseObject(text: unknown): Row | null {
  if (typeof text !== "string") return null;
  try { const value = JSON.parse(text) as unknown; return isDict(value) ? value : null; } catch { return null; }
}
const nameOf = (tool: Row): string => isDict(tool.function) && typeof tool.function.name === "string" ? tool.function.name : "";

/** The tool table the model sees; `pdf` when the model takes PDF documents (ZCode `resolveReadInputSchema`). */
export function modelTools(tools: readonly Row[], options: { pdf?: boolean } = {}): Row[] {
  const shown = tools.map((tool) => {
    const contract = TOOL_CONTRACTS.get(nameOf(tool));
    if (!contract) return tool;
    const strict = isDict(tool.function) && tool.function.strict === true ? { strict: true } : {};
    if (options.pdf === true && contract.internal === "read") return { type: "function", function: { name: contract.model, description: readPdfDescription(contract.description), parameters: READ_PDF_SCHEMA, ...strict } };
    return { type: "function", function: { name: contract.model, description: contract.description, parameters: contract.schema, ...strict } };
  });
  return orderProviderVisibleTools(shown, nameOf);
}

function resultContent(contract: ToolContract, content: unknown, input: Row | null): unknown {
  const row = parseObject(content);
  if (!row || !Object.hasOwn(row, "ok")) return content;
  if (row.awaiting_approval === true || row.awaiting_user === true) return content;
  const error = isDict(row.error) ? row.error : null;
  let output = typeof row.output === "string" ? row.output
    : typeof row.error === "string" ? row.error : typeof error?.message === "string" ? error.message : "";
  if (row.ok === true) {
    output = contract.render?.(row.data, input, output) ?? output;
    return output.trim() ? output : `(${contract.model} completed with no output)`;
  }
  const code = String(error?.code ?? row.error_code ?? "");
  output = contract.renderError?.[code]?.(input) ?? output;
  if (contract.plainErrors?.has(code)) return output.trim() ? output : `(${contract.model} completed with no output)`;
  if (output.startsWith("<tool_use_error>")) return output;
  return `<tool_use_error>${output || code || "tool failed"}</tool_use_error>`;
}

/**
 * An MCP result reads as ZCode `formatMcpToolResult`: the server's text, its
 * own error text after "MCP tool returned an error:" (already in the output),
 * or a `<tool_use_error>` when the call itself failed.
 */
function mcpContract(name: string): ToolContract {
  return { internal: name, model: name, description: "", schema: { type: "object" }, plainErrors: MCP_PLAIN_ERRORS, toModel: (input) => input, toInternal: (input) => input } as ToolContract;
}
const MCP_PLAIN_ERRORS: ReadonlySet<string> = new Set(["mcp_tool_error"]);

/** The journal messages as the model sees them. */
export function modelMessages(messages: readonly Row[], context: AdapterContext): Row[] {
  const contracts = new Map<string, { contract: ToolContract; input: Row | null }>();
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      let changed = false;
      const calls = message.tool_calls.map((call: unknown) => {
        if (!isDict(call) || !isDict(call.function)) return call;
        const saved = isDict(call._model_call) && typeof call._model_call.name === "string" && typeof call._model_call.arguments === "string" ? call._model_call as unknown as ModelCall : null;
        const contract = contractFor(String(call.function.name));
        if (!contract && !saved && typeof call.id === "string" && String(call.function.name).startsWith("mcp__")) contracts.set(call.id, { contract: mcpContract(String(call.function.name)), input: null });
        if (!contract && !saved) return call;
        if (contract && typeof call.id === "string") contracts.set(call.id, { contract, input: parseObject(call.function.arguments) });
        changed = true;
        const { _model_call: _, ...rest } = call;
        if (saved) return { ...rest, function: { ...call.function, name: saved.name, arguments: saved.arguments } };
        const input = parseObject(call.function.arguments);
        const args = input ? JSON.stringify(contract!.toModel(input, context)) : String(call.function.arguments);
        return { ...rest, function: { ...call.function, name: contract!.model, arguments: args } };
      });
      return changed ? { ...message, tool_calls: calls } : message;
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      const known = contracts.get(message.tool_call_id);
      if (known) {
        const content = resultContent(known.contract, message.content, known.input);
        return content === message.content ? message : { ...message, content };
      }
    }
    return message;
  });
}

function coerce(contract: ToolContract, input: Row): Row {
  const out = { ...input };
  for (const key of contract.numbers ?? []) if (Object.hasOwn(out, key)) out[key] = semanticNumber(out[key]);
  for (const key of contract.booleans ?? []) if (Object.hasOwn(out, key)) out[key] = semanticBoolean(out[key]);
  return out;
}

export interface InboundCall { call: Row; error: string | null }

/** A provider tool call → the journal call, plus the ZCode error text when it cannot run. */
export function journalCall(call: Row, context: AdapterContext): InboundCall {
  if (!isDict(call.function) || typeof call.function.name !== "string" || !isModelContractName(call.function.name)) return { call, error: null };
  const contract = contractFor(call.function.name)!;
  const raw = String(call.function.arguments ?? "");
  const stored = (args: string): Row => ({ ...call, function: { ...call.function as Row, name: contract.internal, arguments: args }, _model_call: { name: contract.model, arguments: raw } });
  const parsed = raw.trim() ? parseObject(raw) : {};
  if (!parsed) return { call: stored(raw), error: null }; // not JSON: the runner reports invalid tool arguments
  const input = coerce(contract, parsed);
  const invalid = inputValidationError(contract.model, contract.schema, input);
  if (invalid) return { call: stored(raw), error: invalid };
  const internal = contract.toInternal(input, context);
  if (typeof (internal as { error?: unknown }).error === "string" && Object.keys(internal).length === 1) return { call: stored(raw), error: (internal as { error: string }).error };
  return { call: stored(JSON.stringify(internal)), error: null };
}
