/** State-bound production assembly for the shared agent, plugins and web lifecycle. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { isDict, pyJsonDumps, PyValueError } from "@xueness/contracts";
import { AgentRunner, UnsupportedAgentConfiguration, kernelAgentHooks, modelInputOf, promptContextExtension, toolContractExtension, toolMediaExtension, type AgentEvent, type AgentExtension, type AgentProvider, type Row, type RunOptions } from "@xueness/agent";
import { Context, PluginHost } from "@xueness/kernel";
import { createToolEnv, type ToolEnv } from "@xueness/engine-tools";
import { planModePort } from "./plan-mode-port.ts";
import { PermissionSession } from "@xueness/permissions";
import { files, filesReadStateExtension, filesHistoryExtension, workspaceInstructionsExtension } from "@xueness/plugin-files";
import { shell, createShell, shellBackgroundExtension, loadShellConfig, type ShellRuntimeBinding } from "@xueness/plugin-shell";
import { createProviderResultTools, providerToolResultBudgetExtension, providers } from "@xueness/plugin-providers";
import { sessionsTurnRuntimeExtension, sessionsSteeringExtension, sessionsRuntimeEventsExtension, sessionsStableBoundariesExtension, sessionsCompactPersistenceExtension } from "@xueness/plugin-sessions";
import { createPlanning, guardedPermission, planning, type PlanModePort, planningDeliveryExtension, planningGoalExtension } from "@xueness/plugin-planning";
import { createGitCheckpoints } from "@xueness/plugin-git";
import { createMcp, resetElicitationState, mcpRuntimeExtension, type McpRuntimeBinding, type McpRun } from "@xueness/plugin-mcp";
import { BUNDLED_SKILLS_DIR, createSkills, skills, skillsExtension, visualizationDirectory } from "@xueness/plugin-skills";
import { createNativeOps, createNativeOpsBinding, nativeOps, nativeOpsExtension, type NativeOpsBinding } from "@xueness/plugin-native_ops";
import { batchCallsExtension } from "@xueness/plugin-batch_calls";
import { createOffice, deliveryContentText, office } from "@xueness/plugin-office";
import { browser, createBrowser } from "@xueness/plugin-browser";
import { createNetwork, network, networkActivityExtension, type Net } from "@xueness/plugin-network";
import { createHooks, hooksBinding, hooksExtension, type HooksBinding } from "@xueness/plugin-hooks";
import { completionCheck, contextReminder, createSubagents, GUIDANCE, subagents, subagentsBinding, subagentsExtension, TaskCoordinator, type SubagentsBinding, type TaskRegistry } from "@xueness/plugin-subagents";
import { memoryExtension, memoryRootFromEnv } from "@xueness/plugin-memory";
import { createRemote, remote, remoteLocalTools, remoteSessionExtension } from "@xueness/plugin-remote";
import { backgroundChildRunner, childRunner } from "./agent-subagents.ts";
import { automation, createAutomationTools } from "@xueness/plugin-automation";
import { createWorkflows, workflows, WorkflowStore, type WorkerLauncher, type DynamicWorkflowService } from "@xueness/plugin-workflows";
import { answerWorkflowActor } from "./workflow-actors.ts";
import { loadMcpServers, pluginGrants } from "./mcp-servers.ts";
import { handoffModelJson, lightweightRuntimeExtension, loadSettings, ProfileStore, providerActivityExtension, providerModelExecutionExtension, providerRequestShapingExtension, requestConversationTitle, resolveSavedProvider, semanticCompactionExtension, titleProviderSupported, zcodeCompactionExtension } from "@xueness/plugin-providers";
import { bindMediaPrompt, sessions as sessionsPlugin, createAutoTitleWorker, recordApproval, normalizeQuestions, QUESTION_SCHEMA, sessionsCompletionExtension, sessionsToolActivityExtension, switchableProvider, loadProjectPermissionRules, type ApprovalBuckets, type MediaArtifactStore, type RunPolicy, type RuntimeSelection, type SwitchableAgentProvider } from "@xueness/plugin-sessions";
import { foldHostPath, isLink, type Session, type SessionStore } from "@xueness/sessions";
import { ApprovalWaits, ToolBridge, type Approver } from "@xueness/tool-bridge";
import { approvalReplayExtension } from "./agent-approvals.ts";
import { manualModelCompact } from "./agent-compact.ts";
import { loadAgentRuntimeConfig } from "./runtime-configuration.ts";
import type { RuntimeConfigPatch } from "@xueness/plugin-settings";
import { configuredAgentFeatures } from "./agent-features.ts";

import { queueRunExtension } from "../../../plugins/sessions/src/queue-run.ts";
import { pendingDenials } from "../../../plugins/sessions/src/public-session.ts";

export interface AgentServiceOptions {
  store: SessionStore;
  stateDir: string;
  enabled(id: string): boolean;
  approvals?: ApprovalBuckets;
  /** Approvals waiting in process; the sessions HTTP API answers them. */
  liveApprovals?: ApprovalWaits;
  /** Deny an unanswered approval after this many ms; off by default, as in ZCode (permissionTimeoutMs). */
  approvalTimeoutMs?: number;
  mediaStore?: MediaArtifactStore;
  settings?: () => Row;
  /** Host transport port; production defaults to pinned native HTTPS. */
  networkNet?: Net;
  configEnv?: NodeJS.ProcessEnv;
  pluginConfig?: () => Record<string, Record<string, unknown>>;
  resolveProvider?: (selection: RuntimeSelection, sid: string) => AgentProvider;
  /** Shared with session task HTTP so list/cancel see this process's foreground children. */
  taskRegistry?: TaskRegistry;
  extensions?: (session: Session, policy: RunPolicy) => readonly AgentExtension[];
  requiredCapabilities?: (session: Session, request: Row) => readonly string[];
  onEvent?: (sessionId: string, event: AgentEvent) => unknown;
  /** Replaces the in-process approval wait (the CLI answers on the terminal). */
  approver?: (sessionId: string, session: Session, stopped: () => boolean) => Approver;
  appendQueued?: (session: Session, item: Row) => void | Promise<void>;
  preparedRemote?: (prepared: Row) => unknown | Promise<unknown>;
  allowModelRequests?: boolean;
  /** Starts the detached owner of a run the workflow tools launch. */
  workflowLauncher?: WorkerLauncher;
  dynamicWorkflows?: DynamicWorkflowService;
}
interface Environment { kernel: Context; host: PluginHost; env: ToolEnv; artifacts: string; root: string; configs: string; reconcile: Promise<void>; current: { session: Session | null; planMode: PlanModePort | null; mcp: McpRun | null }; hooks: HooksBinding; subagents: SubagentsBinding; shell: ShellRuntimeBinding; shellConfig: string; runtimeConfig: RuntimeConfigPatch; runtimeFingerprint: string; mcpRuntime: McpRuntimeBinding; nativeOps: NativeOpsBinding }

