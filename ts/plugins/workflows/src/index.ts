/**
 * Durable workflow runs and background jobs (Python
 * `bundled_plugins/workflows`).
 *
 * The plugin owns the durable records, the model-facing tools and the
 * `/api/workflows` family. Two seams belong to the host because a plugin may
 * not import another plugin or the agent:
 *
 *  - `workflows.agent` runs an actor node. Without it an agent node settles as
 *    `paused` with Python's "real model execution is not enabled", exactly as
 *    `launch(allow_real=False)` refuses one.
 *  - `workflows.store` publishes the store operations automation and the
 *    expert workflow need, so neither has to import this package.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { drive, type DriveOptions, type NodeExecutor } from "./drive.ts";
import { executeAgentNode, type AgentNodeHost } from "./execute-agent.ts";
import { executeCommandNode, type RunControl } from "./execute-command.ts";
import type { Row } from "./plan.ts";
import { SavedWorkflowLibrary } from "./saved-library.ts";
import { WorkflowStore, type WorkerLauncher } from "./store.ts";
import { workflowTools, type WorkflowToolsOptions } from "./tools.ts";
export * from './dynamic-types.ts';
export * from './dynamic-compile.ts';
export * from './dynamic-evaluate.ts';
export * from './dynamic-store.ts';
export * from './dynamic-engine.ts';
export * from './dynamic-service.ts';
export * from './dynamic-http.ts';
export * from './dynamic-tools.ts';
import type { DynamicWorkflowService } from './dynamic-service.ts';

export { ID, NODE, ACTIVE, nowSeconds, stamp, resolvePath, isDirectory, isInside, validatePlan, workflowPlanDigest, workspaceFingerprint, type Row } from "./plan.ts";
export { WorkflowStore, setWorkerLauncher, isMissing, type WorkerLauncher } from "./store.ts";
export { isSymlink, ensurePrivateDirectory, writeJsonAtomic, readJson, lockPath, RECORD_LOCK_SECONDS } from "./state-file.ts";
export { ProviderGovernor } from "./governor.ts";
export { compileWorkflowScript } from "./dsl.ts";
export { NAME, MAX_DESCRIPTION, validateName, templatePlanDigest, sourcePlan, latestRunPlan, SavedWorkflowLibrary } from "./saved-library.ts";
export { SESSION, SUBCOMMANDS, USAGE, CANDIDATE_LIMIT, DynamicRunError, bindPluginEnabled, ownerSessionId, listRuns, cancelRun, resumeRun, invoke, parseInvocation, chat, dispatchDynamicRuns, type DynamicHttpOptions } from "./dynamic-runs.ts";
export { LOG_LIMIT, executeCommandNode, type RunControl } from "./execute-command.ts";
export { ownerPermissionCeiling, workflowChildWritable, workflowCommandAllowed, dependencyContext, executeAgentNode, type AgentNodeHost } from "./execute-agent.ts";
export { drive, settledStatus, type NodeExecutor, type DriveOptions } from "./drive.ts";
export { bindExpertPluginEnabled, ExpertStore, start as startExpert, load as loadExpert, listRuns as listExpertRuns, resolveTarget as resolveExpertTarget, resume as resumeExpert, stop as stopExpert, formatStatus as formatExpertStatus, handleSlash as handleExpertSlash, dispatchExpert } from "./expert.ts";
export { PHASES, PHASE_IDS, validateTask, phasePrompt, expertPlan, ACTIVE_EXPERT, TERMINAL_EXPERT } from "./expert-phases.ts";
export { workflowTools, type WorkflowToolsOptions } from "./tools.ts";
export { createWorkflowHttp, WORKFLOW_ROUTES, type WorkflowHttpOptions } from "./http.ts";

/**
 * What automation and the expert workflow may do to a run. Structural on
 * purpose: those plugins declare it locally instead of importing this one.
 */
export interface WorkflowBridge {
  create(plan: unknown, root: string, reuse?: unknown, ownerSession?: unknown): Row;
  launch(wid: string, approved?: boolean, allowReal?: boolean, expectedDigest?: string | null): Row;
  control(wid: string, action: unknown, concurrency?: unknown): Row;
  load(wid: string): Row;
  list(): Row[];
}

