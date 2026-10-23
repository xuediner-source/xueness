/**
 * Round-7 owners: durable workflows and automation (Python
 * `bundled_plugins/workflows` and `bundled_plugins/automation`).
 *
 * `/api/workflows` (with its `dwf` and `expert` sub-trees), `/api/automations`
 * and `/api/automation/offpeak` are answered here, behind Python's route-owner
 * gate. A launched run is driven by a detached TypeScript worker
 * (`workflow-worker.ts`), as Python's `launch` starts `xueness.workflow_worker`.
 * A desktop host keeps its workers in its own process group, hands them its pid
 * so they cancel when it is gone, and stops them on close
 * (`desktop_lifecycle.shutdown`). The cron and off-peak scheduler runs here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindPluginEnabled as bindAutomationProbe, createAutomationHttp, Scheduler } from "@xueness/plugin-automation";
import { bindExpertPluginEnabled, bindPluginEnabled as bindDynamicProbe, createWorkflowHttp, dispatchDynamicRuns, dispatchExpert, setWorkerLauncher, validatePlan, workflowBridge, WorkflowStore, type Row, type WorkerLauncher } from "@xueness/plugin-workflows";
import type { SessionStore } from "@xueness/sessions";
import { effectivePlugins } from "./plugin-state.ts";
import { answerWorkflowActor } from "./workflow-actors.ts";

type Reply = [number, unknown, string?] | null;

export interface Round7Options {
  projectRoot: string;
  projectDir: string;
  stateDir: string;
  webRuns: string;
  enabled(id: string): boolean;
  store: SessionStore;
  /** `workspaces_api.allowed_roots`: the operator-declared and remembered roots. */
  allowedRoots(): readonly string[];
  allowReal: boolean;
  env: NodeJS.ProcessEnv;
  /** False for a one-shot CLI host: the serving process owns the cron and off-peak scheduler. */
  scheduler?: boolean;
}

const here = fileURLToPath(import.meta.url);
/** The worker entry beside this module: `.ts` from source, `.js` once built. */
export const WORKER_SCRIPT = join(dirname(here), "workflow-worker" + (here.endsWith(".js") ? ".js" : ".ts"));

const POSIX = process.platform !== "win32";
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const live = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;
const exited = (child: ChildProcess, ms: number): Promise<void> => !live(child) ? Promise.resolve() : new Promise((done) => {
  const timer = setTimeout(done, Math.max(0, ms));
  child.once("exit", () => { clearTimeout(timer); done(); });
});

function alive(pid: number, group: boolean): boolean {
  try { process.kill(group ? -pid : pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** `process_runtime.terminate_pid`: SIGTERM, then SIGKILL after the grace; Windows ends the tree. */
async function terminatePid(pid: number, group: boolean, graceMs: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid >= 2 ** 32 || pid === process.pid) return;
  const signal = (name: NodeJS.Signals): void => {
    if (!POSIX) { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); return; }
    try { process.kill(group ? -pid : pid, name); } catch { /* already gone */ }
  };
  signal("SIGTERM");
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline) { if (!POSIX || !alive(pid, group)) return; await sleep(50); }
  if (alive(pid, group)) signal("SIGKILL");
}

/** `_stop_recorded_commands`: command sessions this host's worker still has marked running. */
async function stopRecordedCommands(store: WorkflowStore, wid: string): Promise<void> {
  let nodes: unknown;
  try { nodes = store.load(wid).nodes; } catch { return; }
  if (nodes === null || typeof nodes !== "object" || Array.isArray(nodes)) return;
  for (const node of Object.values(nodes as Record<string, Row>)) {
    if (node === null || typeof node !== "object" || node.status !== "running") continue;
    const pid = Number(node.pid);
    if (Number.isInteger(pid)) await terminatePid(pid, POSIX, 500);
  }
}

