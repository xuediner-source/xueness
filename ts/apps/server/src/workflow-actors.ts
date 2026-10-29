/**
 * The host half of a workflow agent node (Python `workflows._execute`, agent
 * branch) and of `answer_actor`.
 *
 * Each actor runs in its own transcript under `workflows/<wid>-sessions`, rooted
 * at the node's cwd, with Python's Gate ceiling: a read-only node runs in plan
 * mode, an approved writable node may change files (`allow_write`/`allow_edit`)
 * but anything that still asks (a command) has no approver here, so the run
 * pauses, exactly as an unattended Python actor does. The dependency results
 * reach the model as Python's untrusted `memory` block, only while the memory
 * plugin is enabled.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, answerSession, kernelAgentHooks, modelInputOf, toolContractExtension, toolMediaExtension, type AgentExtension, type AgentProvider, type ModelRequest, type Row } from "@xueness/agent";
import { createToolEnv, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession } from "@xueness/permissions";
import { files, filesReadStateExtension, filesHistoryExtension } from "@xueness/plugin-files";
import { UNTRUSTED_PREAMBLE } from "@xueness/plugin-memory";
import { createNetwork, networkActivityExtension } from "@xueness/plugin-network";
import { createOffice } from "@xueness/plugin-office";
import { createPlanning } from "@xueness/plugin-planning";
import { ProfileStore, providerModelExecutionExtension, providerRequestShapingExtension, resolveSavedProvider } from "@xueness/plugin-providers";
import { createShell, shellBackgroundExtension, loadShellConfig, type ShellRuntimeBinding } from "@xueness/plugin-shell";
import { createSessionsStore, sessionsTurnRuntimeExtension, sessionsRuntimeEventsExtension, sessionsStableBoundariesExtension, sessionsCompactPersistenceExtension } from "@xueness/plugin-sessions";
import { createProviderResultTools, providerToolResultBudgetExtension } from "@xueness/plugin-providers";
import type { AgentNodeHost, WorkflowStore } from "@xueness/plugin-workflows";
import { SessionStore, type Session } from "@xueness/sessions";
import { loadAgentRuntimeConfig } from "./runtime-configuration.ts";
import { ToolBridge } from "@xueness/tool-bridge";

/** `run(..., max_steps=20, ...)`. */
const ACTOR_MAX_STEPS = 20;

export interface ActorHostOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** `provider_config.resolve(state, provider_id, model)`; the saved profiles by default. */
  resolveProvider?(providerId: string | null, model: string | null): AgentProvider;
  hostSignal?: AbortSignal;
}

/** `memory=context`: Python injects `UNTRUSTED_PREAMBLE + "\n\n" + memory` into the prompt view. */
function dependencyMemory(memory: string | null, enabled: (id: string) => boolean): AgentExtension {
  return {
    id: "workflows",
    prepareRequest(_context, request): ModelRequest {
      if (!memory || !enabled("memory")) return request;
      const block = { role: "user", content: UNTRUSTED_PREAMBLE + "\n\n" + memory };
      if (request.messages[0]?.role !== "system") return { ...request, messages: [block, ...request.messages] };
      return { ...request, messages: [request.messages[0], block, ...request.messages.slice(1)] };
    },
  };
}

