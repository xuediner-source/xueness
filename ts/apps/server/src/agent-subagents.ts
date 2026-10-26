/**
 * The host's child runner for the subagents plugin's `task` tool (Python
 * `subagents/runner.run_subagent`): one bounded, read-only child per call,
 * run on the same kernel and workspace under the plan-mode ceiling, persisted
 * in Python's child-session layout, with the parent's `task_runs` row kept in
 * step.
 *
 * The same core backs the coordinator's executor: with `subagents.coordination`
 * the tool dispatches in the background, so `executeChild` takes the task id
 * the coordinator already allocated and leaves the registry outcome to it.
 */
import { platform } from "node:os";
import { isDict, pyLen, pySlice, pyStrip } from "@xueness/contracts";
import { AgentRunner, CLI_PREFIX_PROMPT, internalToolName, kernelAgentHooks, modelInputOf, modelToolName, sessionEnvInfo, toolContractExtension, toolMediaExtension, type AgentProvider, type Row } from "@xueness/agent";
import { createToolEnv, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import type { Context } from "@xueness/kernel";
import { PermissionSession } from "@xueness/permissions";
import { CHILD_DENIED_TOOLS, selectSubagent, childSummary, childSystemPrompt, ChildJournal, drainInbox, ensureChildDirectory, finishRun, findProfile, loadSubagents, newChild, newTaskId,
  prepareResume, PROMPT_MAX, raiseEscalation, recordRun, recoveryInfo, startRun, SUBAGENT_DENIED_TOOL_NAMES, SUBAGENT_MAX_STEPS, SUBAGENT_MAX_WALL_SECONDS, SUBAGENT_SUMMARY_MAX, agentOutputText,
  activeProfiles, branchHistory, childToolGrant, childWithInheritedHistory, clampModelSelection, type AgentProfile, type TaskRegistry } from "@xueness/plugin-subagents";
import { createSessionsStore, sessionsTurnRuntimeExtension, sessionsRuntimeEventsExtension, sessionsStableBoundariesExtension, sessionsCompactPersistenceExtension, type RuntimeSelection } from "@xueness/plugin-sessions";
import { filesReadStateExtension, filesHistoryExtension } from "@xueness/plugin-files";
import { batchCallsExtension } from "@xueness/plugin-batch_calls";
import { nativeOpsExtension, type NativeOpsBinding } from "@xueness/plugin-native_ops";
import { providerToolResultBudgetExtension } from "@xueness/plugin-providers";
import { providerModelExecutionExtension, providerRequestShapingExtension } from "@xueness/plugin-providers";
import { networkActivityExtension } from "@xueness/plugin-network";
import { SessionStore, type Session } from "@xueness/sessions";
import { ToolBridge } from "@xueness/tool-bridge";

export interface ChildRunHost {
  nativeOps?: NativeOpsBinding;
  kernel: Context;
  env: ToolEnv;
  stateDir: string;
  enabled(id: string): boolean;
  parent: Session;
  provider: AgentProvider;
  /** The parent run's disallowed tools (the child never gets more). */
  disallowed: readonly string[];
  /** F08.01 model ceiling: every model the host configured; null when none are (unbounded). */
  modelCeiling?: readonly string[] | null;
  resolveProvider?: (selection: RuntimeSelection, sid: string) => AgentProvider;
  /** The parent run is stopping. */
  stopped(): boolean;
  /** Process-local registry shared with the session tasks HTTP handler. Absent in tests that do not serve that route. */
  registry?: TaskRegistry;
  hostSignal?: AbortSignal;
  executionShell?: { shell: "posix" | "powershell"; readOnlyCommands: boolean };
}

const failure = (code: string, message: string, extra: Row = {}): ToolResult => ({ ok: false, output: message, error: { code, message }, ...extra } as ToolResult);
const MODEL_KEYS = [["providerId", "provider_id"], ["model", "model"], ["reasoningEffort", "reasoning_effort"]] as const;

/** Python `provider_for_agent` + the durable `bound_selection`: the parent's saved selection, then the definition's overrides. */
export function childSelection(parent: Session, definition: Row | undefined, allowed: readonly string[] | null = null): { selection: Row; override: boolean } {
  const saved = isDict(parent.model_selection) ? parent.model_selection : {};
  const base: Row = {};
  for (const [, key] of MODEL_KEYS) if (typeof saved[key] === "string") base[key] = saved[key];
  let wanted: Row = {};
  let override = false;
  if (definition) {
    for (const [source] of MODEL_KEYS) { const value = definition[source]; if (value !== undefined && value !== null && typeof value !== "string") throw new Error("invalid sub-agent " + source); }
    if (typeof definition.providerId === "string" && pyLen(definition.providerId) > 64 || typeof definition.model === "string" && pyLen(definition.model) > 200) throw new Error("invalid sub-agent model selection");
    for (const [source, target] of MODEL_KEYS) {
      const value = definition[source];
      if (typeof value === "string" && pyStrip(value)) { wanted[target] = pyStrip(value); override = true; }
    }
  }
  // F08.01: a definition's override holds only inside the parent's model
  // ceiling (`allowed` null: no ceiling configured); anything wider falls back
  // to the parent's own selection for that key instead of escalating.
  const selection: Row = { ...base, ...clampModelSelection(wanted, base, allowed).selection };
  if (typeof definition?.providerId === "string" && pyStrip(definition.providerId) && !(typeof definition.model === "string" && pyStrip(definition.model))) delete selection.model;
  return { selection, override };
}

/** The child's tool boundary: the plugin's one inheritance rule (F08.01), by Xueness name. */
export function childToolPolicy(profile: AgentProfile, known: readonly string[], parentDisallowed: readonly string[]): { allowed(name: string): boolean; denied: string[] } {
  const grant = childToolGrant({ profile: { tools: profile.tools, disallowedTools: profile.disallowedTools }, known, parentDisallowed,
    forcedDenied: [...CHILD_DENIED_TOOLS, ...SUBAGENT_DENIED_TOOL_NAMES], alias: internalToolName });
  const effective = new Set(grant.effective);
  const denied = new Set(grant.denied);
  const allowed = (name: string): boolean => effective.has(name) && !denied.has(modelToolName(name));
  return { allowed, denied: [...denied] };
}

/** What one child run produced, before it is shaped as a tool result or a registry outcome. */
export interface ChildOutcome {
  result: ToolResult;
  ok: boolean;
  summary: string;
  error: string;
  steps: number;
  stopped: boolean;
}

export interface ChildExecutionOptions {
  /** The coordinator already recorded this task; re-recording would drop `workerActive`. */
  recordRegistry?: boolean;
  /** Run the retained child journal instead of creating a new child (explicit resume). */
  resumeSessionId?: string;
}

/**
 * One bounded read-only child under `taskId`. `cancelled` is the caller's stop
 * predicate (the foreground tool's signal, or the coordinator's own state).
 */
export async function executeChild(host: ChildRunHost, input: Row, taskId: string, cancelled: () => boolean, options: ChildExecutionOptions = {}): Promise<ChildOutcome> {
  const prompt = input.prompt;
  const reject = (code: string, message: string): ChildOutcome => ({ result: failure(code, message), ok: false, summary: "", error: message, steps: 0, stopped: false });
  if (typeof prompt !== "string" || !pyStrip(prompt) || pyLen(prompt) > PROMPT_MAX) return reject("invalid_argument", `prompt must contain 1..${PROMPT_MAX} characters`);
  if (input.agent !== undefined && input.agent !== null && (typeof input.agent !== "string" || !pyStrip(input.agent))) return reject("invalid_argument", "agent must be a non-empty string");
  if (input.inherit_history !== undefined && input.inherit_history !== null && typeof input.inherit_history !== "boolean") return reject("invalid_argument", "inherit_history must be a boolean");
  const agents = loadSubagents(host.stateDir);
  const profile = findProfile(agents, input.agent as string | undefined);
  if (!profile) return reject("agent_unknown_type", `Agent type '${String(input.agent)}' not found. Available agents: ${activeProfiles(agents).map((item) => item.name).join(", ")}`);
  const parent = host.parent; const root = String(parent.root);
  const recordRegistry = options.recordRegistry !== false;
  // Python records the selected definition's id (`explore` for the built-in fallback), none when no agent was named.
  const agentId = input.agent === undefined || input.agent === null ? null : String(selectSubagent(agents, input.agent)?.id ?? profile.definition?.id ?? profile.name);
  const run = startRun(taskId, String(parent.id), agentId, prompt, root);
  if (recordRegistry) {
    host.registry?.record(taskId, { parentSession: String(parent.id), agent: agentId, prompt, root });
    host.registry?.update(taskId, { workerActive: true });
  }
  const settleRegistry = (outcome: { ok: boolean; cancelled?: boolean; summary?: string; error?: string; steps?: number }): void => {
    const registry = host.registry;
    if (!registry || !recordRegistry) return;
    if (outcome.cancelled) registry.cancel(taskId);
    registry.finish(taskId, outcome);
    registry.update(taskId, { workerActive: false });
  };
  const fail = (message: string, code = "agent_child_runtime_failed"): ChildOutcome => {
    recordRun(parent as Row, finishRun(run, { ok: false, error: message, steps: 0 }));
    settleRegistry({ ok: false, error: message, steps: 0 });
    return { result: failure(code, message, { task_id: taskId, steps: 0 }), ok: false, summary: "", error: message, steps: 0, stopped: false };
  };
  let provider = host.provider; let selection: Row;
  try {
    const chosen = childSelection(parent, profile.definition, host.modelCeiling ?? null);
    selection = chosen.selection;
    if (chosen.override) {
      if (!host.resolveProvider) return fail("sub-agent model configuration is unavailable in this runtime");
      provider = host.resolveProvider({ providerId: (selection.provider_id as string) ?? null, model: (selection.model as string) ?? null, reasoningEffort: (selection.reasoning_effort as string) ?? null }, String(parent.id));
    }
  } catch (error) { return fail(pySlice(error instanceof Error ? error.message : String(error), 500) || "sub-agent model configuration is invalid"); }
  let directory: string;
  try { directory = ensureChildDirectory(host.stateDir, String(parent.id)); } catch (error) { return fail(error instanceof Error ? error.message : "child session directory unavailable"); }
  const known = host.kernel.tools.list().map((tool) => tool.name);
  const policy = childToolPolicy(profile, known, host.disallowed);
  const env = sessionEnvInfo(String(parent.id), root);
  const system = childSystemPrompt(profile, { cwd: env.cwd, isGitRepository: env.isGitRepository === true, platform: env.platform, shell: env.shell, osVersion: env.osVersion }, CLI_PREFIX_PROMPT);
  const store = createSessionsStore(directory, { enabled: host.enabled });
  // One journal for the whole run: the escalation port and the safe-boundary
  // inbox drain must see the same inbox/escalation records the parent does.
  const journal = new ChildJournal(host.stateDir, String(parent.id), { taskId, root });
  let child: Session;
  try {
    child = options.resumeSessionId
      ? prepareResume(journal.load(options.resumeSessionId), prompt) as Session
      : newChild({ parent: String(parent.id), taskId, root, system, prompt, agent: agentId, selection,
        rootSessionId: isDict(parent.delegation) && typeof parent.delegation.rootSessionId === "string" ? parent.delegation.rootSessionId : undefined }) as Session;
    // F08.01: `inherit_history` branches a bounded copy of the parent's turns
    // into a fresh child between its system and task prompts; the branch is
    // fresh objects, so the parent's own journal is never touched. A resumed
    // child keeps its own history instead.
    if (!options.resumeSessionId && input.inherit_history === true) childWithInheritedHistory(child as unknown as Row, branchHistory(parent as unknown as Row));
  } catch (error) { return fail(pySlice(error instanceof Error ? error.message : String(error), 500) || "child history is unavailable or unsafe for recovery"); }
  run.childSessionId = child.id; run.parentSessionId = parent.id; run.rootSessionId = (child.delegation as Row).rootSessionId;
  recordRun(parent as Row, run);
  const isCancelled = (): boolean => cancelled() || host.registry?.isCancelled(taskId) === true;
  const permissions = new PermissionSession({ mode: "plan", disallow: policy.denied, ...host.executionShell ?? { readOnlyCommands: platform() !== "win32", shell: platform() === "win32" ? "powershell" : "posix" } });
  // Its own read state (ZCode children keep their own readFileState): a child read never lets the parent edit unread.
  const toolEnv = createToolEnv({ cwd: host.env.cwd, roots: host.env.roots, artifactsDir: host.env.artifactsDir, owner: String(child.id) });
  toolEnv.modelInput = modelInputOf(provider);
  toolEnv.currentSession = () => child;
  // F08.03 child side: `respond_to_coordinator` runs only when this port is
  // bound, and raising marks the child as holding a pending question so plain
  // guide messages are refused until the parent answers it.
  toolEnv.escalationPort = {
    escalate: (question, requestId) => {
      const outcome = raiseEscalation(journal, child, question, requestId, taskId);
      child.pending_question = true;
      return outcome;
    },
  };
  // Safe-boundary delivery (F08.03): apply queued coordinator messages between
  // steps, before the next provider call reads the transcript; an applied item
  // is stamped in the same atomic step, so a replay never re-delivers it.
  const drainCoordination = (): void => {
    try { drainInbox(journal, child); } catch { /* retried at the next boundary */ }
  };
  const bridge = new ToolBridge({ kernel: host.kernel, permissions, env: toolEnv,
    approver: () => ({ behavior: "deny", reason: "subagent_read_only", message: "A subagent is read-only and cannot ask for approval; report what you found instead." }) });
  // Subagent children inherit the parent's foreground admission scope: the
  // user's turn waits on them, so they must not queue behind workflow runs.
  const base = kernelAgentHooks(host.kernel, { enabled: host.enabled, extensions: [sessionsRuntimeEventsExtension(), sessionsTurnRuntimeExtension(), sessionsStableBoundariesExtension(), sessionsCompactPersistenceExtension(), filesReadStateExtension(toolEnv.tracker), filesHistoryExtension(), networkActivityExtension(toolEnv), toolContractExtension(), batchCallsExtension, ...host.nativeOps ? [nativeOpsExtension(host.nativeOps)] : [], toolMediaExtension(), providerRequestShapingExtension(), providerModelExecutionExtension({ admissionScope: { foreground: true } }), providerToolResultBudgetExtension()] });
  const hooks = { ...base, async tools(context: Parameters<typeof base.tools>[0]) { return (await base.tools(context)).filter((tool) => isDict(tool.function) && policy.allowed(String(tool.function.name))); } };
  const runner = new AgentRunner({ root, store, stateDir: host.stateDir, provider, toolBridge: bridge, hooks, hostSignal: host.hostSignal });
  const started = performance.now();
  let runError = false;
  try {
    await store.save(child);
    drainCoordination();
    if (!isCancelled()) {
      try { await runner.run(child, { maxSteps: SUBAGENT_MAX_STEPS, maxWallSeconds: SUBAGENT_MAX_WALL_SECONDS, maxChars: 24000, shouldStop: isCancelled, onStep: (steps) => { drainCoordination(); run.steps = steps; } }); }
      catch { runError = true; }
    }
    if (isCancelled()) { child.status = "stopped"; (child.delegation as Row).cancelled = true; }
    else if (runError) { child.status = "paused"; child.pause_reason = "child execution interrupted; explicit recovery required"; }
    (child.delegation as Row).endedAt = Date.now() / 1000;
    await store.save(child);
  } catch { runError = true; }
  const stopped = isCancelled();
  const summary = pySlice(childSummary(child as Row), SUBAGENT_SUMMARY_MAX);
  const ok = !stopped && !runError && child.status === "completed";
  const reason = typeof child.pause_reason === "string" && pyStrip(child.pause_reason) ? pySlice(child.pause_reason, 500) : "sub-agent ended with status " + String(child.status || "unknown");
  const error = stopped ? "cancelled" : runError ? "sub-agent run failed" : ok ? "" : reason;
  const steps = Number(child.steps ?? 0);
  Object.assign(finishRun(run, { ok, cancelled: stopped, summary, error, steps }), recoveryInfo(child as Row));
  recordRun(parent as Row, run);
  settleRegistry({ ok, cancelled: stopped, summary, error, steps });
  const facts = { task_id: taskId, steps, agent: agentId, childSessionId: child.id };
  const outcome: ChildOutcome = { result: { ok: false, output: "", error: { code: "cancelled", message: "cancelled" } }, ok, summary, error, steps, stopped };
  if (stopped) return { ...outcome, result: failure("cancelled", "cancelled", facts) };
  if (!ok) return { ...outcome, result: failure("agent_child_runtime_failed", error, { ...facts, summary }) };
  const toolUses = (child.messages as Row[]).filter((row) => isDict(row) && row.role === "tool").length;
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  return { ...outcome, result: { ok: true, output: agentOutputText({ agentId: taskId, text: summary, toolUses, durationMs }),
    data: { status: "completed", agentId: taskId, agentType: profile.name, description: typeof input.description === "string" ? input.description : "", totalToolUseCount: toolUses, totalDurationMs: durationMs },
    ...facts, summary } as ToolResult };
}

/** The foreground `task` tool: one child, its report returned in place. */
export function childRunner(host: ChildRunHost): (input: Row, signal: AbortSignal | undefined) => Promise<ToolResult> {
  return async (input, signal) => {
    const taskId = newTaskId();
    const cancelled = (): boolean => !!signal?.aborted || host.stopped();
    return (await executeChild(host, input, taskId, cancelled)).result;
  };
}

/**
 * The coordinator's executor: the same child under the task id it allocated,
 * reported as a registry outcome (`{ok, summary, error, steps}`). The
 * coordinator records and finishes the registry row itself, so this path only
 * writes the parent's `task_runs` row. `args` is the dispatch input for a new
 * child, or the coordinator's resume arguments (`resume_session_id`) for one.
 */
export function backgroundChildRunner(host: ChildRunHost): (taskId: string, stopped: () => boolean, args: Row) => Promise<Row> {
  return async (taskId, stopped, args) => {
    const resume = typeof args.resume_session_id === "string" ? args.resume_session_id : undefined;
    const outcome = await executeChild(host, args, taskId, () => stopped() || host.stopped(),
      { recordRegistry: false, ...(resume ? { resumeSessionId: resume } : {}) });
    return { ok: outcome.ok, summary: outcome.summary, error: outcome.error, steps: outcome.steps };
  };
}