/** The detached worker launcher, plus `desktop_lifecycle` for the workers a desktop host owns. */
export function workerLauncher(options: { projectRoot: string; env: NodeJS.ProcessEnv }) {
  const desktop = !!options.env.XUENESS_DESKTOP_HOST;
  const workers = new Map<ChildProcess, { store: WorkflowStore; wid: string }>();
  const launch: WorkerLauncher = (store, wid) => {
    // Popen raises at once when the program is missing; a spawn error is asynchronous.
    if (!existsSync(WORKER_SCRIPT)) throw Object.assign(new Error(`No such file or directory: '${WORKER_SCRIPT}'`), { code: "ENOENT", errno: 2, syscall: "spawn" });
    const env = desktop ? { ...options.env, XUENESS_DESKTOP_OWNER_PID: String(process.pid) } : { ...options.env };
    const child = spawn(process.execPath, [WORKER_SCRIPT, store.state, wid], { cwd: options.projectRoot, env, stdio: "ignore", windowsHide: true, detached: !desktop });
    child.once("error", () => { try { store.update(wid, (record) => { record.status = "failed"; }); } catch { /* the record is gone */ } });
    if (!desktop) { child.unref(); return; }
    workers.set(child, { store, wid });
    child.once("exit", () => workers.delete(child));
  };
  return {
    launch,
    /** `desktop_lifecycle.shutdown`: cancel, wait up to two seconds, then stop what is left. */
    async shutdown(): Promise<void> {
      const owned = [...workers];
      for (const [child, { store, wid }] of owned) if (live(child)) { try { store.control(wid, "cancel"); } catch { /* not active */ } }
      const deadline = performance.now() + 2000;
      for (const [child, { store, wid }] of owned) {
        await exited(child, deadline - performance.now());
        // Command pids are read before the worker is killed so a SIGKILL cannot orphan them.
        await stopRecordedCommands(store, wid);
        if (live(child) && child.pid !== undefined) await terminatePid(child.pid, false, 1000);
      }
    },
  };
}

let activeLauncher: WorkerLauncher | null = null;
const PLUGIN_OF: readonly [string, (parts: readonly string[]) => boolean][] = [
  ["workflows", (parts) => parts[1] === "workflows"],
  ["automation", (parts) => parts[1] === "automations" || (parts[1] === "automation" && parts[2] === "offpeak")],
];

export function createRound7(o: Round7Options) {
  const { stateDir, enabled } = o;
  const own = resolve(stateDir);
  // `is_enabled(state_dir, id)` for the plugin modules' own gates, on whichever state they were given.
  const probe = (state: string, id: string): boolean => (resolve(state) === own ? enabled : effectivePlugins(o.projectRoot, state))(id);
  bindDynamicProbe(probe); bindExpertPluginEnabled(probe); bindAutomationProbe(probe);
  const workers = workerLauncher({ projectRoot: o.projectRoot, env: o.env });
  setWorkerLauncher(workers.launch); activeLauncher = workers.launch;
  const store = (): WorkflowStore => new WorkflowStore(stateDir, { launcher: workers.launch });
  // The web fence: web-runs first (the base of a relative root), the project, then the declared roots.
  const roots = (): string[] => [o.webRuns, o.projectDir, ...o.allowedRoots()];
  const workflowsHttp = createWorkflowHttp({
    stateDir, store, sessionStore: o.store, allowedRoots: roots, allowReal: () => o.allowReal, allowRealHost: () => o.allowReal,
    answerActor: (wid, nodeId, answer) => answerWorkflowActor(store(), wid, nodeId, answer),
    expert: (request) => dispatchExpert(request.method as string, request.parts as string[], request.query as Row, request.data as Row,
      { stateDir, webRuns: o.webRuns, projectDir: o.projectDir, allowedRoots: () => o.allowedRoots(), allowReal: o.allowReal }),
    dynamicRuns: (method, parts, query, data) => dispatchDynamicRuns(method, parts, query, data, { stateDir, sessions: o.store, allowedRoots: roots, allowReal: o.allowReal }),
  });
  const bridge = { ...workflowBridge(stateDir, { launcher: workers.launch }), validatePlan };
  const automationHttp = createAutomationHttp({ stateDir, allowRealHost: o.allowReal, enabled: () => enabled("automation"), bridge });
  const scheduler = o.scheduler === false ? null : new Scheduler(stateDir, { allowReal: o.allowReal, bridge });
  const owns = (method: string, parts: readonly string[]): boolean => workflowsHttp.owns(method, parts) || automationHttp.owns(method, parts);
  return {
    routes: [...workflowsHttp.routes, ...automationHttp.routes],
    owns,
    /** Plans carry Python ints and floats (`concurrency`, `timeout`, cron times). */
    lossless: (method: string, parts: readonly string[]): boolean => method !== "GET" && owns(method, parts),
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown): Promise<Reply> {
      // `route_owner`: a disabled owner (or one missing a dependency) answers 403 before its handler.
      const owner = PLUGIN_OF.find(([, match]) => parts[0] === "api" && match(parts))?.[0];
      if (owner && !enabled(owner)) return [403, { error: "plugin disabled or dependency unavailable: " + owner, plugin: owner, code: "plugin_disabled" }];
      if (workflowsHttp.owns(method, parts)) return workflowsHttp.dispatch(method, parts, query, data as Row);
      if (automationHttp.owns(method, parts)) return automationHttp.dispatch(method, parts, query, data as Row);
      return null;
    },
    /** The launcher for workflow stores built outside this module (agent tools). */
    launcher: workers.launch,
    async close(): Promise<void> {
      scheduler?.close();
      if (activeLauncher === workers.launch) { setWorkerLauncher(null); activeLauncher = null; }
      await workers.shutdown();
    },
  };
}
