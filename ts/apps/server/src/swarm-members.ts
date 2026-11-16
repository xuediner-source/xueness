/**
 * The host half of a swarm member's turn (the `MemberRunner` the swarm
 * service calls), built like a workflow actor (`workflow-actors.ts`).
 *
 * Each member has its own durable session under `swarms/<id>/sessions`, its
 * own kernel with the file, shell and provider result tools plus the member
 * side of the swarm plugin, and a permission session in build mode whose only
 * allow rules are the member's brief (owned paths, listed commands). The
 * approver always says no, so anything outside the brief is refused rather
 * than asked — also when the user works in full access, because ownership is
 * a contract between members (owner decision, 2026-11-14). Model calls queue
 * under the swarm's run scope; the swarm's judge choice applies.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, appendUserTurn, kernelAgentHooks, modelInputOf, toolContractExtension, toolMediaExtension, type AgentProvider, type Row } from "@xueness/agent";
import { createToolEnv, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession, permissionSettingsIssues } from "@xueness/permissions";
import { files, filesReadStateExtension, filesHistoryExtension } from "@xueness/plugin-files";
import { createProviderResultTools, lightweightRuntimeExtension, providerModelExecutionExtension, providerRequestShapingExtension, providerToolResultBudgetExtension } from "@xueness/plugin-providers";
import { createShell, shellBackgroundExtension, loadShellConfig, type ShellRuntimeBinding } from "@xueness/plugin-shell";
import { createSessionsStore, sessions as sessionsPlugin, sessionsTurnRuntimeExtension, sessionsRuntimeEventsExtension, sessionsStableBoundariesExtension, sessionsCompactPersistenceExtension } from "@xueness/plugin-sessions";
import { createSwarm, memberRules, SWARM_MEMBER_SYSTEM, type MemberRunner, type ModelChoice, type SwarmService } from "@xueness/plugin-swarm";
import type { Session } from "@xueness/sessions";
import { ToolBridge } from "@xueness/tool-bridge";
import { loadAgentRuntimeConfig } from "./runtime-configuration.ts";
import { toolJudgeFor } from "./tool-judge-host.ts";

/** One member turn may take this long before it is stopped. */
const MEMBER_TURN_SECONDS = 900;
/** Tools a member never gets, whatever the kernel holds. */
const MEMBER_DISALLOWED = ["ask_user", "task", "task_resume", "task_send_message", "task_cancel", "swarm_start", "swarm_post", "swarm_stop", "web_fetch", "web_search", "mcp"];

export interface SwarmMemberHostOptions {
  stateDir: string;
  enabled(id: string): boolean;
  service(): SwarmService | null;
  /** The member's model, or the user's conversation's model when the plan names none. */
  resolveProvider(choice: ModelChoice | null, parentSessionId: string): Promise<AgentProvider>;
  hostSignal?: AbortSignal;
}

/** Exact allow-rule syntax check, shared with plan validation. */
export function commandRuleIssue(rule: string): string | null {
  return permissionSettingsIssues({ allow: [rule] })[0] ?? null;
}

function finalText(session: Row): string | null {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const last = [...messages].reverse().find((row) => row && typeof row === "object" && (row as Row).role === "assistant") as Row | undefined;
  if (!last || (Array.isArray(last.tool_calls) && last.tool_calls.length)) return null;
  return typeof last.content === "string" && last.content.trim() ? last.content.trim() : null;
}

async function forkContextDigest(store: ReturnType<typeof createSessionsStore>, sessionId: string | null | undefined): Promise<string> {
  if (!sessionId) return "";
  try {
    const prior = await store.load(sessionId);
    const rows = Array.isArray(prior.messages) ? (prior.messages as Row[]) : [];
    const lines = rows
      .filter((row) => row && (row.role === "assistant" || row.role === "user"))
      .slice(-8)
      .map((row) => {
        const text = typeof row.content === "string" ? row.content.trim().slice(0, 260) : "";
        const tools = Array.isArray(row.tool_calls) ? row.tool_calls.map((c) => String((c as { function?: { name?: unknown } }).function?.name ?? "")).filter(Boolean).join(", ") : "";
        return `${String(row.role)}:${tools ? ` [tools: ${tools}]` : ""} ${text}`.trim();
      })
      .filter(Boolean);
    return lines.join("\n").slice(0, 2000);
  } catch { return ""; }
}

