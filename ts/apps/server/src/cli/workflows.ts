/**
 * `workflow`, `jobs`, `workflows` and `expert` (Python `workflow_cli`,
 * `saved_library.execute_cli`, `dynamic_runs.execute_cli`,
 * `expert.execute_cli`): records live in the state directory and each launch
 * starts a detached worker, so a run outlives this command.
 */
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { pyJsonLoads } from "@xueness/contracts";
import { ACTIVE, compileWorkflowScript, DynamicRunError, invoke, latestRunPlan, loadExpert, resolveExpertTarget, resumeExpert, SavedWorkflowLibrary, setWorkerLauncher, sourcePlan, startExpert, stopExpert, WorkflowStore } from "@xueness/plugin-workflows";
import { workerLauncher } from "../round7-http.ts";
import type { Parser } from "./argparse.ts";
import { type Cli, dumps, err, out, pyPath } from "./host.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function register(sub: Sub): void {
  const group = sub.add("workflow", "durable workflows: create, start/resume, pause, cancel, reuse").subparsers("action", true);
  group.add("create").add("file").add("--root", { required: true }).add("--reuse", { help: "reuse unchanged completed nodes from a settled run" });
  group.add("list");
  const dwf = group.add("dwf", "one session's dynamic workflow runs: list, cancel, resume");
  dwf.add("dwf_action", { nargs: "?", default: "list", choices: ["list", "cancel", "resume"] }).add("run", { nargs: "?", help: "run id for cancel/resume" });
  dwf.add("--session", { required: true, help: "owning session id" }).add("--approve", { action: "store_true", help: "approve re-running the stored command plan" }).add("--allow-real", { action: "store_true", help: "allow model calls by agent nodes" });
  for (const action of ["show", "start", "resume", "pause", "cancel", "recover", "concurrency", "logs", "wait"]) {
    const parser = group.add(action).add("id");
    if (action === "start" || action === "resume") parser.add("--approve", { action: "store_true", help: "approve the exact stored command plan" }).add("--allow-real", { action: "store_true", help: "allow model calls by agent nodes" });
    if (action === "concurrency") parser.add("limit", { type: "int" });
    if (action === "logs") parser.add("node");
    if (action === "wait") parser.add("--timeout", { type: "float", default: 60 });
  }
  const jobs = sub.add("jobs", "background commands using the workflow runner").subparsers("action", true);
  jobs.add("list");
  jobs.add("start").add("--root", { required: true }).add("--timeout", { type: "float", default: 300 }).add("--approve", { action: "store_true" }).add("argv", { nargs: "+", help: "literal argv (use -- before command flags)" });
  for (const action of ["show", "cancel", "logs", "wait"]) {
    const parser = jobs.add(action).add("id");
    if (action === "wait") parser.add("--timeout", { type: "float", default: 60 });
  }
  const expert = sub.add("expert", "durable expert workflow: research -> plan -> implement -> review");
  expert.add("task", { nargs: "*", help: "task text, or status|resume|stop" }).add("--session", { help: "bind a new run to / select runs of a session id" });
  expert.add("--run", { help: "operate on an explicit expert run id" }).add("--answer", { help: "resume: answer a waiting implement-phase actor" });
  expert.add("--root", { help: "workspace for a new run (default: current directory)" });
  const saved = sub.add("workflows", "named saved workflow templates: save, list, run").subparsers("action", true);
  const save = saved.add("save", "save a plan/DSL file or an existing run as a named template");
  save.add("name").add("file", { nargs: "?", help: "plan JSON (.json) or DSL script (.py)" }).add("--root", { required: true, help: "workspace the plan is validated against" });
  save.add("--description", { help: "human-readable template description" }).add("--overwrite", { action: "store_true", help: "replace an existing template of this name" });
  save.add("--from-run", { dest: "from_run", help: "save the plan of this workflow run id" }).add("--latest", { action: "store_true", help: "save the most recent run in the workspace" });
  saved.add("list", "list saved templates (JSON)");
  saved.add("run", "instantiate a saved template in a workspace and start it").add("name").add("--root", { required: true })
    .add("--approve", { action: "store_true", help: "approve the exact stored command plan" }).add("--allow-real", { action: "store_true", help: "allow model calls by agent nodes" });
}

