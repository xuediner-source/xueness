import { isDict } from "@xueness/contracts";
import { runtimeOptions, type RuntimeProvider } from "./runtime-budget.ts";
import { runtimeToolName } from "./runtime-protocol.ts";
type Row = Record<string, unknown>;
export interface RuntimeToolPolicy {
  disallow?: Iterable<string>; allowed?: Iterable<string> | null; denied?: Iterable<string>; readonlyDenied?: Iterable<string>;
  /** Tools forced into the selected view in every profile (declared or configured `alwaysLoad`); never counted against maxDiscoveredTools. */
  alwaysLoad?: Iterable<string>;
  /** Tools held out of the selected view; the returned catalog keeps them for discovery (classification only shapes exposure, never permissions). */
  deferred?: Iterable<string>;
}

export function selectRuntimeTools(schemas: Row[], session: Row, provider: RuntimeProvider, policy: RuntimeToolPolicy = {}): [Row[], Row[]] {
  const options = runtimeOptions(provider);
  const disallowed = new Set(policy.disallow ?? []); const allowed = policy.allowed ? new Set(policy.allowed) : null;
  const denied = new Set(policy.denied ?? []);
  if (session.read_only) for (const name of policy.readonlyDenied ?? []) denied.add(name);
  const catalog = schemas.filter((schema) => {
    const name = runtimeToolName(schema);
    return !disallowed.has(name) && !denied.has(name) && !(disallowed.has("mcp") && name.startsWith("mcp__")) && (!allowed || allowed.has(name));
  });
  const discovered = Array.isArray(session.discovered_tools) ? session.discovered_tools : [];
  // `deferred_tool_call` rides with `tool_search`: no discovery surface, no deferred envelope.
  let base = new Set(session.read_only ? ["read", "list", "glob", "grep", "tool_search", "tool_result_read", "deferred_tool_call"] : ["read", "write", "edit", "exec", "ask_user", "tool_search", "tool_result_read", "deferred_tool_call"]);
  if (session.remote_connection) base.add("remote_exec");
  if (options.initialTools === "minimal" || options.initialTools === "auto" && (provider.contextWindow || 8192) < 4096) {
    base = new Set(session.read_only ? ["read", "list", "glob", "grep", "tool_search", "deferred_tool_call"] : ["read", "exec", "remote_exec", "ask_user", "tool_search", "deferred_tool_call"]);
    if (!session.remote_connection) base.delete("remote_exec");
  }
  const maximum = options.maxDiscoveredTools as number;
  if (!maximum) { base.delete("tool_search"); base.delete("deferred_tool_call"); }
  const requested: string[] = [];
  if (maximum && (provider.contextWindow || 8192) >= 4096) {
    let task = (Array.isArray(session.messages) ? session.messages : []).filter(isDict).findLast((row) => row.role === "user")?.content ?? "";
    if (Array.isArray(task)) task = task.filter(isDict).filter((row) => row.type === "text" && typeof row.text === "string").map((row) => row.text).join("\n");
    if (typeof task === "string") {
      for (const schema of catalog) {
        const name = runtimeToolName(schema);
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!base.has(name) && new RegExp("(?<![A-Za-z0-9_])" + escaped + "(?![A-Za-z0-9_])").test(task)) requested.push(name);
      }
    }
  }
  const optional = [...new Set([...requested, ...[...discovered].reverse().filter((name): name is string => typeof name === "string")])].slice(0, maximum);
  const names = new Set([...base, ...optional]);
  // Exposure classification is deterministic in both profiles: declared or configured
  // alwaysLoad wins over deferred, and neither can resurrect a schema the request
  // catalog no longer carries (a disabled plugin's tool cannot be exposed again).
  const always = new Set(policy.alwaysLoad ?? []);
  for (const schema of catalog) { const name = runtimeToolName(schema); if (always.has(name)) names.add(name); }
  for (const name of policy.deferred ?? []) if (!always.has(name)) names.delete(name);
  if (isDict(session.subagent_coordination) && Object.values(session.subagent_coordination).some((row) => isDict(row) && !row.collected)) names.add("task_collect");
  return [catalog, catalog.filter((schema) => names.has(runtimeToolName(schema))).sort((a, b) => runtimeToolName(a) < runtimeToolName(b) ? -1 : runtimeToolName(a) > runtimeToolName(b) ? 1 : 0)];
}
