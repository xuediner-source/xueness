/**
 * `automation` and `automation offpeak` (Python automation `execute_cli` and
 * `off_peak.cli`): schedules and the idle-window queue in the state
 * directory. Launches go through the workflow bridge, so each run is a
 * detached workflow worker that outlives this command.
 */
import { readFileSync } from "node:fs";
import { pyJsonLoadsBytes } from "@xueness/contracts";
import { Automations, bindPluginEnabled, OffPeakQueue, Scheduler } from "@xueness/plugin-automation";
import { setWorkerLauncher, validatePlan, workflowBridge } from "@xueness/plugin-workflows";
import { workerLauncher } from "../round7-http.ts";
import type { Parser } from "./argparse.ts";
import { type Cli, dumps, err, osErrorText, out } from "./host.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;
const MAX_DOCUMENT_BYTES = 100000, DEFAULT_DEADLINE = 3600;
const APPROVE_REQUIRED = "--approve-execution is required after reviewing the immutable plan";

export function register(sub: Sub): void {
  const actions = sub.add("automation", "manage local cron schedules").subparsers("automation_action", true);
  actions.add("list");
  actions.add("create").add("file");
  actions.add("run").add("id").add("--allow-real-provider", { action: "store_true" });
  actions.add("approve").add("id").add("--allow-real-provider", { action: "store_true" }).add("--approve-execution", { action: "store_true" });
  actions.add("delete").add("id");
  actions.add("daemon").add("--allow-real-provider", { action: "store_true" });
  const offpeak = actions.add("offpeak", "queue non-urgent work for the local idle window").subparsers("offpeak_action", true);
  offpeak.add("list");
  const add = offpeak.add("add");
  add.add("prompt").add("--root", { default: ".", help: "workspace the deferred run works in" }).add("--name", { default: null }).add("--model", { default: null });
  add.add("--deadline", { type: "int", default: DEFAULT_DEADLINE }).add("--only-when-idle", { action: "store_true" });
  add.add("--approve-execution", { action: "store_true", help: "approve the immutable plan for unattended off-peak execution" }).add("--allow-real-provider", { action: "store_true" });
  for (const name of ["cancel", "run-now"]) offpeak.add(name).add("id");
  offpeak.add("approve").add("id").add("--approve-execution", { action: "store_true" }).add("--allow-real-provider", { action: "store_true" });
  offpeak.add("settings").add("--start", { default: null }).add("--end", { default: null }).add("--timezone", { default: null });
}

function offPeak(cli: Cli, bridge: Row): unknown {
  const a = cli.args, queue = new OffPeakQueue(cli.state, { allowRealHost: Boolean(a.allow_real_provider), bridge: bridge as never });
  switch (a.offpeak_action) {
    case "list": return queue.overview();
    case "add": return { task: queue.add({ prompt: a.prompt, name: a.name, root: a.root, model: a.model, deadlineSeconds: a.deadline, onlyWhenIdle: Boolean(a.only_when_idle), confirm: Boolean(a.approve_execution), allowReal: Boolean(a.allow_real_provider) }) };
    case "cancel": return { cancelled: queue.cancel(String(a.id)).id };
    case "run-now": return { result: queue.runNow(String(a.id)) };
    case "approve":
      if (!a.approve_execution) throw new Error(APPROVE_REQUIRED);
      return { task: queue.approve(String(a.id), { allowReal: Boolean(a.allow_real_provider), confirmed: true }) };
    case "settings":
      if ([a.start, a.end, a.timezone].every((value) => value == null)) return { settings: queue.settings() };
      return { settings: queue.saveSettings({ window: { start: a.start, end: a.end }, timezone: a.timezone }) };
    default: throw new Error("unknown off-peak command");
  }
}

async function run(cli: Cli, bridge: Row): Promise<unknown> {
  const a = cli.args, action = a.automation_action;
  if (action === "offpeak") return offPeak(cli, bridge);
  const store = new Automations(cli.state, { enabled: () => cli.enabled("automation"), bridge: bridge as never });
  if (action === "list") return { automations: store.list() };
  if (action === "create") {
    let raw: Buffer;
    try { raw = readFileSync(String(a.file)); } catch (error) { throw new Error(osErrorText(error, String(a.file))); }
    if (raw.length > MAX_DOCUMENT_BYTES) throw new Error("automation document too large");
    return store.save(pyJsonLoadsBytes(raw, { lossless: true }));
  }
  // Python's `next(...)` over the rows raises a bare StopIteration (`ERROR: `).
  const known = (id: string): string => { if (!store.list().some((row) => row.id === id)) throw new Error(""); return id; };
  if (action === "delete") return store.delete(String(a.id));
  if (action === "approve") {
    if (!a.approve_execution) throw new Error(APPROVE_REQUIRED);
    return store.approve(known(String(a.id)), Boolean(a.allow_real_provider));
  }
  if (action === "run") return store.run(known(String(a.id)), { allowRealHost: Boolean(a.allow_real_provider), bridge: bridge as never });
  throw new Error("unknown automation command");
}

export async function execute(cli: Cli): Promise<number | null> {
  if (cli.args.cmd !== "automation") return null;
  const workers = workerLauncher({ projectRoot: cli.projectRoot, env: process.env });
  setWorkerLauncher(workers.launch);
  bindPluginEnabled((_state, id) => cli.enabled(id));
  const bridge = { ...workflowBridge(cli.state, { launcher: workers.launch }), validatePlan };
  try {
    if (!cli.enabled("automation")) throw new Error("plugin disabled or dependency unavailable: automation");
    if (cli.args.automation_action === "daemon") {
      const service = new Scheduler(cli.state, { allowReal: Boolean(cli.args.allow_real_provider), bridge: bridge as never });
      await new Promise<void>((done) => { process.once("SIGINT", () => done()); });
      service.close();
      return 0;
    }
    out(dumps(await run(cli, bridge), 2));
    return 0;
  } catch (error) {
    err("ERROR: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    setWorkerLauncher(null);
    bindPluginEnabled(null);
  }
}
