/**
 * Binds the tool_judge plugin's ports to the host: saved provider profiles,
 * the bounded JSON handoff under the model admission governor, the kernel's
 * gate kinds and the providers plugin's tool-outcome classification.
 *
 * The user's own runs judge under the foreground scope (never queued behind
 * workflow traffic); swarm members judge under their swarm's run scope, so a
 * local server's slots are shared fairly.
 */
import { platform } from "node:os";
import type { AgentExtension, AgentProvider } from "@xueness/agent";
import { admissionWithScope, AVOIDABLE_GROUPS, handoffModelJson, outcomeCode, outcomeGroup, ProfileStore, providerAdmissionForState, resolveSavedProvider } from "@xueness/plugin-providers";
import { readJudgeSettings, toolJudgeExtension, type JudgeSelection } from "@xueness/plugin-tool_judge";

export interface ToolJudgeHostOptions {
  stateDir: string;
  /** A registered tool's gate kind, by internal name. */
  gateOf(name: string): string | null;
  scope: { foreground: true } | { run: string };
  /** A swarm's own choice; absent or "inherit" follows the settings. */
  override?: "inherit" | "off" | JudgeSelection;
  resolveProvider?(selection: JudgeSelection): AgentProvider;
  shell?: "posix" | "powershell";
}

export function toolJudgeFor(options: ToolJudgeHostOptions): AgentExtension {
  const shared = providerAdmissionForState(options.stateDir);
  const admission = shared ? admissionWithScope(shared, options.scope) : undefined;
  const shell = options.shell ?? (platform() === "win32" ? "powershell" : "posix");
  return toolJudgeExtension({
    settings: () => readJudgeSettings(options.stateDir),
    selection: (settings) => options.override === "off" ? null : options.override && options.override !== "inherit" ? options.override : settings.profile,
    provider: (selection) => options.resolveProvider?.(selection) ?? resolveSavedProvider(new ProfileStore(options.stateDir), { providerId: selection.providerId, model: selection.model }) as unknown as AgentProvider,
    ask: (provider, messages, config) => handoffModelJson(provider, messages, { ...config, ...admission ? { admission } : {} }),
    gateOf: options.gateOf,
    classify: (name, result) => {
      const code = outcomeCode(result);
      if (code === null) return { failed: false, avoidable: false };
      return { failed: true, avoidable: AVOIDABLE_GROUPS.has(outcomeGroup(name, code, result)) };
    },
    platform: () => `${platform()} (${shell === "powershell" ? "PowerShell 5.1: no && or ||; Unix flags like ls -la do not work" : "POSIX shell"})`,
  });
}