export function createActorHost(options: ActorHostOptions): AgentNodeHost {
  const resolve = options.resolveProvider ?? ((providerId: string | null, model: string | null): AgentProvider =>
    resolveSavedProvider(new ProfileStore(options.stateDir), { providerId, model }) as unknown as AgentProvider);
  return {
    enabled: options.enabled,
    bucket(providerId, model) {
      const provider = resolve(providerId, model) as AgentProvider & { model?: unknown };
      const name = providerId || provider.constructor.name.toLowerCase();
      return name + ":" + String(model || (provider.model ?? "default"));
    },
    async ensureSession(prompt, cwd, existingId, sessions) {
      const store = createSessionsStore(sessions, { enabled: options.enabled });
      return String(existingId ? (await store.load(existingId)).id : (await store.new(prompt, cwd)).id);
    },
    async run(request) {
      const store = createSessionsStore(request.sessions, { enabled: options.enabled });
      const session = await store.load(String(request.sessionId));
      const provider = resolve(request.providerId, request.model);
      const root = String(session.root);
      const artifacts = mkdtempSync(join(tmpdir(), "xueness-actor-"));
      const kernel = Context.create({ roots: { workspace: [root], state: options.stateDir, temp: artifacts } });
      const current = { session: session as Session | null };
      const shellBinding: ShellRuntimeBinding = {};
      const runtimeConfig = loadAgentRuntimeConfig({ stateDir: options.stateDir, root, enabled: options.enabled }).config;
      const shellConfig = runtimeConfig.plugins?.shell as unknown as ReturnType<typeof loadShellConfig>;
      // `ask_user` (planning) is how an actor waits for `answer_actor`.
      const host = new PluginHost(kernel, [files, createShell(shellBinding, { stateDir: options.stateDir }), createProviderResultTools(() => current.session, {
        // F02.02: identity/exposure projection of the live kernel catalog; the
        // actor's resolved provider resolves the local/native ToolSearch mode.
        catalog: () => kernel.tools.list<ToolDefinition>().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
        provider: () => provider,
      }), createPlanning({ session: () => current.session, enabled: options.enabled }), createOffice({ session: () => current.session }), createNetwork({ stateDir: options.stateDir })],
        { enabled: { providers: options.enabled("providers"), files: options.enabled("files"), shell: options.enabled("shell"), planning: options.enabled("planning"), office: options.enabled("office"), network: options.enabled("network") }, config: runtimeConfig.plugins });
      try {
        await host.start();
        // `Gate(cwd, allow_write=writable, allow_edit=writable, mode='build' if writable else 'plan')`.
        const permissions = new PermissionSession({ mode: request.writable ? "edit" : "plan", disallow: [], readOnlyCommands: shellBinding.dialect === "posix" && !shellConfig.captureInit && !shellConfig.startupScript, shell: shellBinding.dialect === "posix" ? "posix" : "powershell" });
        const env = createToolEnv({ cwd: root, artifactsDir: artifacts, owner: String(session.id) });
        env.modelInput = modelInputOf(provider);
        env.currentSession = () => session;
        const bridge = new ToolBridge({ kernel, permissions, env });
        // Workflow actors are governed traffic: they queue per workflow run id
        // and rotate fairly against other runs and models under the shared cap.
        const hooks = kernelAgentHooks(kernel, { enabled: options.enabled, extensions: [sessionsRuntimeEventsExtension(), sessionsTurnRuntimeExtension(), sessionsStableBoundariesExtension(), sessionsCompactPersistenceExtension(), filesReadStateExtension(env.tracker), filesHistoryExtension(), shellBackgroundExtension(shellBinding), networkActivityExtension(env), toolContractExtension(), dependencyMemory(request.context, options.enabled), toolMediaExtension(), providerRequestShapingExtension(), providerModelExecutionExtension({ admissionScope: { run: request.runId ?? "workflow-actor" } }), providerToolResultBudgetExtension()] });
        const hostSignal = request.signal ? AbortSignal.any([request.signal, ...options.hostSignal ? [options.hostSignal] : []]) : options.hostSignal;
        const runner = new AgentRunner({ root, store, stateDir: options.stateDir, provider, toolBridge: bridge, hooks, hostSignal });
        return await runner.run(session, { maxSteps: ACTOR_MAX_STEPS, maxWallSeconds: request.timeoutSeconds, shouldStop: request.shouldStop, ...request.signal ? { signal: request.signal } : {} }) as Row;
      } finally {
        await host.dispose(); await kernel.dispose();
        rmSync(artifacts, { recursive: true, force: true });
      }
    },
  };
}

/**
 * `WorkflowStore.answer_actor`: the store refuses a bad answer or a node that is
 * not waiting, the answer is appended to the actor transcript, then the node is
 * re-queued and the run paused for the operator to resume.
 */
export async function answerWorkflowActor(store: WorkflowStore, wid: string, nodeId: string, answer: string): Promise<Row> {
  const { sessionId } = store.actorAwaiting(wid, nodeId, answer);
  const sessions = createSessionsStore(join(store.directory, wid + "-sessions"));
  await answerSession(await sessions.load(sessionId), sessions, answer);
  return store.actorAnswered(wid, nodeId, answer);
}
