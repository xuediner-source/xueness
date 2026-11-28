/** Assemble feature-owned APIs; the front door owns all transport guards. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSettingsApi, createRuntimeConfigApi, declaredWorkspaceRoots, loadSettings as loadUserSettings, nativePickerCapability, PickerFailed } from "@xueness/plugin-settings";
import { configurationError, createProvidersApi, declaredReasoningLevels, loadSettings } from "@xueness/plugin-providers";
import { appendAcceptedQueuedTurn, createAttachmentsApi, createSessionRuntimeApi, createSessionsApi, createSessionsStore, createSessionRuntimeEventLog, createSessionStorageApi, validateSessionWorkspace, messageRevision, MediaArtifactStore, type ApprovalBuckets, type LifecycleOptions } from "@xueness/plugin-sessions";
import { createFilesHttp, createFileRewindApi, createFileBytesApi, listLevel, statWorkspaceReference } from "@xueness/plugin-files";
import { previewBytes } from "@xueness/plugin-office";
import { createMemoryHttp, createMemoryDreamApi, createOceanDreamApi, type MemoryDreamService } from "@xueness/plugin-memory";
import { createMemoryDreamDriver, createOceanDreamDriver } from './memory-dream-driver.ts';
import { isLink, isPyOSError, isPyValueError, NativeFileLocks, SessionStore, type Session } from "@xueness/sessions";
import type { ApiDispatcher } from "./api-body.ts";
import { effectivePlugins } from "./plugin-state.ts";
import { createContextLensHttp, ownersFromManifests } from "@xueness/plugin-context_lens";
import { BUNDLED_TS_PLUGINS } from "./bundled-plugins.ts";
import { createAgentService, type AgentServiceOptions } from "./agent-service.ts";
import { createPlanningApi, publicGoal, stageGoal } from "@xueness/plugin-planning";
import { createGitApi } from "@xueness/plugin-git";
import { createHooksHttp } from "@xueness/plugin-hooks";
import { createSkillsHttp, skillPackageImporter } from "@xueness/plugin-skills";
import { rulePackImporter } from "@xueness/plugin-commands";
import { createAppsHttp, createElicitationHttp, createMcpOpsHttp, createMcpResourcesHttp, mcpPackageImporter } from "@xueness/plugin-mcp";
import { createSubagentTasksHttp, createSubagentsResourcesHttp, TaskRegistry } from "@xueness/plugin-subagents";
import { createShellSettingsApi } from "@xueness/plugin-shell";
import { createMcpRuntimeApi } from "@xueness/plugin-mcp";
import { legacyRuntimeConfig, validateAgentRuntimeConfig } from "./runtime-configuration.ts";
import { createNetworkHttp, fetchPage, nodeNet } from "@xueness/plugin-network";
import { createToolJudgeHttp } from "@xueness/plugin-tool_judge";
import { createSwarmSessionApi, createSwarmSettingsHttp, memberSessionsDirectory, readSwarmSettings, SwarmService } from "@xueness/plugin-swarm";
import { commandRuleIssue, createSwarmMemberRunner } from "./swarm-members.ts";
import { createExtensionsHttp, textPackageStore } from "@xueness/plugin-extensions";
import { harnessImporter } from "@xueness/plugin-deepseek_harness";
import { createBrowserHandoff } from "./browser-handoff.ts";
import { currentWorker, shutdownBrowser } from "@xueness/plugin-browser";
import { createComposerFeatures } from "./composer-features.ts";
import { isLoopbackAddress } from "./loopback-url.ts";
import { createHostServices } from "./host-services-http.ts";
import { createIntegrations } from "./integrations-http.ts";
import { createOptionalTavernRoleplay, observeOptionalProvider } from "./optional-integrations.ts";
import { createWorkflowsAutomation } from "./workflows-http.ts";
import { createPluginManager } from "./plugin-manager-http.ts";
import { DynamicServiceError, DynamicWorkflowService, createDynamicWorkflowApi } from '@xueness/plugin-workflows';
import { createDynamicWorkflowDriver } from './dynamic-workflow-driver.ts';

export interface ApplicationApiOptions {
  projectRoot: string;
  projectDir?: string;
  stateDir: string;
  webRuns: string;
  workspaceRoots?: readonly string[];
  desktopToken?: string;
  /** Desktop host: Electron answers updates, the permission guide and the folder dialog over stdio. */
  desktopBridge?: DesktopBridgeLike;
  webappDir?: string;
  allowReal?: boolean;
  /** The Python backend's environment and working directory: declared roots resolve as it resolves them. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** False when another process owns the cron and off-peak scheduler (the CLI). */
  scheduler?: boolean;
  /** Agent-service hooks for a terminal host: live events and its own approver. */
  agent?: Pick<AgentServiceOptions, "onEvent" | "approver" | "networkNet">;
}
export interface DesktopBridgeLike {
  request(message: Record<string, unknown>, timeoutSeconds: number): Promise<Record<string, unknown>>;
  chooseDirectory(initialRoot: string | null): Promise<string | null>;
}
export type AgentService = ReturnType<typeof createAgentService>;
export type ApplicationApi = ApiDispatcher & { close(): Promise<void>; agent: AgentService; store: SessionStore; enabled(id: string): boolean; dynamicWorkflows: DynamicWorkflowService; memoryDreams: MemoryDreamService; swarms: SwarmService };
/** web.py desktop mode: the picker is offered while the desktop plugin is on, and opens Electron's dialog. */
function desktopPicker(bridge: DesktopBridgeLike, enabled: (id: string) => boolean): { chooser(initialRoot: string | null): Promise<string | null>; capability(): { available: boolean; platform: string } } {
  return {
    capability: () => ({ available: enabled("desktop"), platform: nativePickerCapability().platform }),
    async chooser(initialRoot) {
      try { return await bridge.chooseDirectory(initialRoot); } catch { throw new PickerFailed("native directory picker failed"); }
    },
  };
}