/** The bridge over one state directory, for `ctx.provide("workflows.store", …)`. */
export function workflowBridge(stateDir: string, options: { launcher?: WorkerLauncher } = {}): WorkflowBridge {
  const store = new WorkflowStore(stateDir, options);
  return {
    create: (plan, root, reuse, ownerSession) => store.create(plan, root, reuse, ownerSession),
    launch: (wid, approved, allowReal, expectedDigest) => store.launch(wid, approved, allowReal, expectedDigest),
    control: (wid, action, concurrency) => store.control(wid, action, concurrency),
    load: (wid) => store.load(wid),
    list: () => store.list(),
  };
}

/** How the host observes a run it started: cancel comes from the record, owner loss from the host. */
export function recordControl(store: WorkflowStore, wid: string, ownerGone: () => boolean = () => false): RunControl {
  return {
    control: (): string => {
      const value = store.load(wid).control;
      return typeof value === "string" ? value : "run";
    },
    ownerGone,
  };
}

/**
 * The default launcher: drive the run in this process. A detached worker would
 * need a second entry point, which belongs to the CLI round; the `.runner` lock
 * still makes this the single owner, so a CLI worker and this one cannot both
 * drive the same run.
 */
export function localLauncher(options: {
  execute: NodeExecutor;
  ownerGone?: () => boolean;
  enabled?: (id: string) => boolean;
}): WorkerLauncher {
  const driveOptions: DriveOptions = options.enabled === undefined ? {} : { enabled: () => options.enabled!("workflows") };
  return (store, wid) => {
    const control = recordControl(store, wid, options.ownerGone);
    void drive(store, wid, options.execute, control, driveOptions).catch(() => {
      // A crashed driver leaves the record active; `recover` is the operator's
      // way out, exactly as a lost Python worker behaves.
    });
  };
}

/** Both node kinds behind one executor: commands locally, actors through the host. */
export function nodeExecutor(host: AgentNodeHost | null): NodeExecutor {
  return async (store, record, spec, control) => {
    if (spec.kind === "agent") {
      if (host === null) return { status: "paused", error: "real model execution is not enabled" };
      return executeAgentNode(store, record, spec, control, host);
    }
    return executeCommandNode(store, record, spec, control);
  };
}

export interface WorkflowsOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** The session a tool call runs in; null outside a run. */
  session(): Row | null;
  /** The session's real-model permission. */
  allowReal(): boolean;
  /** Host ceiling: the web real-provider switch. */
  allowRealHost(): boolean;
  /** Append an operator answer to the actor transcript, then settle the node. */
  answerActor(wid: string, nodeId: string, answer: string): Promise<Row>;
  /** Runs actor nodes; null when the host cannot execute models. */
  agent?: AgentNodeHost | null;
  /** Overrides the in-process launcher (the CLI round supplies a detached one). */
  launcher?: WorkerLauncher;
  dynamic?: DynamicWorkflowService;
}

export function createWorkflows(options: WorkflowsOptions): BundledPlugin {
  const store = new WorkflowStore(options.stateDir, options.launcher === undefined ? {} : { launcher: options.launcher });
  const library = new SavedWorkflowLibrary(options.stateDir);
  const tools = workflowTools({
    store: () => store,
    library: () => library,
    stateDir: options.stateDir,
    session: options.session,
    allowReal: options.allowReal,
    allowRealHost: options.allowRealHost,
    answerActor: options.answerActor,
    dynamic: options.dynamic,
  } satisfies WorkflowToolsOptions);
  return {
    manifest,
    plugin: definePlugin({
      name: "workflows",
      inject: { optional: ["workflows.agent"] },
      apply(ctx) {
        try { ctx.provide("workflows.store", workflowBridge(options.stateDir, options.launcher === undefined ? {} : { launcher: options.launcher })); } catch { /* the host wired its own bridge */ }
        for (const tool of tools) ctx.tool(tool);
      },
    }),
  };
}

/** The bundled entry: no session and no model, so only operator/CLI runs work. */
export const workflows: BundledPlugin = {
  manifest,
  plugin: definePlugin({ name: "workflows", inject: { optional: ["workflows.agent"] }, apply(ctx) {
    try { ctx.provide("workflows.store", workflowBridge(".")); } catch { /* the host wired its own bridge */ }
    for (const tool of workflowTools({ store: () => new WorkflowStore("."), library: () => new SavedWorkflowLibrary("."), stateDir: ".", session: () => null, allowReal: () => false, allowRealHost: () => false, answerActor: async () => { throw new Error("no actor host"); } })) ctx.tool(tool);
  } }),
};