export function createSwarmMemberRunner(options: SwarmMemberHostOptions): MemberRunner {
  return {
    async run(request) {
      const { swarm, member } = request;
      const store = createSessionsStore(request.sessionsDir, { enabled: options.enabled });
      let session: Session;
      if (member.sessionId) {
        session = await store.load(member.sessionId);
        await appendUserTurn(session, store, Array.from(request.input).slice(0, 5000).join(""));
      } else {
        const forkDigest = await forkContextDigest(store, member.forkFromSessionId);
        const intro = forkDigest ? `${request.input}\n\n[Warm handoff from prior session ${member.forkFromSessionId}:]\n${forkDigest}` : request.input;
        session = await store.new(Array.from(intro).slice(0, 8000).join(""), swarm.root);
        const system = (session.messages as Row[])[0]!;
        system.content = `${String(system.content)}\n\n${SWARM_MEMBER_SYSTEM}`;
        session.swarm_member = { swarmId: swarm.id, name: member.name, role: member.role };
        await store.save(session);
      }
      const before = Number(session.steps ?? 0);
      const provider = await options.resolveProvider(member.model, swarm.parentSessionId);
      const root = swarm.root;
      const artifacts = mkdtempSync(join(tmpdir(), "xueness-swarm-"));
      const kernel = Context.create({ roots: { workspace: [root], state: options.stateDir, temp: artifacts } });
      const current = { session: session as Session | null };
      const shellBinding: ShellRuntimeBinding = {};
      const runtimeConfig = loadAgentRuntimeConfig({ stateDir: options.stateDir, root, enabled: options.enabled }).config;
      const shellConfig = runtimeConfig.plugins?.shell as unknown as ReturnType<typeof loadShellConfig>;
      const memberPlugin = createSwarm({ service: options.service, commandIssue: commandRuleIssue, foldCase: process.platform === "win32", member: { swarmId: swarm.id, name: member.name } });
      const host = new PluginHost(kernel, [files, sessionsPlugin, createShell(shellBinding, { stateDir: options.stateDir }), createProviderResultTools(() => current.session, {
        catalog: () => kernel.tools.list<ToolDefinition>().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
        provider: () => provider,
      }), memberPlugin], { enabled: { files: options.enabled("files"), sessions: options.enabled("sessions"), shell: options.enabled("shell"), providers: options.enabled("providers"), swarm: options.enabled("swarm") }, config: runtimeConfig.plugins });
      try {
        await host.start();
        const posix = shellBinding.dialect === "posix";
        const permissions = new PermissionSession({ mode: "build", allow: memberRules(member), disallow: MEMBER_DISALLOWED,
          readOnlyCommands: posix && !shellConfig?.captureInit && !shellConfig?.startupScript, shell: posix ? "posix" : "powershell" });
        const env = createToolEnv({ cwd: root, artifactsDir: artifacts, owner: String(session.id) });
        env.modelInput = modelInputOf(provider);
        env.currentSession = () => session;
        const bridge = new ToolBridge({ kernel, permissions, env, approver: () => ({ behavior: "deny", reason: "swarm_member_scope",
          message: "Outside your brief: you may change only the paths you own and run only your listed commands, exactly as written. Ask @coordinator on the board instead." }) });
        const tools = (): Row[] => kernel.tools.list().map((tool) => tool as unknown as Row);
        const hooks = kernelAgentHooks(kernel, { enabled: options.enabled, extensions: [sessionsRuntimeEventsExtension(), sessionsTurnRuntimeExtension(), sessionsStableBoundariesExtension(), sessionsCompactPersistenceExtension(),
          filesReadStateExtension(env.tracker), filesHistoryExtension(), shellBackgroundExtension(shellBinding), toolContractExtension(),
          lightweightRuntimeExtension({ discoveredCatalog: () => kernel.tools.list().map((tool) => tool.name), toolPolicy: () => ({ disallow: MEMBER_DISALLOWED,
            alwaysLoad: tools().filter((tool) => tool.alwaysLoad === true).map((tool) => String(tool.name)), deferred: tools().filter((tool) => tool.shouldDefer === true).map((tool) => String(tool.name)) }) }),
          toolMediaExtension(), providerRequestShapingExtension(), providerModelExecutionExtension({ admissionScope: { run: swarm.id } }),
          toolJudgeFor({ stateDir: options.stateDir, gateOf: (name) => kernel.tools.get(name)?.gate ?? null, scope: { run: swarm.id }, override: swarm.judge, shell: posix ? "posix" : "powershell" }),
          providerToolResultBudgetExtension()] });
        const signal = options.hostSignal ? AbortSignal.any([request.signal, options.hostSignal]) : request.signal;
        const runner = new AgentRunner({ root, store, stateDir: options.stateDir, provider, toolBridge: bridge, hooks, hostSignal: signal });
        const result = await runner.run(session, { maxSteps: swarm.limits.memberMaxSteps, maxWallSeconds: MEMBER_TURN_SECONDS, shouldStop: request.shouldStop, signal }) as Row;
        const finished = (result && typeof result === "object" ? result : session) as Row;
        return { sessionId: String(session.id), steps: Math.max(0, Number(finished.steps ?? 0) - before), final: finalText(finished), error: null };
      } finally {
        await host.dispose(); await kernel.dispose();
        rmSync(artifacts, { recursive: true, force: true });
      }
    },
  };
}
