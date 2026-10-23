/** Assemble feature-owned APIs; the front door owns all transport guards. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { createSettingsApi, createRuntimeConfigApi, declaredWorkspaceRoots, loadSettings as loadUserSettings, nativePickerCapability, PickerFailed } from "@xueness/plugin-settings";
import { configurationError, createProvidersApi, declaredReasoningLevels, loadSettings } from "@xueness/plugin-providers";
import { appendAcceptedQueuedTurn, createAttachmentsApi, createSessionRuntimeApi, createSessionsApi, createSessionsStore, createSessionRuntimeEventLog, createSessionStorageApi, validateSessionWorkspace, messageRevision, MediaArtifactStore, type ApprovalBuckets, type LifecycleOptions } from "@xueness/plugin-sessions";
import { createFilesHttp, createFileRewindApi, createFileBytesApi, listLevel, statWorkspaceReference } from "@xueness/plugin-files";
import { previewBytes } from "@xueness/plugin-office";
import { createMemoryHttp, createMemoryDreamApi, type MemoryDreamService } from "@xueness/plugin-memory";
import { createMemoryDreamDriver } from './memory-dream-driver.ts';
import { isLink, isPyOSError, isPyValueError, NativeFileLocks, SessionStore, type Session } from "@xueness/sessions";
import type { ApiDispatcher } from "./api-body.ts";
import { effectivePlugins } from "./plugin-state.ts";
import { createAgentService, type AgentServiceOptions } from "./agent-service.ts";
import { createPlanningApi, publicGoal, stageGoal } from "@xueness/plugin-planning";
import { createGitApi } from "@xueness/plugin-git";
import { createHooksHttp } from "@xueness/plugin-hooks";
import { createSkillsHttp } from "@xueness/plugin-skills";
import { createElicitationHttp, createMcpOpsHttp, createMcpResourcesHttp } from "@xueness/plugin-mcp";
import { createSubagentTasksHttp, createSubagentsResourcesHttp, TaskRegistry } from "@xueness/plugin-subagents";
import { createShellSettingsApi } from "@xueness/plugin-shell";
import { createMcpRuntimeApi } from "@xueness/plugin-mcp";
import { legacyRuntimeConfig, validateAgentRuntimeConfig } from "./runtime-configuration.ts";
import { createNetworkHttp, fetchPage, nodeNet } from "@xueness/plugin-network";
import { createExtensionsHttp } from "@xueness/plugin-extensions";
import { createBrowserHandoff } from "./browser-handoff.ts";
import { createComposerFeatures } from "./composer-features.ts";
import { isLoopbackAddress } from "./py-url.ts";
import { createRound5 } from "./round5-http.ts";
import { createRound6 } from "./round6-http.ts";
import { createRound7 } from "./round7-http.ts";
import { createRound8 } from "./round8-http.ts";
import { DynamicServiceError, DynamicWorkflowService, createDynamicWorkflowApi } from '@xueness/plugin-workflows';
import { createDynamicWorkflowDriver } from './dynamic-workflow-driver.ts';
import { NativeProvider } from "@xueness/plugin-subscriptions";

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
export type ApplicationApi = ApiDispatcher & { close(): Promise<void>; agent: AgentService; store: SessionStore; enabled(id: string): boolean; dynamicWorkflows: DynamicWorkflowService; memoryDreams: MemoryDreamService };
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
  const round6 = createRound6({ stateDir: options.stateDir, projectDir, enabled, store, locks, providers: providers.store, createRoots: () => browseRoots, env });
  const { commands, composer } = createComposerFeatures({ projectRoot: options.projectRoot, projectDir, stateDir: options.stateDir, webRuns: options.webRuns, store, providers: providers.store,
    running, enabled, allowedRoots, defaultRoot, allowReal: options.allowReal === true, env, remote: round6.composerRemote });
  const consumePrepared = (token: string, root: string): Promise<Record<string, unknown>> => composer.consumePrepared(token, root);
  const expandCommands = composer.expandCommands;
  const media = new MediaArtifactStore(options.stateDir, locks);
  const applyGoal = (session: Session, text: string): void => { stageGoal(session, text, { enabled, replace: true, source: "composer" }); };
  const taskRegistry = new TaskRegistry();
  const dynamicDriver = createDynamicWorkflowDriver({ stateDir: options.stateDir, store, enabled });
  const dynamicWorkflows = new DynamicWorkflowService({ stateDir: options.stateDir, enabled, driver: dynamicDriver, allowRealHost: () => options.allowReal === true,
    owner: async sid => {
      const session = await store.load(sid);
      try { await validateSessionWorkspace({ store, stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled, allowedRoots }, session); }
      catch { throw new DynamicServiceError(403, 'workspace is not authorized'); }
      return session;
    }, answerActor: dynamicDriver.answer });
  const dynamicWorkflowApi = createDynamicWorkflowApi(dynamicWorkflows);
  const round7 = createRound7({ projectRoot: options.projectRoot, projectDir, stateDir: options.stateDir, webRuns: options.webRuns, enabled, store, allowedRoots, allowReal: options.allowReal === true, env, ...(options.scheduler === false ? { scheduler: false } : {}) });
  const agent = createAgentService({ ...options.agent, store, stateDir: options.stateDir, configEnv: env, enabled, approvals, mediaStore: media, allowModelRequests: options.allowReal, taskRegistry, workflowLauncher: round7.launcher, dynamicWorkflows,
    preparedRemote: round6.preparedRemote,
    appendQueued: (session, item) => appendAcceptedQueuedTurn({ store, stateDir: options.stateDir, webRuns: options.webRuns, enabled, applyGoal, expandCommands }, session, item),
    resolveProvider(selection, sid) {
      // Opaque conversation identity preserves subscription thread continuity.
      const provider = providers.resolve(selection);
      if (provider instanceof NativeProvider) provider.sessionId = sid;
      return provider;
    } });
  const lifecycle: LifecycleOptions = { store, stateDir: options.stateDir, enabled, allowReal: options.allowReal === true,
    approvals, liveApprovals: agent.liveApprovals, running, activeContext, resolveProvider: agent.resolveProvider, createRunner: agent.createRunner, knownTools: agent.knownTools,
    supports: (session, request) => agent.supports(session, request), goalView: publicGoal, settings: () => loadSettings(options.stateDir), runQueue: (session, _policy, run) => run(session), checkRemote: round6.checkRemote };
  const attachmentOptions = { store, stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled,
    allowedRoots };
  const attachments = createAttachmentsApi(attachmentOptions);
  const runtime = createSessionRuntimeApi({ store, stateDir: options.stateDir, enabled, running, activeContext, resolveProvider: agent.resolveProvider, activeProvider: agent.activeProvider,
    levels: (selection) => declaredReasoningLevels(providers.store, selection.provider_id as string | null, selection.model as string | null), configurationError,
    ...options.allowReal === true ? { modelCompact: (session: Session, instructions: string | null, source: string) => agent.compactSession(session, instructions, source) } : {}, defaultApi: (method, data) => providers.dispatch(method, ["api", "providers", "default"], {}, data) });
  const sessions = createSessionsApi({ ...attachmentOptions,
    enabled, running, lifecycle, consumePrepared, preparedRemote: round6.preparedRemote, checkRemote: round6.checkRemote, indexRemoteSummary: round6.remoteSummary,
    rememberWorkspace: (root) => workspaces.remember(root), expandCommands,
    applyGoal,
    featureApis: [attachments, runtime, dynamicWorkflowApi,
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
  const memoryDreams = createMemoryDreamDriver({ stateDir: options.stateDir, enabled: id => enabled(id) && (id !== 'memory' || (loadUserSettings(options.stateDir).general as { memoryEnabled?: boolean } | undefined)?.memoryEnabled !== false), allowRealHost: options.allowReal === true, store, memoryHttp,
    validateSession: session => validateSessionWorkspace(attachmentOptions, session), resolveProvider: agent.resolveProvider });
  const memoryDreamApi = createMemoryDreamApi(memoryDreams);
  const filesHttp = createFilesHttp({ enabled, allowedRoots, listRoots: browseRoots, createRoots: browseRoots, maxEntries: workspaces.options.maxEntries, officePreview: (data, suffix) => previewBytes(data, suffix),
    loadSession: async (sid) => { const session = await store.load(sid); return typeof session.id === "string" && typeof session.root === "string" ? { id: session.id, root: session.root } : null; } });
  const hooksHttp = createHooksHttp({ stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled, allowedRoots });
  const skillsHttp = createSkillsHttp({ stateDir: options.stateDir, webRuns: options.webRuns, projectDir, enabled, allowedRoots });
  const mcpResources = createMcpResourcesHttp({ stateDir: options.stateDir, enabled });
  const mcpOps = createMcpOpsHttp({ stateDir: options.stateDir, enabled, projectDir, webRuns: options.webRuns, allowedRoots });
  const elicitationHttp = createElicitationHttp({ stateDir: options.stateDir, enabled });
  const subagentResources = createSubagentsResourcesHttp({ stateDir: options.stateDir, enabled });
  const subagentTasks = createSubagentTasksHttp({ stateDir: options.stateDir, enabled, store, projectDir, webRuns: options.webRuns, allowedRoots, registry: taskRegistry,
    cancelEnabled: () => { const section = loadUserSettings(options.stateDir).agent; return section !== null && typeof section === "object" && !Array.isArray(section) && (section as { subagentCancelOneEnabled?: unknown }).subagentCancelOneEnabled === true; },
    authorize: () => null });
  const runtimeConfigApiForRequest = (includeLegacy = true) => createRuntimeConfigApi({ stateDir: options.stateDir, enabled, env, userDefaults: includeLegacy ? legacyRuntimeConfig(options.stateDir) : undefined, validate: validateAgentRuntimeConfig,
    resolveRoot: root => { try { return workspaces.resolveAllowed(root ?? defaultRoot(), true); } catch { throw new TypeError("workspace root not permitted"); } } });
  const runtimeConfigApi = runtimeConfigApiForRequest(false);
  const shellHttp = createShellSettingsApi({ stateDir: options.stateDir, enabled });
  const networkHttp = createNetworkHttp({ stateDir: options.stateDir, enabled, env });
  const catalogNet = nodeNet();
  const extensionsHttp = createExtensionsHttp({ stateDir: options.stateDir, enabled, env, fetchUrl: async (url) => {
    const page = await fetchPage(catalogNet, url);
    return { output: typeof page.output === "string" ? page.output : "", truncated: page.truncated === true };
  } });
  const round5 = createRound5({ stateDir: options.stateDir, enabled, store, allowedRoots, resolveAllowed: (value) => workspaces.resolveAllowed(value), taskRegistry, sessionsRunning: () => running.size > 0, ...(options.desktopBridge ? { desktopBridge: options.desktopBridge } : {}), ...(options.desktopToken ? { desktopToken: options.desktopToken } : {}), ...(options.webappDir ? { webappDir: options.webappDir } : {}) });
  const round8 = createRound8({ projectRoot: options.projectRoot, stateDir: options.stateDir, locks, enabled });
  const migratedOwns = (method: string, parts: readonly string[]): boolean => round8.owns(method, parts) || hooksHttp.owns(method, parts) || skillsHttp.owns(method, parts) || mcpResources.owns(method, parts) || mcpOps.owns(method, parts) || elicitationHttp.owns(method, parts) || subagentResources.owns(method, parts) || subagentTasks.owns(method, parts) || runtimeConfigApi.owns(method, parts) || shellHttp.owns(method, parts) || networkHttp.owns(method, parts) || memoryHttp.owns(method, parts) || filesHttp.owns(method, parts) || extensionsHttp.owns(method, parts) || round5.owns(method, parts) || round6.owns(method, parts) || round7.owns(method, parts);
  return {
    agent, store, enabled, dynamicWorkflows, memoryDreams,
    csrfToken: bridge.csrfToken, routes: [...memoryDreamApi.routes, ...settingsApi.routes, ...providers.routes, ...sessions.routes, ...commands.routes, ...composer.routes, ...hooksHttp.routes, ...skillsHttp.routes, ...mcpResources.routes, ...mcpOps.routes, ...elicitationHttp.routes, ...subagentResources.routes, ...subagentTasks.routes, ...runtimeConfigApi.routes, ...shellHttp.routes, ...networkHttp.routes, ...memoryHttp.routes, ...filesHttp.routes, ...extensionsHttp.routes, ...round5.routes, ...round6.routes, ...round7.routes, ...round8.routes],
    owns: (method, parts) => memoryDreamApi.owns(method, parts) || settingsApi.owns(method, parts) || providers.owns(method, parts) || sessions.owns(method, parts) || browserHandoff.owns(method, parts) || commands.owns(method, parts) || composer.owns(method, parts) || migratedOwns(method, parts),
    lossless: (method, parts) => settingsApi.lossless(method, parts) || commands.lossless(method, parts) || hooksHttp.lossless(method, parts) || skillsHttp.lossless(method, parts) || mcpResources.lossless(method, parts) || subagentResources.lossless(method, parts) || extensionsHttp.lossless(method, parts) || round7.lossless(method, parts),
    async dispatch(method, parts, query, data, request) {
      if (settingsApi.owns(method, parts)) return settingsApi.dispatch(method, parts, query, data, { loopback: isLoopbackAddress((request?.remoteAddress ?? "").split("%")[0]!) });
      if (memoryDreamApi.owns(method, parts)) return memoryDreamApi.dispatch(method, parts, query, data);
      if (round8.owns(method, parts)) return round8.dispatch(method, parts, query, data);
      if (browserHandoff.owns(method, parts)) return browserHandoff.dispatch(method, parts, data);
      if (commands.owns(method, parts)) return commands.dispatch(method, parts, query, data);
      if (composer.owns(method, parts)) return composer.dispatch(method, parts, query, data);
      if (hooksHttp.owns(method, parts)) return hooksHttp.dispatch(method, parts, query, data);
      if (skillsHttp.owns(method, parts)) return skillsHttp.dispatch(method, parts, query, data);
      if (mcpResources.owns(method, parts)) return mcpResources.dispatch(method, parts, query, data);
      if (mcpOps.owns(method, parts)) return mcpOps.dispatch(method, parts, query, data);
      if (elicitationHttp.owns(method, parts)) return elicitationHttp.dispatch(method, parts, query, data);
      if (subagentResources.owns(method, parts)) return subagentResources.dispatch(method, parts, query, data);
      if (subagentTasks.owns(method, parts)) return subagentTasks.dispatch(method, parts, query, data);
      if (runtimeConfigApi.owns(method, parts)) return (enabled("settings") ? runtimeConfigApiForRequest() : runtimeConfigApi).dispatch(method, parts, query, data);
      if (shellHttp.owns(method, parts)) return shellHttp.dispatch(method, parts, query, data);
      if (networkHttp.owns(method, parts)) return networkHttp.dispatch(method, parts, query, data);
      if (memoryHttp.owns(method, parts)) return memoryHttp.dispatch(method, parts, query, data);
      if (filesHttp.owns(method, parts)) return filesHttp.dispatch(method, parts, query, data);
      if (extensionsHttp.owns(method, parts)) return extensionsHttp.dispatch(method, parts, query, data);
      if (round5.owns(method, parts)) return round5.dispatch(method, parts, query, data, request);
      if (round6.owns(method, parts)) return round6.dispatch(method, parts, query, data);
      if (round7.owns(method, parts)) return round7.dispatch(method, parts, query, data);
      const providerResult = await providers.dispatch(method, parts, query, data);
      if (providerResult !== null) return providerResult;
      return sessions.dispatch(method, parts, query, data, request);
    },
    async close() { round5.close(); round6.close(); await memoryDreams.close(); await dynamicWorkflows.close(); await agent.dispose(); await round7.close(); await locks.close(); },
  };
}