export async function createApplicationApi(options: ApplicationApiOptions): Promise<ApplicationApi> {
  // web.py `build_context`: one CSRF token per server process.
  const bridge = { csrfToken: randomBytes(32).toString("hex") };
  mkdirSync(options.stateDir, { recursive: true }); mkdirSync(options.webRuns, { recursive: true });
  const enabled = effectivePlugins(options.projectRoot, options.stateDir);
  const env = options.env ?? process.env;
  const settingsApi = createSettingsApi({ stateDir: options.stateDir, projectDir: options.projectDir ?? options.projectRoot, webRuns: options.webRuns, enabled, listLevel,
    declaredRoots: declaredWorkspaceRoots(options.workspaceRoots ?? [], env.XUENESS_WORKSPACE_ROOTS ?? "", options.cwd ?? process.cwd()),
    maxEntries: Number.parseInt(env.XUENESS_BROWSE_MAX_ENTRIES ?? "", 10) || 1000, desktop: !!options.desktopToken,
    ...(options.desktopBridge ? desktopPicker(options.desktopBridge, enabled) : {}) });
  // `workspaces_api.allowed_roots`/`get_default_root`; a corrupt settings file still leaves the configured roots.
  const workspaces = settingsApi.workspaces;
  const allowedRoots = (): string[] => { try { return workspaces.allowedRoots(); } catch { return workspaces.allowedRoots(false); } };
  const locks = new NativeFileLocks();
  const store = createSessionsStore(options.stateDir, { locks, enabled, env });
  const providers = createProvidersApi({ stateDir: options.stateDir, enabled, allowReal: options.allowReal });
  const approvals: ApprovalBuckets = new Map();
  const running = new Set<string>(), activeContext = new Map<string, Record<string, unknown>>();
  const projectDir = options.projectDir ?? options.projectRoot, defaultRoot = (): string => workspaces.defaultRoot(allowedRoots());
  const browseRoots = [...workspaces.options.declaredRoots, projectDir, options.webRuns];
  const integrations = createIntegrations({ stateDir: options.stateDir, projectDir, enabled, store, locks, providers: providers.store, createRoots: () => browseRoots, env });
  const { commands, composer } = createComposerFeatures({ projectRoot: options.projectRoot, projectDir, stateDir: options.stateDir, webRuns: options.webRuns, store, providers: providers.store,
    running, enabled, allowedRoots, defaultRoot, allowReal: options.allowReal === true, env, remote: integrations.composerRemote });
  const consumePrepared = (token: string, root: string): Promise<Record<string, unknown>> => composer.consumePrepared(token, root);
  const expandCommands = composer.expandCommands;
  const media = new MediaArtifactStore(options.stateDir, locks);
  const applyGoal = (session: Session, text: string): void => { stageGoal(session, text, { enabled, replace: true, source: "composer" }); };
  const taskRegistry = new TaskRegistry();
  const dynamicDriver = createDynamicWorkflowDriver({
    stateDir: options.stateDir, store, enabled,
    resolveProvider: (providerId, model) => providers.resolve({ providerId, model, reasoningEffort: null }),
  });
  const dynamicWorkflows = new DynamicWorkflowService({ stateDir: options.stateDir, enabled, driver: dynamicDriver, allowRealHost: () => options.allowReal === true,
    owner: async sid => {
      const session = await store.load(sid);
      try { await validateSessionWorkspace({ store, stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled, allowedRoots }, session); }
      catch { throw new DynamicServiceError(403, 'workspace is not authorized'); }
      return session;
    }, answerActor: dynamicDriver.answer });
  const dynamicWorkflowApi = createDynamicWorkflowApi(dynamicWorkflows);
  const swarmActivityCache = new Map<string, { stamp: string; at: number; activity: string }>();
  const listSwarmModels = () => providers.store.list().flatMap((p) => {
    const pid = String(p.id);
    const labelBase = typeof p.name === "string" && p.name ? p.name : pid;
    const source = typeof p.provider === "string" ? p.provider : "saved";
    const models = Array.isArray((p as Record<string, unknown>).models)
      ? ((p as Record<string, unknown>).models as unknown[]).filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : [];
    if (models.length > 0) {
      return models.map((m) => ({ providerId: pid, model: m, name: `${labelBase} · ${m}`, source }));
    }
    const single = typeof p.model === "string" && p.model ? p.model : null;
    return [{ providerId: pid, model: single, name: single ? `${labelBase} · ${single}` : labelBase, source }];
  });
  // Swarm members run only where real model calls are allowed; a member without its own model uses its conversation's.
  const swarms: SwarmService = new SwarmService({ stateDir: options.stateDir, enabled, settings: () => readSwarmSettings(options.stateDir),
    foldCase: process.platform === "win32", commandIssue: commandRuleIssue,
    runner: options.allowReal === true ? createSwarmMemberRunner({ stateDir: options.stateDir, enabled, service: () => swarms, listModels: listSwarmModels, resolveProvider: async (choice, parentId) => {
      const saved = ((await store.load(parentId)).model_selection ?? {}) as Record<string, unknown>;
      const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
      return agent.resolveProvider(choice ? { providerId: choice.providerId, model: choice.model, reasoningEffort: null } : { providerId: text(saved.provider_id), model: text(saved.model), reasoningEffort: text(saved.reasoning_effort) }, parentId) as never;
    } }) : null });
  swarms.recoverInterrupted();
  const workflowsAutomation = createWorkflowsAutomation({ projectRoot: options.projectRoot, projectDir, stateDir: options.stateDir, webRuns: options.webRuns, enabled, store, allowedRoots, allowReal: options.allowReal === true, env, ...(options.scheduler === false ? { scheduler: false } : {}) });
  const tavernRoleplay = createOptionalTavernRoleplay({ stateDir: options.stateDir, enabled, env: process.env });
  const agent = createAgentService({ ...options.agent, extensions: () => [tavernRoleplay.afterViews], viewExtensions: () => [tavernRoleplay.beforeViews], store, stateDir: options.stateDir, configEnv: env, enabled, approvals, mediaStore: media, desktopComputerUse: !!options.desktopToken && !!options.desktopBridge, allowModelRequests: options.allowReal, taskRegistry, workflowLauncher: workflowsAutomation.launcher, dynamicWorkflows, swarms, swarmModels: listSwarmModels,
    preparedRemote: integrations.preparedRemote,
    appendQueued: (session, item) => appendAcceptedQueuedTurn({ store, stateDir: options.stateDir, webRuns: options.webRuns, enabled, applyGoal, expandCommands }, session, item),
    resolveProvider(selection, sid) {
      // Opaque conversation identity preserves subscription thread continuity.
      const provider = providers.resolve(selection);
      integrations.bindSession(provider, sid);
      return observeOptionalProvider({ stateDir: options.stateDir, enabled, env }, provider, sid, selection.providerId);
    } });
  const lifecycle: LifecycleOptions = { store, stateDir: options.stateDir, enabled, allowReal: options.allowReal === true,
    approvals, liveApprovals: agent.liveApprovals, running, activeContext, resolveProvider: agent.resolveProvider, createRunner: agent.createRunner, knownTools: agent.knownTools, tasks: (sid) => taskRegistry.list(sid),
    supports: (session, request) => agent.supports(session, request), goalView: publicGoal, presentation: (session) => tavernRoleplay.presentation(session as Record<string, unknown>), settings: () => loadSettings(options.stateDir), runQueue: (session, _policy, run) => run(session), checkRemote: integrations.checkRemote };
  const attachmentOptions = { store, stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled,
    allowedRoots };
  const attachments = createAttachmentsApi(attachmentOptions);
  const runtime = createSessionRuntimeApi({ store, stateDir: options.stateDir, enabled, running, activeContext, resolveProvider: agent.resolveProvider, activeProvider: agent.activeProvider, permissionControl: agent.permissionControl,
    levels: (selection) => declaredReasoningLevels(providers.store, selection.provider_id as string | null, selection.model as string | null), configurationError,
    ...options.allowReal === true ? { modelCompact: (session: Session, instructions: string | null, source: string) => agent.compactSession(session, instructions, source) } : {}, defaultApi: (method, data) => providers.dispatch(method, ["api", "providers", "default"], {}, data) });
  const sessions = createSessionsApi({ ...attachmentOptions,
    enabled, running, lifecycle, consumePrepared, preparedRemote: integrations.preparedRemote, checkRemote: integrations.checkRemote, indexRemoteSummary: integrations.remoteSummary,
    rememberWorkspace: (root) => workspaces.remember(root), expandCommands,
    applyGoal,
    featureApis: [attachments, runtime, dynamicWorkflowApi,
      createSwarmSessionApi({ service: swarms, enabled, listModels: listSwarmModels, owner: async sid => { const session = await store.load(sid); await validateSessionWorkspace(attachmentOptions, session); return session; },
        journal: async (record, member) => member.sessionId ? (((await createSessionsStore(memberSessionsDirectory(options.stateDir, record.id), { enabled }).load(member.sessionId)).messages ?? []) as Record<string, unknown>[]).slice(-60).map(row => ({ role: row.role, content: typeof row.content === "string" ? row.content.slice(0, 2000) : "", tools: Array.isArray(row.tool_calls) ? row.tool_calls.map(call => String((call as { function?: { name?: unknown } }).function?.name ?? "")) : [] })) : [],
        activities: async (record) => {
          const mStore = createSessionsStore(memberSessionsDirectory(options.stateDir, record.id), { enabled });
          const out: Record<string, { activity: string }> = {};
          const now = Date.now();
          for (const m of record.members) {
            if (!m.sessionId) continue;
            // The panel polls this. A member's transcript is read again only after it ran a turn, or every 2 s while it is running.
            const stamp = `${m.turns}:${m.lastActiveAt ?? ""}`, cached = swarmActivityCache.get(m.sessionId);
            if (cached && cached.stamp === stamp && (m.state !== "active" || now - cached.at < 2000)) { if (cached.activity) out[m.name] = { activity: cached.activity }; continue; }
            swarmActivityCache.set(m.sessionId, { stamp, at: now, activity: "" });
            try {
              const rows = ((await mStore.load(m.sessionId)).messages ?? []) as Record<string, unknown>[];
              const last = [...rows].reverse().find((r) => r.role === "assistant");
              if (!last) continue;
              const calls = Array.isArray(last.tool_calls) ? last.tool_calls.map((c) => String((c as { function?: { name?: unknown } }).function?.name ?? "")).filter(Boolean) : [];
              const snippet = calls.length ? `Using ${calls.slice(-2).join(", ")}` : typeof last.content === "string" ? last.content.trim().slice(0, 140) : "";
              if (snippet) { out[m.name] = { activity: snippet }; swarmActivityCache.set(m.sessionId, { stamp, at: now, activity: snippet }); }
            } catch { /* ignore unreadable member session */ }
          }
          return out;
        } }),
      createContextLensHttp({ store, enabled, live: sid => activeContext.get(sid)?.active_session as Session ?? null, owners: ownersFromManifests(BUNDLED_TS_PLUGINS) }),
      createMcpRuntimeApi({ store, enabled, validateSession: session => validateSessionWorkspace(attachmentOptions, session), snapshot: sid => agent.mcpSnapshot(sid) }),
      createFileBytesApi({ store, stateDir: options.stateDir, enabled, validateSession: session => validateSessionWorkspace(attachmentOptions, session) }),
      createSessionStorageApi({ ...attachmentOptions, env }),
      createFileRewindApi({ store, stateDir: options.stateDir, enabled, revision: messageRevision, validateSession: session => validateSessionWorkspace(attachmentOptions, session), onApplied: (session, result) => { createSessionRuntimeEventLog(options.stateDir, String(session.id)).append({ type: 'FileRewound', payload: { messageId: result.messageId, paths: result.restored, operationIds: result.operationIds } }); } }),
      createPlanningApi({ store, enabled, running, interruptSession: agent.interruptSession }), createGitApi({ store, stateDir: options.stateDir, enabled, allowedRoots, rememberWorkspace: (root) => workspaces.remember(root) })], referenceStat: (root, path) => enabled("files") ? statWorkspaceReference(root, path) : null,
    defaultRoot, allowedRoots });
  // Tab open reads `workspaceRoots.map` on each request. A Proxy keeps grants
  // remembered after startup (Python `allowed_roots`) without snapshotting them.
  const browserRoots = new Proxy([] as string[], { get(_target, property) {
    const values = allowedRoots();
    if (property === Symbol.iterator) return values[Symbol.iterator].bind(values);
    const member = values[property as keyof string[]];
    return typeof member === "function" ? (member as (...args: never[]) => unknown).bind(values) : member;
  } });
  const browserHandoff = createBrowserHandoff({ stateDir: options.stateDir, enabled, running, desktop: !!options.desktopToken, projectDir, webRuns: options.webRuns, workspaceRoots: browserRoots });
  const sessionWorkspaceRoots = (): string[] => {
    if (isLink(store.directory)) return [];
    let names: string[];
    try { names = readdirSync(store.directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)); }
    catch { return []; }
    const roots: string[] = [];
    for (const name of names) {
      try {
        const root = store.readJournal(name.slice(0, -5)).root;
        if (typeof root === "string") roots.push(root);
      } catch (error) { if (isPyOSError(error) || isPyValueError(error)) continue; throw error; }
    }
    return roots;
  };
  const memoryHttp = createMemoryHttp({ stateDir: options.stateDir, enabled, projectDir, env, workspaceRoots: workspaces.options.declaredRoots, selectedRoots: () => workspaces.selectedRoots(), sessionRoots: sessionWorkspaceRoots });
  const dreamPorts = { stateDir: options.stateDir, enabled: (id: string) => enabled(id) && (id !== 'memory' || (loadUserSettings(options.stateDir).general as { memoryEnabled?: boolean } | undefined)?.memoryEnabled !== false), allowRealHost: options.allowReal === true, store,
    validateSession: (session: Parameters<typeof validateSessionWorkspace>[1]) => validateSessionWorkspace(attachmentOptions, session), resolveProvider: agent.resolveProvider };
  const memoryDreams = createMemoryDreamDriver({ ...dreamPorts, memoryHttp });
  const memoryDreamApi = createMemoryDreamApi(memoryDreams);
  const oceanDreams = createOceanDreamDriver(dreamPorts);
  const oceanDreamApi = createOceanDreamApi(oceanDreams);
  const filesHttp = createFilesHttp({ enabled, allowedRoots, listRoots: browseRoots, createRoots: browseRoots, maxEntries: workspaces.options.maxEntries, officePreview: (data, suffix) => previewBytes(data, suffix),
    loadSession: async (sid) => { const session = await store.load(sid); return typeof session.id === "string" && typeof session.root === "string" ? { id: session.id, root: session.root } : null; } });
  const hooksHttp = createHooksHttp({ stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled, allowedRoots });
  const skillsHttp = createSkillsHttp({ stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled, allowedRoots });
  const mcpResources = createMcpResourcesHttp({ stateDir: options.stateDir, enabled });
  const mcpOps = createMcpOpsHttp({ stateDir: options.stateDir, enabled, projectDir, webRuns: options.webRuns, allowedRoots });
  const elicitationHttp = createElicitationHttp({ stateDir: options.stateDir, enabled });
  const appsHttp = createAppsHttp({ stateDir: options.stateDir, enabled });
  const subagentResources = createSubagentsResourcesHttp({ stateDir: options.stateDir, enabled });
  const subagentTasks = createSubagentTasksHttp({ stateDir: options.stateDir, enabled, store, projectDir, webRuns: options.webRuns, allowedRoots, registry: taskRegistry,
    cancelEnabled: () => { const section = loadUserSettings(options.stateDir).agent; return section !== null && typeof section === "object" && !Array.isArray(section) && (section as { subagentCancelOneEnabled?: unknown }).subagentCancelOneEnabled === true; },
    authorize: () => null });
  const runtimeConfigApiForRequest = (includeLegacy = true) => createRuntimeConfigApi({ stateDir: options.stateDir, enabled, env, userDefaults: includeLegacy ? legacyRuntimeConfig(options.stateDir) : undefined, validate: validateAgentRuntimeConfig,
    resolveRoot: root => { try { return workspaces.resolveAllowed(root ?? defaultRoot(), true); } catch { throw new TypeError("workspace root not permitted"); } } });
  const runtimeConfigApi = runtimeConfigApiForRequest(false);
  const shellHttp = createShellSettingsApi({ stateDir: options.stateDir, enabled });
  const networkHttp = createNetworkHttp({ stateDir: options.stateDir, enabled, env });
  const swarmSettingsHttp = createSwarmSettingsHttp({ stateDir: options.stateDir, enabled });
  const toolJudgeHttp = createToolJudgeHttp({ stateDir: options.stateDir, enabled, sessions: function* () {
    if (isLink(store.directory)) return;
    let names: string[] = [];
    try { names = readdirSync(store.directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)); } catch { return; }
    for (const name of names) { try { yield { mtime: statSync(join(store.directory, name)).mtimeMs / 1000, stats: store.readJournal(name.slice(0, -5)).tool_judge_stats }; } catch { continue; } }
  } });
  const catalogNet = nodeNet();
  const extensionsHttp = createExtensionsHttp({ stateDir: options.stateDir, projectRoot: options.projectRoot, enabled, env, importers: [skillPackageImporter({ stateDir: options.stateDir }), rulePackImporter({ store: textPackageStore(options.stateDir, "cursor-rules") }), mcpPackageImporter({ stateDir: options.stateDir }), harnessImporter({ stateDir: options.stateDir })], writeResource: (kind, data) => (kind === "skills" ? skillsHttp : kind === "hooks" ? hooksHttp : commands).dispatch("POST", ["api", "resources", kind], {}, data), optionalChanged: () => integrations.syncOptional(), fetchUrl: async (url) => {
    const page = await fetchPage(catalogNet, url);
    return { output: typeof page.output === "string" ? page.output : "", truncated: page.truncated === true };
  } });
  const hostServices = createHostServices({ stateDir: options.stateDir, enabled, store, allowedRoots, resolveAllowed: (value) => workspaces.resolveAllowed(value), taskRegistry, sessionsRunning: () => running.size > 0, ...(options.desktopBridge ? { desktopBridge: options.desktopBridge } : {}), ...(options.desktopToken ? { desktopToken: options.desktopToken } : {}), ...(options.webappDir ? { webappDir: options.webappDir } : {}) });
  const pluginManager = createPluginManager({ projectRoot: options.projectRoot, stateDir: options.stateDir, locks, enabled });
  // A plugin switch has no hook: the side-panel browser worker and the terminals stop once their plugin is off.
  const sweeper = setInterval(() => {
    try {
      if (!enabled("browser") && currentWorker(options.stateDir)) void shutdownBrowser(options.stateDir).catch(() => {});
      hostServices.sweep();
    } catch { /* plugin state unreadable: the next tick retries */ }
  }, 1000);
  sweeper.unref();
  const migratedOwns = (method: string, parts: readonly string[]): boolean => pluginManager.owns(method, parts) || hooksHttp.owns(method, parts) || skillsHttp.owns(method, parts) || mcpResources.owns(method, parts) || mcpOps.owns(method, parts) || elicitationHttp.owns(method, parts) || appsHttp.owns(method, parts) || subagentResources.owns(method, parts) || subagentTasks.owns(method, parts) || runtimeConfigApi.owns(method, parts) || shellHttp.owns(method, parts) || networkHttp.owns(method, parts) || swarmSettingsHttp.owns(method, parts) || toolJudgeHttp.owns(method, parts) || memoryHttp.owns(method, parts) || filesHttp.owns(method, parts) || extensionsHttp.owns(method, parts) || hostServices.owns(method, parts) || integrations.owns(method, parts) || workflowsAutomation.owns(method, parts);
  return {
    agent, store, enabled, dynamicWorkflows, memoryDreams, swarms,
    asset: extensionsHttp.asset,
    csrfToken: bridge.csrfToken, routes: [...memoryDreamApi.routes, ...oceanDreamApi.routes,...settingsApi.routes, ...providers.routes, ...sessions.routes, ...commands.routes, ...composer.routes, ...hooksHttp.routes, ...skillsHttp.routes, ...mcpResources.routes, ...mcpOps.routes, ...elicitationHttp.routes, ...appsHttp.routes, ...subagentResources.routes, ...subagentTasks.routes, ...runtimeConfigApi.routes, ...shellHttp.routes, ...networkHttp.routes, ...swarmSettingsHttp.routes, ...toolJudgeHttp.routes, ...memoryHttp.routes, ...filesHttp.routes, ...extensionsHttp.routes, ...hostServices.routes, ...integrations.routes, ...workflowsAutomation.routes, ...pluginManager.routes],
    owns: (method, parts) => memoryDreamApi.owns(method, parts) || oceanDreamApi.owns(method, parts) ||settingsApi.owns(method, parts) || providers.owns(method, parts) || sessions.owns(method, parts) || browserHandoff.owns(method, parts) || commands.owns(method, parts) || composer.owns(method, parts) || migratedOwns(method, parts),
    lossless: (method, parts) => settingsApi.lossless(method, parts) || commands.lossless(method, parts) || hooksHttp.lossless(method, parts) || skillsHttp.lossless(method, parts) || mcpResources.lossless(method, parts) || subagentResources.lossless(method, parts) || extensionsHttp.lossless(method, parts) || workflowsAutomation.lossless(method, parts),
    async dispatch(method, parts, query, data, request) {
      if (settingsApi.owns(method, parts)) return settingsApi.dispatch(method, parts, query, data, { loopback: isLoopbackAddress((request?.remoteAddress ?? "").split("%")[0]!) });
      if (memoryDreamApi.owns(method, parts)) return memoryDreamApi.dispatch(method, parts, query, data);
      if (oceanDreamApi.owns(method, parts)) return oceanDreamApi.dispatch(method, parts, query, data);
      if (pluginManager.owns(method, parts)) return pluginManager.dispatch(method, parts, query, data);
      if (browserHandoff.owns(method, parts)) return browserHandoff.dispatch(method, parts, data);
      if (commands.owns(method, parts)) return commands.dispatch(method, parts, query, data);
      if (composer.owns(method, parts)) return composer.dispatch(method, parts, query, data);
      if (hooksHttp.owns(method, parts)) return hooksHttp.dispatch(method, parts, query, data);
      if (skillsHttp.owns(method, parts)) return skillsHttp.dispatch(method, parts, query, data);
      if (mcpResources.owns(method, parts)) return mcpResources.dispatch(method, parts, query, data);
      if (mcpOps.owns(method, parts)) return mcpOps.dispatch(method, parts, query, data);
      if (elicitationHttp.owns(method, parts)) return elicitationHttp.dispatch(method, parts, query, data);
      if (appsHttp.owns(method, parts)) return appsHttp.dispatch(method, parts, query, data);
      if (subagentResources.owns(method, parts)) return subagentResources.dispatch(method, parts, query, data);
      if (subagentTasks.owns(method, parts)) return subagentTasks.dispatch(method, parts, query, data);
      if (runtimeConfigApi.owns(method, parts)) return (enabled("settings") ? runtimeConfigApiForRequest() : runtimeConfigApi).dispatch(method, parts, query, data);
      if (shellHttp.owns(method, parts)) return shellHttp.dispatch(method, parts, query, data);
      if (networkHttp.owns(method, parts)) return networkHttp.dispatch(method, parts, query, data);
      if (swarmSettingsHttp.owns(method, parts)) return swarmSettingsHttp.dispatch(method, parts, query, data);
      if (toolJudgeHttp.owns(method, parts)) return toolJudgeHttp.dispatch(method, parts, query, data);
      if (memoryHttp.owns(method, parts)) return memoryHttp.dispatch(method, parts, query, data);
      if (filesHttp.owns(method, parts)) return filesHttp.dispatch(method, parts, query, data);
      if (extensionsHttp.owns(method, parts)) return extensionsHttp.dispatch(method, parts, query, data);
      if (hostServices.owns(method, parts)) return hostServices.dispatch(method, parts, query, data, request);
      if (integrations.owns(method, parts)) return integrations.dispatch(method, parts, query, data);
      if (workflowsAutomation.owns(method, parts)) return workflowsAutomation.dispatch(method, parts, query, data);
      const providerResult = await providers.dispatch(method, parts, query, data);
      if (providerResult !== null) return providerResult;
      return sessions.dispatch(method, parts, query, data, request);
    },
    async close() { clearInterval(sweeper); await swarms.close(); hostServices.close(); await shutdownBrowser(options.stateDir).catch(() => {}); await integrations.close(); await memoryDreams.close(); oceanDreams.close(); await dynamicWorkflows.close(); await agent.dispose(); await workflowsAutomation.close(); await locks.close(); },
  };
}
