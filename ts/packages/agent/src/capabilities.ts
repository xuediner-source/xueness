import { isDict } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
import type { AgentRunnerOptions } from "./types.ts";

export class UnsupportedAgentConfiguration extends Error {
  override name = "UnsupportedAgentConfiguration";
  readonly code = "agent_backend_required";
  readonly capabilities: readonly string[];
  constructor(capabilities: readonly string[]) { super("configured features require the existing backend: " + capabilities.join(", ")); this.capabilities = capabilities; }
}
/** Explicit routing seam: configured product features cannot silently disappear. */
export function agentSupport(session: Session, options: AgentRunnerOptions): { supported: boolean; missingCapabilities: string[] } {
  const supported = new Set(["agent.standard", "sessions.compaction", "sessions.completion", "sessions.streaming"]);
  if (options.bindPrompt) supported.add("providers.media");
  for (const extension of options.hooks.extensions ?? []) {
    let enabled = false; try { enabled = options.hooks.enabled(extension.id) === true; } catch { /* fail closed */ }
    if (enabled) for (const capability of extension.capabilities ?? []) supported.add(capability);
  }
  const required = new Set(options.hooks.requiredCapabilities?.(session) ?? []);
  if ((session.runtime_profile ?? options.provider.runtimeProfile) === "lightweight") required.add("providers.lightweight");
  if ((session.tool_calling ?? options.provider.toolCalling) === "json") required.add("providers.lightweight");
  if (session.remote_connection) required.add("remote.execution");
  if (isDict(session.subagent_coordination) && Object.values(session.subagent_coordination).some((row) => isDict(row) && !row.collected)) required.add("subagents.coordination");
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (messages.some((row) => isDict(row) && row._media_refs)) required.add("providers.media");
  const missingCapabilities = [...required].filter((capability) => !supported.has(capability));
  return { supported: !missingCapabilities.length, missingCapabilities };
}
