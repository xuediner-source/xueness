/**
 * The DeferredToolCall contract (C-TOOL-04): a model calls the always-exposed
 * `deferred_tool_call` envelope with `{tool, input}` to invoke a `shouldDefer`
 * tool it discovered this turn (tool_search or equivalent) — the schema of a
 * deferred tool never enters the request. The agent runtime admits the
 * envelope before dispatch and unwraps it into a real call to the registered
 * target, which then takes the same owner / active / bridge path as a direct
 * call: one permission table, one scheduler, one result association. Shared
 * here so the wrapper tool and the admission point cannot drift apart.
 */
import { isDict, validateSchema, formatSchemaIssues, type JsonSchema } from "@xueness/contracts";

/** The wrapper tool the model calls to invoke a deferred tool by reference. */
export const DEFERRED_TOOL_CALL = "deferred_tool_call";

export const DEFERRED_TOOL_CALL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    tool: { type: "string", minLength: 1, maxLength: 512, description: "The registered name of the deferred tool to call." },
    input: { type: "object", description: "The target tool's arguments object." },
  },
  required: ["tool"],
  additionalProperties: false,
};

export interface DeferredCallResolution {
  /** The real registered tool the envelope wraps (trimmed). */
  target: string;
  /** The wrapped arguments object; an absent envelope input means `{}`. */
  input: Record<string, unknown>;
}

/**
 * Validate an envelope against the wrapper schema. Returns the wrapped call,
 * or the first schema issue as a readable `issue` — never a silent success.
 */
export function resolveDeferredToolCall(args: unknown): DeferredCallResolution | { issue: string } {
  const issues = validateSchema(DEFERRED_TOOL_CALL_SCHEMA, args);
  if (issues.length) return { issue: formatSchemaIssues(issues) };
  const envelope = args as Record<string, unknown>;
  const target = String(envelope.tool).trim();
  if (!target) return { issue: "/tool must name a target tool" };
  return { target, input: isDict(envelope.input) ? { ...envelope.input } : {} };
}