/** A plan file: `.py` compiles through the workflow DSL, anything else is JSON. */
function readPlan(file: string, root: string): Row {
  const source = readFileSync(file, "utf8");
  const suffix = extname(basename(file));
  return suffix.toLowerCase() === ".py" ? compileWorkflowScript(source, root, basename(file, suffix)) : pyJsonLoads(source, { lossless: true }) as Row;
}

async function run(cli: Cli, store: WorkflowStore): Promise<unknown> {
  const a = cli.args, state = cli.state;
  if (a.cmd === "workflows") {
    const library = new SavedWorkflowLibrary(state);
    if (a.action === "list") return { ok: true, saved: library.list() };
    const root = resolve(String(a.root));
    if (a.action === "save") {
      if ([a.file != null, Boolean(a.from_run), Boolean(a.latest)].filter(Boolean).length !== 1) throw new Error("provide exactly one of a plan/script file, --from-run or --latest");
      const chosen = a.file != null ? { plan: readPlan(String(a.file), root), source: { kind: extname(String(a.file)).toLowerCase() === ".py" ? "script" : "plan" } }
        : a.from_run ? sourcePlan(state, a.from_run, root) : latestRunPlan(state, root);
      return { ok: true, saved: library.save(chosen.plan as Row, a.name, root, { description: a.description, overwrite: Boolean(a.overwrite), source: chosen.source as Row }) };
    }
    const record = library.load(a.name);
    const created = store.create(record.plan, root);
    return store.launch(created.id, Boolean(a.approve), Boolean(a.allow_real));
  }
  if (a.cmd === "expert") {
    let tokens: string[] = [...(a.task ?? [])], action = "start";
    if (tokens.length && ["status", "resume", "stop"].includes(tokens[0]!)) { action = tokens[0]!; tokens = tokens.slice(1); }
    else if (tokens[0] === "start") tokens = tokens.slice(1);
    if (action === "start") {
      const text = tokens.join(" ").trim();
      if (!text) throw new Error("expert start needs a task description (xueness expert start <task> / status / resume / stop)");
      return startExpert(state, text, a.root ? pyPath(a.root) : process.cwd(), { sessionId: a.session ?? null, allowReal: true });
    }
    const target = resolveExpertTarget(state, { sessionId: a.session ?? null, runId: a.run ?? null });
    if (action === "status") return loadExpert(state, String(target.id));
    if (action === "resume") return resumeExpert(state, String(target.id), { answer: a.answer ?? null, allowReal: true });
    return stopExpert(state, String(target.id));
  }
  if (a.action === "dwf") return invoke(state, await cli.store(), a.dwf_action, a.session, a.run ?? null, { approved: Boolean(a.approve), allowReal: Boolean(a.allow_real) });
  const action = a.action;
  if (action === "list") return { workflows: store.list() };
  if (a.cmd === "jobs" && action === "start") {
    if (!a.approve) throw new Error("jobs start requires --approve for the specified argv");
    const record = store.create({ name: a.argv[0], nodes: [{ id: "command", argv: a.argv, timeout: a.timeout }] }, pyPath(a.root));
    return store.launch(record.id, true);
  }
  if (action === "create") return store.create(readPlan(String(a.file), pyPath(a.root)), pyPath(a.root), a.reuse ?? undefined);
  if (action === "start" || action === "resume") return store.launch(a.id, Boolean(a.approve), Boolean(a.allow_real));
  if (action === "show") return store.load(a.id);
  if (action === "logs") return store.log(a.id, a.cmd === "jobs" ? "command" : a.node);
  if (action === "wait") {
    if (!(a.timeout > 0 && a.timeout <= 3600)) throw new Error("wait timeout must be 0..3600");
    const end = performance.now() + a.timeout * 1000;
    for (;;) {
      const record = store.load(a.id);
      if (!ACTIVE.has(record.status) || performance.now() >= end) return record;
      await sleep(100);
    }
  }
  return store.control(a.id, action, a.limit ?? undefined);
}

export async function execute(cli: Cli): Promise<number | null> {
  if (!["workflow", "jobs", "workflows", "expert"].includes(cli.args.cmd)) return null;
  const workers = workerLauncher({ projectRoot: cli.projectRoot, env: process.env });
  setWorkerLauncher(workers.launch);
  try {
    out(dumps(await run(cli, new WorkflowStore(cli.state, { launcher: workers.launch })), 2));
    return 0;
  } catch (error) {
    if (error instanceof DynamicRunError) { out(dumps(error.payload(), 2)); return 1; }
    err("ERROR: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  } finally { setWorkerLauncher(null); }
}