/** Lightweight sessions keep the earlier model handoff; standard sessions use ZCode compaction. */
function lightweightSemanticCompaction(): AgentExtension {
  const semantic = semanticCompactionExtension();
  return { ...semantic, capabilities: [], async beforeModelRequest(context) { if ((context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight") await semantic.beforeModelRequest?.(context); } };
}

export function createAgentService(options: AgentServiceOptions) {
  const environments = new Map<string, Promise<Environment>>();
  const active = new Map<string, AgentRunner>();
  const switchers = new Map<string, SwitchableAgentProvider>();
  const activeRuns = new Set<Promise<Session>>();
  const liveSessions = new Map<string, Session>(), pendingSessions = new Map<string, Promise<Session>>();
  const shutdown = new AbortController();
  const approvals = options.approvals ?? new Map();
  const liveApprovals = options.liveApprovals ?? new ApprovalWaits();
  const settings = options.settings ?? (() => loadSettings(options.stateDir));
  const enabled = (id: string): boolean => { try { return options.enabled(id) === true; } catch { return false; } };
  const titles = createAutoTitleWorker({ store: options.store, enabled, settings, allowModelRequests: options.allowModelRequests === true, acceptProvider: titleProviderSupported, request: requestConversationTitle });
  let closed = false;
  const configurationFor = (root: string) => loadAgentRuntimeConfig({ stateDir: options.stateDir, root, enabled, env: options.configEnv, pluginConfig: options.pluginConfig?.() });
  const reconcile = async (environment: Environment): Promise<void> => {
    environment.reconcile = environment.reconcile.catch(() => {}).then(async () => {
      const runtimeConfig = configurationFor(environment.root).config;
      const configs = runtimeConfig.plugins ?? {};
      const serialized = pyJsonDumps(configs, { sortKeys: true });
      const shellConfig = pyJsonDumps(configs.shell ?? {}, { sortKeys: true });
      const runtimeFingerprint = pyJsonDumps(runtimeConfig, { sortKeys: true });
      if (runtimeFingerprint !== environment.runtimeFingerprint && environment.current.session) active.get(String(environment.current.session.id))?.cancel(String(environment.current.session.id));
      if (environment.current.session?.permission_mode === 'guarded' && !enabled('planning')) active.get(String(environment.current.session.id))?.cancel(String(environment.current.session.id));
      for (const id of ["providers", "files", "shell", "planning", "git", "skills", "hooks", "subagents", "office", "browser", "network", "remote", "native_ops"]) {
        const current = environment.host.status(id);
        if (enabled(id) && !current.enabled) await environment.host.enable(id);
        if (!enabled(id) && current.enabled) await environment.host.disable(id);
        if (serialized !== environment.configs && configs[id]) await environment.host.configure(id, configs[id]!);
      }
      environment.configs = serialized; environment.shellConfig = shellConfig; environment.runtimeConfig = runtimeConfig; environment.runtimeFingerprint = runtimeFingerprint;
    });
    await environment.reconcile;
  };
  const environmentFor = (session: Session): Promise<Environment> => {
    const sid = String(session.id); const existing = environments.get(sid);
    if (existing) return existing;
    const created = (async () => {
      const artifacts = mkdtempSync(join(tmpdir(), "xueness-tools-"));
      const kernel = Context.create({ roots: { workspace: [String(session.root)], state: options.stateDir, temp: artifacts } });
      const runtimeConfig = configurationFor(String(session.root)).config;
      const configs = runtimeConfig.plugins ?? {};
      const nativeOpsBinding = createNativeOpsBinding();
      const current = { session: session as Session | null, planMode: null as PlanModePort | null, mcp: null as McpRun | null };
      const hookBinding = hooksBinding(); const subagentBinding = subagentsBinding(); const shellBinding: ShellRuntimeBinding = {}; const mcpRuntime: McpRuntimeBinding = {};
      const workflowTools = createWorkflows({ stateDir: options.stateDir, enabled, dynamic: options.dynamicWorkflows, session: () => current.session, allowReal: () => options.allowModelRequests === true, allowRealHost: () => options.allowModelRequests === true,
        answerActor: (wid, nodeId, answer) => answerWorkflowActor(new WorkflowStore(options.stateDir), wid, nodeId, answer), ...(options.workflowLauncher ? { launcher: options.workflowLauncher } : {}) });
      const host = new PluginHost(kernel, [files, createShell(shellBinding, { stateDir: options.stateDir }), createProviderResultTools(() => current.session), sessionsPlugin, workflowTools, createAutomationTools({ stateDir: options.stateDir }), createPlanning({ session: () => current.session, planMode: () => current.planMode, questionsSchema: QUESTION_SCHEMA, normalizeQuestions(value) { if (!enabled("sessions")) throw new PyValueError("structured questions require the planning and sessions plugins"); return normalizeQuestions(value); } }), createGitCheckpoints({ store: options.store, stateDir: options.stateDir, enabled, session: () => current.session }), createMcp({ run: () => current.mcp, binding: mcpRuntime }), createSkills({ stateDir: options.stateDir, root: () => current.session ? String(current.session.root) : null, bundled: BUNDLED_SKILLS_DIR }), createHooks(hookBinding), createSubagents(subagentBinding), createNativeOps(nativeOpsBinding), createOffice({ session: () => current.session }), createBrowser({ stateDir: options.stateDir }), createNetwork({ stateDir: options.stateDir, net: options.networkNet }), createRemote({ stateDir: options.stateDir })], { enabled: { providers: enabled("providers"), files: enabled("files"), shell: enabled("shell"), sessions: enabled("sessions"), workflows: enabled("workflows"), automation: enabled("automation"), planning: enabled("planning"), git: enabled("git"), mcp: false, skills: enabled("skills"), hooks: enabled("hooks"), subagents: enabled("subagents"), office: enabled("office"), browser: enabled("browser"), network: enabled("network"), remote: enabled("remote"), native_ops: enabled("native_ops") }, config: configs });
      try {
        await host.start();
        return { kernel, host, env: createToolEnv({ cwd: String(session.root), artifactsDir: artifacts, owner: sid }), artifacts, root: String(session.root), configs: pyJsonDumps(configs, { sortKeys: true }), reconcile: Promise.resolve(), current, hooks: hookBinding, subagents: subagentBinding, shell: shellBinding, shellConfig: pyJsonDumps(configs.shell ?? {}, { sortKeys: true }), runtimeConfig, runtimeFingerprint: pyJsonDumps(runtimeConfig, { sortKeys: true }), mcpRuntime, nativeOps: nativeOpsBinding };
      } catch (error) { await host.dispose(); await kernel.dispose(); rmSync(artifacts, { recursive: true, force: true }); throw error; }
    })();
    environments.set(sid, created);
    created.catch(() => { if (environments.get(sid) === created) environments.delete(sid); });
    return created;
  };
  /** The servers this run connects: the mcp plugin is enabled for the run only, like Python's per-run activation. */
  const mcpRunFor = (session: Session, request: Row, runtimeConfig: RuntimeConfigPatch): McpRun | null => {
    if (!enabled("mcp") || !(request.allow_mcp || request.allowMcp) || session.remote_connection) return null;
    const loaded = loadMcpServers(options.stateDir, pluginGrants(request), runtimeConfig.mcp?.servers ?? {}, String(session.root));
    const audience = { id: session.id, mode: session.mode, permission_mode: session.permission_mode, read_only: session.read_only, parent: session.parent };
    return loaded.native && loaded.servers.length ? { servers: loaded.servers.map((server) => ({ ...server, _state_dir: options.stateDir, _elicitation_session: audience })), cwd: String(session.root) } : null;
  };
  const required = (session: Session, request: Row, provider?: AgentProvider): string[] => configuredAgentFeatures(session, request, { stateDir: options.stateDir, enabled, settings: settings(), provider, extra: options.requiredCapabilities?.(session, request) });
  /** ZCode in-process approval: the call waits; nobody can answer without sessions, so it defers. */
  const liveApprover = (sid: string, session: Session, stopped: () => boolean) => liveApprovals.approver(sid, {
    available: () => !closed && enabled("sessions"), stopped, timeoutMs: options.approvalTimeoutMs,
    onAnswer(approval, answer) {
      if (answer.behavior === "allow") { recordApproval(session, "granted", approval.kind, approval.callId, approval.subject); recordApproval(session, "consumed", approval.kind, approval.callId, approval.subject); }
      else if (answer.behavior === "deny") recordApproval(session, "denied", approval.kind, approval.callId, approval.subject);
    },
  });
  const resolveProvider = options.resolveProvider ?? ((selection: RuntimeSelection) => resolveSavedProvider(new ProfileStore(options.stateDir), selection));
  const service = {
    approvals,
    liveApprovals,
    resolveProvider,
    knownTools(): string[] { return [files, shell, providers, planning, skills, subagents, office, browser, network, remote, workflows, automation, nativeOps].flatMap((entry) => isDict(entry.manifest) && Array.isArray(entry.manifest.tools) ? entry.manifest.tools.filter(isDict).map((tool) => String(tool.name)) : []); },
    async mcpSnapshot(sid: string) { const pending = environments.get(sid); if (!pending) return null; const environment = await pending; return environment.mcpRuntime.current ? { active: true, ...environment.mcpRuntime.current.snapshot() } : null; },
    activeProvider(sid: string): SwitchableAgentProvider | null { return switchers.get(sid) ?? null; },
    /** Read-only routing decision before the lifecycle mutates model selection. */
    supports(session: Session, request: Row): boolean {
      const builtin = new Set(["sessions.completion_policy", "sessions.approvals", "sessions.steering", "sessions.queue", "sessions.live_tool_activity", "providers.lightweight", "providers.semantic_compaction", "providers.activity", "files.workspace_instructions", "planning.delivery", "planning.goal_driver", "remote.execution"]);
      if (options.mediaStore) builtin.add("providers.media");
      for (const feature of ["sessions.turn_runtime", "sessions.history_hydration", "files.read_state_restore", "shell.background_notifications", "providers.tool_result_budget", 'sessions.runtime_events', 'sessions.stable_boundaries', 'sessions.compact_persistence', 'files.rewind_snapshots', 'network.fetch_runtime']) builtin.add(feature);
      for (const feature of ["providers.request_shaping", "providers.model_admission", "providers.model_debug"]) builtin.add(feature);
      if (enabled("mcp")) for (const feature of ["mcp.connections", "mcp.runtime_connections", "mcp.resource_subscriptions"]) builtin.add(feature);
      if (enabled("settings")) builtin.add("settings.runtime_config");
      if (enabled("skills")) builtin.add("skills.context");
      if (enabled("hooks")) for (const feature of ["hooks.commands", "hooks.runtime_admission", "hooks.output_control"]) builtin.add(feature);
      if (enabled("subagents")) builtin.add("subagents.tasks");
      if (enabled("memory")) builtin.add("memory.context");
      if (enabled("office")) builtin.add("office.delivery");
      if (enabled("batch_calls")) for (const feature of ["batch_calls.policy", "batch_calls.compaction"]) builtin.add(feature);
      if (enabled("native_ops")) for (const feature of ["native_ops.files", "native_ops.discovery", "native_ops.documents"]) builtin.add(feature);
      if (enabled("planning")) builtin.add("planning.guarded");
      const policy: RunPolicy = { mode: request.mode === "plan" ? "plan" : "build", permissionMode: "build", disallowed: [], selection: {}, request };
      for (const extension of options.extensions?.(session, policy) ?? []) if (enabled(extension.id)) for (const capability of extension.capabilities ?? []) builtin.add(capability);
      if (!options.mediaStore && (Array.isArray(session.messages) ? session.messages : []).some((row) => isDict(row) && row._media_refs)) return false;
      return required(session, request).every((capability) => builtin.has(capability));
    },
    createRunner(session: Session, provider: AgentProvider, policy: RunPolicy): Pick<AgentRunner, "run" | "cancel"> {
      let pendingCancel = false;
      return {
        cancel(sid: string) { pendingCancel = true; liveApprovals.forgetSession(sid); return active.get(sid)?.cancel(sid) ?? true; },
        async run(value: Session, runOptions: RunOptions = {}) {
          if (closed) throw new Error("agent service is closed");
          const sid = String(value.id); const environment = await environmentFor(value);
          if (environment.root !== value.root) throw new Error("session workspace changed; restart the agent service");
          await reconcile(environment);
          if (active.has(sid)) throw Object.assign(new Error("session is already running"), { name: "BlockingIOError" });
          environment.current.session = value;
          environment.env.currentSession = () => environment.current.session;
          const draftDirectory = join(options.stateDir, "plan-drafts");
          if (isLink(options.stateDir) || isLink(draftDirectory)) throw new Error("plan draft directory must not be a link or reparse point");
          const draft = resolve(draftDirectory, sid + ".md");
          // A session bound to a saved SSH target never runs local tools (`REMOTE_LOCAL_TOOL_NAMES`).
          const remoteBound = !!value.remote_connection;
          // ZCode Gen UI: the session's visualization directory, writable without approval, outside every workspace.
          const visualizations = !remoteBound && enabled("skills") ? visualizationRoot(options.stateDir, sid) : null;
          const appliedShellConfig = JSON.parse(environment.shellConfig) as Record<string, unknown>;
          if (policy.permissionMode === 'guarded' && !enabled('planning')) throw new UnsupportedAgentConfiguration(['planning.guarded']);
          const permissions = new PermissionSession({ mode: policy.mode === "plan" ? "plan" : policy.permissionMode,
            guarded: request => { if (!enabled('planning')) throw new UnsupportedAgentConfiguration(['planning.guarded']); return guardedPermission(request, environment.shell.dialect === 'posix' ? 'posix' : 'powershell'); },
            allow: enabled("sessions") ? loadProjectPermissionRules(options.stateDir, String(value.root)) : [],
            disallow: [...policy.disallowed, ...remoteBound ? remoteLocalTools(environment.kernel.tools.list().map((tool) => tool.name)) : []], readOnlyCommands: environment.shell.dialect === "posix" && !appliedShellConfig.captureInit && !appliedShellConfig.startupScript,
            shell: environment.shell.dialect === "posix" ? "posix" : "powershell", planDraft: policy.permissionMode === "plan" && policy.mode !== "plan" ? {
              path: draft, matches: (subject) => isAbsolute(subject) && foldHostPath(normalize(subject)) === foldHostPath(normalize(draft)),
              denial: (kind) => `${kind} denied：当前是计划模式（Plan mode），只允许读取与搜索；请先写出计划并保存到本会话的计划草稿文件 ${draft}（此模式下唯一可写路径）。需要改动工作区或执行命令时，请让操作员切换到 build/edit/yolo 权限模式。 / Plan mode is read-only: write the plan to this session's draft file ${draft} — the only writable path in this mode — and ask the operator to switch to build, edit or full access before changing workspace files or running commands.`,
            } : null, hostWritable: visualizations ? [visualizations] : [] });
          environment.current.planMode = planModePort(value, permissions, policy.permissionMode);
          const bridge = new ToolBridge({ kernel: environment.kernel, permissions, env: environment.env, approver: (options.approver ?? liveApprover)(sid, value, () => pendingCancel || !!runOptions.shouldStop?.()) });
          const runtimeProvider = switchableProvider(provider, value);
          Object.defineProperty(environment.env, "modelInput", { configurable: true, enumerable: true, get: () => modelInputOf(runtimeProvider) });
          const productExtensions = options.extensions?.(value, policy) ?? [];
          const supportedCapabilities = new Set(["sessions.completion_policy", "sessions.approvals", "sessions.steering", "sessions.queue", "sessions.live_tool_activity", "providers.lightweight", "providers.semantic_compaction", "providers.activity", "files.workspace_instructions", "planning.delivery", "planning.goal_driver", "sessions.prompt_context", "remote.execution", ...productExtensions.flatMap((extension) => enabled(extension.id) ? [...extension.capabilities ?? []] : [])]);
          if (options.mediaStore) supportedCapabilities.add("providers.media");
          for (const feature of ["sessions.turn_runtime", "sessions.history_hydration", "files.read_state_restore", "shell.background_notifications", "providers.tool_result_budget", 'sessions.runtime_events', 'sessions.stable_boundaries', 'sessions.compact_persistence', 'files.rewind_snapshots', 'network.fetch_runtime']) supportedCapabilities.add(feature);
          supportedCapabilities.add("providers.request_shaping");
          supportedCapabilities.add("providers.model_admission");
          supportedCapabilities.add("providers.model_debug");
          if (enabled("mcp")) for (const feature of ["mcp.connections", "mcp.runtime_connections", "mcp.resource_subscriptions"]) supportedCapabilities.add(feature);
          if (enabled("settings")) supportedCapabilities.add("settings.runtime_config");
          if (enabled("skills")) supportedCapabilities.add("skills.context");
          if (enabled("hooks")) for (const feature of ["hooks.commands", "hooks.runtime_admission", "hooks.output_control"]) supportedCapabilities.add(feature);
          if (enabled("subagents")) supportedCapabilities.add("subagents.tasks");
          if (enabled("memory")) supportedCapabilities.add("memory.context");
          if (enabled("office")) supportedCapabilities.add("office.delivery");
          if (enabled("batch_calls")) for (const feature of ["batch_calls.policy", "batch_calls.compaction"]) supportedCapabilities.add(feature);
          if (enabled("native_ops")) for (const feature of ["native_ops.files", "native_ops.discovery", "native_ops.documents"]) supportedCapabilities.add(feature);
          if (enabled("planning")) supportedCapabilities.add("planning.guarded");
          const delegation = enabled("subagents") && !!(policy.request.allow_subagents || policy.request.allowSubagents) && !value.remote_connection;
          // Background delegation: the coordinator owns task ids, the turn records and
          // completion, and only a bound one lets the run advertise `subagents.coordination`.
          // It is created whenever subagents are enabled: a session that already holds
          // uncollected rows must be able to collect them even without a new dispatch.
          const coordinator = enabled("subagents") && !value.remote_connection ? new TaskCoordinator(value as unknown as Row, options.taskRegistry) : null;
          coordinator?.configure({ shouldStop: () => pendingCancel || !!runOptions.shouldStop?.() || closed, enabled: () => enabled("subagents") });
          if (coordinator) supportedCapabilities.add("subagents.coordination");
          const requiredFeatures = (): string[] => required(value, policy.request, runtimeProvider);
          const extensions: AgentExtension[] = [
            sessionsRuntimeEventsExtension(), sessionsTurnRuntimeExtension(), sessionsStableBoundariesExtension(), sessionsCompactPersistenceExtension(), mcpRuntimeExtension(environment.mcpRuntime),
            filesReadStateExtension(environment.env.tracker), filesHistoryExtension(), shellBackgroundExtension(environment.shell), networkActivityExtension(environment.env), sessionsSteeringExtension(),
            sessionsCompletionExtension(),
            remoteSessionExtension(),
            planningDeliveryExtension((context) => ({ enabled: context.enabled, canRead: (path) => permissions.preview({ tool: "read", kind: "read", subject: path, subjectKind: "path" }).behavior === "allow", officeText: deliveryContentText })),
            planningGoalExtension(handoffModelJson),
            { id: 'planning', capabilities: ['planning.guarded'] },
            // The Office plugin's extractor backs Office delivery checks above; declaring it keeps them on TS.
            { id: "office", capabilities: ["office.delivery"] },
            sessionsToolActivityExtension((name) => environment.kernel.tools.ownerOf(name)),
            queueRunExtension({ request: policy.request, stateDir: options.stateDir, pendingApprovals: (s) => pendingDenials(s), appendQueued: options.appendQueued, preparedRemote: options.preparedRemote }),
            workspaceInstructionsExtension((_context, path) => permissions.preview({ tool: "read", kind: "read", subject: path, subjectKind: "path" }).behavior === "allow"),
            // Python's injected order (guidance, memory, skills); both must precede the lightweight view, which consumes `injected`.
            memoryExtension({ memoryRoot: () => memoryRootFromEnv(options.configEnv ?? process.env), allowed: () => { const general = settings().general; return !isDict(general) || general.memoryEnabled !== false; } }),
            skillsExtension({ stateDir: options.stateDir, bundled: BUNDLED_SKILLS_DIR, visualizations: () => visualizations }),
            ...remoteBound ? [] : [hooksExtension({ stateDir: options.stateDir, binding: environment.hooks, legacy: !!(policy.request.allow_hooks || policy.request.allowHooks) })],
            lightweightSemanticCompaction(),
            lightweightRuntimeExtension({ toolPolicy: () => ({ disallow: policy.disallowed, readonlyDenied: environment.kernel.tools.list().filter((tool) => tool.mutating || ["write", "edit", "exec", "mcp"].includes(tool.gate)).map((tool) => tool.name) }) }),
            subagentsExtension({ stateDir: options.stateDir, allowed: delegation, binding: environment.subagents }),
            promptContextExtension(),
            toolContractExtension(),
            nativeOpsExtension(environment.nativeOps), batchCallsExtension,
            zcodeCompactionExtension(),
            providerRequestShapingExtension(),
            providerModelExecutionExtension(),
            providerActivityExtension(),
            { id: "mcp", capabilities: ["mcp.connections"] },
            approvalReplayExtension(bridge, approvals, enabled, (name) => environment.kernel.tools.ownerOf(name)),

            ...productExtensions,
            providerToolResultBudgetExtension(),
            { id: "sessions", async beforeModelRequest() {
              await reconcile(environment);
              if (policy.permissionMode === 'guarded' && !enabled('planning')) throw new UnsupportedAgentConfiguration(['planning.guarded']);
              const missing = requiredFeatures().filter((feature) => !supportedCapabilities.has(feature));
              if (missing.length) throw new UnsupportedAgentConfiguration(missing);
            } },
            toolMediaExtension(),
          ];
          const hooks = kernelAgentHooks(environment.kernel, { enabled, extensions,
            requiredCapabilities: requiredFeatures,
            showReasoning: () => { const general = settings().general; return !isDict(general) || (general.messageStreamShowReasoning ?? true) === true; },
            propagateCancellation: () => { const general = settings().general; return isDict(general) && general.sessionsCancelPropagateEnabled === true; } });
          const runner = new AgentRunner({ root: String(value.root), store: options.store, stateDir: options.stateDir, provider: runtimeProvider, toolBridge: bridge, hooks, hostSignal: shutdown.signal,
            bindPrompt: options.mediaStore ? (context, messages) => bindMediaPrompt(options.mediaStore!, context.session, messages, enabled) : undefined,
            onEvent: (event) => options.onEvent?.(sid, event) });
          active.set(sid, runner);
          liveSessions.set(sid, value);
          const childHost = delegation ? { kernel: environment.kernel, env: environment.env, stateDir: options.stateDir, enabled, parent: value, provider, disallowed: policy.disallowed, executionShell: { shell: environment.shell.dialect === "posix" ? "posix" as const : "powershell" as const, readOnlyCommands: environment.shell.dialect === "posix" && !appliedShellConfig.captureInit && !appliedShellConfig.startupScript },
            resolveProvider, stopped: () => pendingCancel || !!runOptions.shouldStop?.() || closed, hostSignal: shutdown.signal, registry: options.taskRegistry, nativeOps: environment.nativeOps } : null;
          const background = childHost ? backgroundChildRunner(childHost) : null;
          environment.subagents.run = childHost ? childRunner(childHost) : null;
          environment.subagents.background = background;
          environment.subagents.coordinator = coordinator;
          // The coordinator runs the child under its own task id and writes the
          // parent's task_runs row; resume re-enters the same executor.
          coordinator?.bindExecutor(background ? (taskId, stopped, args) => background(taskId, stopped, args ?? {}) : () => ({ ok: false, error: "subagents are unavailable in this run" }), options.stateDir);
          switchers.set(sid, runtimeProvider);
          value.mode = policy.mode;
          const stop = runOptions.shouldStop;
          const beforeSteps = Number(value.steps ?? 0); let completed = false;
          const mcpRun = mcpRunFor(value, policy.request, environment.runtimeConfig);
          if (mcpRun) { environment.current.mcp = mcpRun; await environment.host.enable("mcp").catch(() => {}); }
          const pending = runner.run(value, { ...runOptions, shouldStop: () => pendingCancel || !!stop?.() }); activeRuns.add(pending);
          pendingSessions.set(sid, pending);
          try { const out = await pending; completed = true; return out; }
          finally { activeRuns.delete(pending);
            if (mcpRun) { resetElicitationState(options.stateDir); await environment.host.disable("mcp").catch(() => {}); environment.current.mcp = null; }
            if (active.get(sid) === runner) {
              // Children outlive no turn: the coordinator's stop predicate is
              // already true here, and closing it releases every worker slot.
              if (coordinator) await coordinator.close().catch(() => {});
              active.delete(sid); liveSessions.delete(sid); pendingSessions.delete(sid); switchers.delete(sid); environment.current.session = null; environment.current.planMode = null;
              environment.subagents.run = null; environment.subagents.background = null; environment.subagents.coordinator = null;
              if (completed && Number(value.steps ?? 0) > beforeSteps) titles.schedule(value, runtimeProvider.boundProvider());
            } }
        },
      };
    },
    /** ZCode manual compaction with the session's model; null keeps the deterministic route. */
    async compactSession(session: Session, instructions: string | null, source = "http"): Promise<Row | null> {
      if (closed || active.has(String(session.id))) return null;
      return manualModelCompact({ store: options.store, stateDir: options.stateDir, enabled, resolveProvider, signal: shutdown.signal, onEvent: options.onEvent,
        async kernelFor(value) { const environment = await environmentFor(value); if (environment.root !== value.root) throw new Error("session workspace changed; restart the agent service"); await reconcile(environment); return environment.kernel; } }, session, instructions, source);
    },
    cancel(sid: string): boolean { return active.get(sid)?.cancel(sid) ?? false; },
    /** Apply the feature-owned state transition to the live object before aborting its model/tools. */
    async interruptSession(sid: string, mutate: (session: Session) => void): Promise<boolean> {
      const session = liveSessions.get(sid), runner = active.get(sid), pending = pendingSessions.get(sid);
      if (!session || !runner || !pending) return false;
      mutate(session); runner.cancel(sid); liveApprovals.forgetSession(sid);
      await pending;
      await options.store.save(session);
      return true;
    },
    async refresh(): Promise<void> { for (const environment of environments.values()) await reconcile(await environment); },
    async dispose(): Promise<void> {
      closed = true; clearInterval(watcher);
      // Waiting approvals survive the restart as approval_required, to replay later.
      if (liveApprovals.defer()) await new Promise((resolve) => setImmediate(resolve));
      shutdown.abort(); await titles.close();
      for (const runner of active.values()) for (const sid of environments.keys()) runner.cancel(sid);
      const current = await Promise.all(environments.values());
      await Promise.allSettled(current.map((environment) => environment.host.dispose()));
      await Promise.allSettled([...activeRuns]);
      for (const environment of current) { await environment.kernel.dispose(); rmSync(environment.artifacts, { recursive: true, force: true }); }
      environments.clear();
    },
  };
  // The host owns this observer; unloading a plugin aborts its borrowed tools.
  const watcher = setInterval(() => { if (!closed && !enabled("sessions")) liveApprovals.defer(); if (!closed) service.refresh().catch(() => { for (const [sid, runner] of active) runner.cancel(sid); }); }, 250);
  watcher.unref();
  return service;
}

/** The real path of the session's visualization directory, created on demand; null when it is (under) a link or cannot be made. */
function visualizationRoot(stateDir: string, sid: string): string | null {
  const directory = visualizationDirectory(stateDir, sid);
  try {
    mkdirSync(directory, { recursive: true });
    if (isLink(stateDir) || isLink(join(stateDir, "visualizations")) || isLink(directory)) return null;
    return realpathSync(directory);
  } catch { return null; }
}
