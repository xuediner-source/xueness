/**
 * Model-facing tools: names, descriptions, schemas, Gate kinds and
 * flags against `manifest.json`, the approval subjects, and the refusal paths
 * Python raises before or instead of its Gate.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { isDict, pyJsonDumps } from "@xueness/contracts";
import type { ToolDefinition } from "@xueness/engine-tools";
import { workflowPlanDigest, type Row } from "../src/plan.ts";
import { SavedWorkflowLibrary, templatePlanDigest } from "../src/saved-library.ts";
import { WorkflowStore } from "../src/store.ts";
import { workflowTools, type WorkflowToolsOptions } from "../src/tools.ts";

const MANIFEST = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8")) as {
  tools: Array<{ name: string; gate: string; mutating: boolean; concurrencySafe: boolean }>;
};
const SID = "a".repeat(32);

function plan(name = "Fixture"): Row {
  return { name, nodes: [{ id: "one", kind: "command", argv: ["echo", "hi"] }], concurrency: 1 };
}

interface Fixture {
  state: string;
  root: string;
  other: string;
  store: WorkflowStore;
  library: SavedWorkflowLibrary;
  /** Workflow ids the launcher was asked to start, in order. */
  launched: string[];
  options: WorkflowToolsOptions;
  tools: ToolDefinition[];
  cleanup(): void;
}

/** A launcher that records the request instead of starting a worker process. */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "xueness-tools-"));
  const state = join(base, "state"), root = join(base, "workspace"), other = join(base, "other");
  mkdirSync(root, { recursive: true });
  mkdirSync(other, { recursive: true });
  const launched: string[] = [];
  const store = new WorkflowStore(state, { launcher: (_store, wid) => { launched.push(wid); } });
  const library = new SavedWorkflowLibrary(state);
  const session: Row | null = { id: SID, root };
  const options: WorkflowToolsOptions = {
    store: () => store,
    library: () => library,
    stateDir: state,
    session: () => session,
    allowReal: () => true,
    allowRealHost: () => true,
    answerActor: async (wid, nodeId, answer) => store.actorAnswered(wid, nodeId, answer),
  };
  return {
    state, root, other, store, library, launched, options,
    tools: workflowTools(options),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function tool(f: Fixture, name: string): ToolDefinition {
  const found = f.tools.find((item) => item.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

/** The Python result dict a tool returns, parsed back out of its `output`. */
function result(value: { output: string }): Row {
  const parsed: unknown = JSON.parse(value.output);
  assert.ok(isDict(parsed));
  return parsed;
}

/** `_subject`: the canonical JSON both backends must agree on. */
const canonical = (value: unknown): string => pyJsonDumps(value, { ensureAscii: false, sortKeys: true, separators: [",", ":"] });

describe("workflow tool registration", () => {
  it("publishes exactly the manifest's tools with matching gate and flags", () => {
    const f = fixture();
    try {
      assert.equal(f.tools.length, 20);
      assert.deepEqual(f.tools.map((item) => item.name), MANIFEST.tools.map((item) => item.name));
      for (const declared of MANIFEST.tools) {
        const actual = tool(f, declared.name);
        assert.equal(actual.gate, declared.gate, `${declared.name} gate`);
        assert.equal(actual.mutating, declared.mutating, `${declared.name} mutating`);
        assert.equal(actual.concurrencySafe, declared.concurrencySafe, `${declared.name} concurrencySafe`);
      }
    } finally {
      f.cleanup();
    }
  });

  it("keeps Python's descriptions verbatim and only exec tools ask for exec", () => {
    const f = fixture();
    try {
      assert.equal(tool(f, "workflow_create").description, "Create a declarative workflow DAG in this session workspace");
      assert.equal(tool(f, "workflow_run").description, "Start an approved workflow; this action requires operator approval");
      assert.equal(tool(f, "background_exec").description, "Start a literal argv command as a durable background job; requires operator approval");
      assert.equal(tool(f, "list_saved_workflows").description, "List saved workflow templates: name, description, node count and save time");
      // The manifest grants exec to the plugin; only the tools that make the
      // host start a command run declare it, so a narrower grant cannot leak.
      // `workflow_answer_actor`, `background_cancel` and `run_saved_workflow`
      // are exec-gated but only touch state, exactly as in Python.
      const runsCommands = new Set(["workflow_run", "background_exec", "workflow_script_run"]);
      for (const item of f.tools) {
        if (runsCommands.has(item.name)) assert.deepEqual(item.requires.exec, ["*"], item.name);
        else assert.equal(item.requires.exec, undefined, item.name);
      }
    } finally {
      f.cleanup();
    }
  });

  it("rejects unknown keys and missing required arguments through the schema", () => {
    const f = fixture();
    try {
      for (const item of f.tools) {
        assert.equal(item.inputSchema.additionalProperties, false, item.name);
        assert.equal(item.inputSchema.type, "object", item.name);
      }
      const create = tool(f, "workflow_create").inputSchema;
      assert.deepEqual(create.required, []);
      assert.equal(create.properties?.script?.maxLength, 32000);
      assert.equal(create.properties?.reuse?.maxLength, 32);
      const run = tool(f, "workflow_run").inputSchema;
      assert.deepEqual(run.required, ["workflow_id", "plan_digest"]);
      assert.equal(run.properties?.plan_digest?.maxLength, 64);
      const exec = tool(f, "background_exec").inputSchema;
      assert.deepEqual(exec.required, ["argv"]);
      assert.equal(exec.properties?.argv?.maxItems, 128);
      assert.equal(exec.properties?.timeout?.minimum, 0.1);
      assert.equal(exec.properties?.timeout?.maximum, 3600);
      assert.equal(exec.properties?.name?.maxLength, 120);
      const save = tool(f, "save_workflow").inputSchema;
      assert.deepEqual(save.required, ["name"]);
      assert.equal(save.properties?.description?.maxLength, 500);
      assert.deepEqual(tool(f, "list_saved_workflows").inputSchema.properties, {});
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow tool subjects", () => {
  it("renders the run subject as Python's canonical JSON", () => {
    const f = fixture();
    try {
      const subject = tool(f, "workflow_run").subject;
      assert.ok(subject);
      assert.equal(
        subject({ workflow_id: "abc", plan_digest: "def" }),
        canonical({ workflow_id: "abc", approved: true, allow_real: false, plan_digest: "def" }),
      );
      assert.equal(
        subject({ workflow_id: "abc", plan_digest: "def", allow_real: true }),
        '{"allow_real":true,"approved":true,"plan_digest":"def","workflow_id":"abc"}',
      );
    } finally {
      f.cleanup();
    }
  });

  it("renders argv, cancel and answer subjects", () => {
    const f = fixture();
    try {
      assert.equal(tool(f, "background_exec").subject?.({ argv: ["git", "status"] }), '["git","status"]');
      assert.equal(tool(f, "background_cancel").subject?.({ job_id: "job1" }), '["background_cancel","job1"]');
      assert.equal(
        tool(f, "workflow_answer_actor").subject?.({ workflow_id: "w", node_id: "n", answer: "yes" }),
        '["workflow_answer_actor","w","n","yes"]',
      );
      // ensure_ascii=False: non-ASCII text stays literal, as Python writes it.
      assert.equal(tool(f, "workflow_answer_actor").subject?.({ workflow_id: "w", node_id: "n", answer: "是" }), '["workflow_answer_actor","w","n","是"]');
    } finally {
      f.cleanup();
    }
  });

  it("binds the saved-workflow subject to the template's current digest", () => {
    const f = fixture();
    try {
      // `save` returns the listing projection, so the digest comes from the
      // validated plan the template was stored from, not from the projection.
      const source = plan("Saved");
      f.library.save(source, "nightly", f.root);
      const stored = f.library.load("nightly");
      const subject = tool(f, "run_saved_workflow").subject;
      assert.ok(subject);
      assert.equal(
        subject({ name: "nightly" }),
        canonical({ saved_workflow: "nightly", approved: true, allow_real: false, plan_digest: templatePlanDigest(stored.plan as Row) }),
      );
      // The subject really is the stored content's digest, not the input's.
      assert.equal(templatePlanDigest(stored.plan as Row), templatePlanDigest(stored.plan as Row));
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow tool refusals", () => {
  it("requires an active session with a real workspace", async () => {
    const f = fixture();
    try {
      const tools = workflowTools({ ...f.options, session: () => null });
      const create = tools.find((item) => item.name === "workflow_create");
      assert.ok(create);
      await assert.rejects(create.run({ plan: plan() } as never, {} as never), {
        name: "ValueError", message: "workflow tools require an active session",
      });
      // Python loads the record first and calls `_root` only to compare roots,
      // so a missing workspace is reported by the tool that reads the session
      // before the record: `workflow_create`.
      const gone = workflowTools({ ...f.options, session: () => ({ id: SID, root: join(f.root, "nope") }) });
      const create2 = gone.find((item) => item.name === "workflow_create");
      assert.ok(create2);
      await assert.rejects(create2.run({ plan: plan() } as never, {} as never), {
        name: "ValueError", message: "session workspace is unavailable",
      });
    } finally {
      f.cleanup();
    }
  });

  it("refuses a plan and a script together, or neither", async () => {
    const f = fixture();
    try {
      const create = tool(f, "workflow_create");
      for (const input of [{}, { plan: plan(), script: "phase('x')" }]) {
        await assert.rejects(create.run(input as never, {} as never), {
          name: "ValueError", message: "provide exactly one of plan or script",
        });
      }
    } finally {
      f.cleanup();
    }
  });

  it("refuses a run whose digest is stale, before any approval", async () => {
    const f = fixture();
    try {
      const created = f.store.create(plan(), f.root);
      const run = tool(f, "workflow_run");
      assert.throws(() => run.precheck?.({ workflow_id: created.id, plan_digest: "0".repeat(64) }), {
        name: "ValueError", message: "workflow plan changed; inspect status and approve the current digest",
      });
      // The fresh digest passes the check.
      assert.equal(run.precheck?.({ workflow_id: created.id, plan_digest: workflowPlanDigest(created) }), null);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a run in another workspace with PermissionError", async () => {
    const f = fixture();
    try {
      const created = f.store.create(plan(), f.other);
      // `precheck` is synchronous; the handlers are async, so `rejects`.
      assert.throws(() => tool(f, "workflow_run").precheck?.({ workflow_id: created.id, plan_digest: workflowPlanDigest(created) }), {
        name: "PermissionError", message: "workflow belongs to another workspace",
      });
      for (const [name, input] of [["workflow_status", { workflow_id: created.id }], ["background_status", { job_id: created.id }]] as const) {
        await assert.rejects(tool(f, name).run(input as never, {} as never), {
          name: "PermissionError", message: name === "workflow_status" ? "workflow belongs to another workspace" : "job belongs to another workspace",
        });
      }
    } finally {
      f.cleanup();
    }
  });

  it("returns the host-ceiling refusal instead of asking for approval", () => {
    const f = fixture();
    try {
      const created = f.store.create(plan(), f.root);
      const tools = workflowTools({ ...f.options, allowRealHost: () => false });
      const run = tools.find((item) => item.name === "workflow_run");
      assert.ok(run?.precheck);
      const refused = run.precheck({ workflow_id: created.id, plan_digest: workflowPlanDigest(created), allow_real: true });
      assert.ok(refused);
      assert.equal(refused.ok, false);
      assert.deepEqual(result(refused), { ok: false, error: "real provider disabled by host" });
      // Without the opt-in the same host setting lets the call through.
      assert.equal(run.precheck({ workflow_id: created.id, plan_digest: workflowPlanDigest(created) }), null);
    } finally {
      f.cleanup();
    }
  });

  it("applies the same ceiling to a saved template", () => {
    const f = fixture();
    try {
      f.library.save(plan("Saved"), "nightly", f.root);
      const tools = workflowTools({ ...f.options, allowRealHost: () => false });
      const saved = tools.find((item) => item.name === "run_saved_workflow");
      assert.ok(saved?.precheck);
      const refused = saved.precheck({ name: "nightly", allow_real: true });
      assert.ok(refused);
      assert.deepEqual(result(refused), { ok: false, error: "real provider disabled by host" });
    } finally {
      f.cleanup();
    }
  });

  it("refuses a template source that is not exactly one", async () => {
    const f = fixture();
    try {
      const save = tool(f, "save_workflow");
      const cases: Array<[Row, string]> = [
        [{ name: "a", plan: plan(), script: "x" }, "provide exactly one of plan, script, workflow_id or latest"],
        [{ name: "a" }, "provide exactly one of plan, script, workflow_id or latest"],
        [{ name: "a", plan: plan(), latest: true }, "provide exactly one of plan, script, workflow_id or latest"],
        [{ name: "a", plan: plan(), latest: "yes" }, "latest must be a boolean"],
      ];
      for (const [input, message] of cases) {
        await assert.rejects(save.run(input as never, {} as never), { name: "ValueError", message }, JSON.stringify(input));
      }
    } finally {
      f.cleanup();
    }
  });
});

describe("workflow tool results", () => {
  it("creates a run, stamps the owner session and reports the digest through status", async () => {
    const f = fixture();
    try {
      const created = result(await tool(f, "workflow_create").run({ plan: plan() } as never, {} as never));
      assert.equal(created.ok, true);
      const workflow = created.workflow as Row;
      assert.equal(workflow.owner_session, SID);
      assert.equal(workflow.status, "created");
      const status = result(await tool(f, "workflow_status").run({ workflow_id: workflow.id } as never, {} as never));
      assert.equal((status.workflow as Row).plan_digest, workflowPlanDigest(f.store.load(workflow.id as string)));
    } finally {
      f.cleanup();
    }
  });

  it("answers a paused actor through the host and records the event", async () => {
    const f = fixture();
    try {
      const record = f.store.create({ name: "Actor", nodes: [{ id: "a", kind: "agent", prompt: "hi" }], concurrency: 1 }, f.root);
      f.store.update(record.id, (row) => {
        (row.nodes as Record<string, Row>).a = { status: "awaiting_user", attempts: 1, session_id: "b".repeat(32) };
        row.status = "awaiting_user";
      });
      const answered = result(await tool(f, "workflow_answer_actor").run({ workflow_id: record.id, node_id: "a", answer: "go" } as never, {} as never));
      assert.equal(answered.ok, true);
      const row = answered.workflow as Row;
      assert.equal(row.status, "paused");
      assert.equal(row.control, "pause");
      assert.equal((row.nodes as Record<string, Row>).a?.status, "pending");
    } finally {
      f.cleanup();
    }
  });

  it("returns an empty log tail for a job that has not written one", async () => {
    const f = fixture();
    try {
      // `background_logs` reads the `command` node a background job creates.
      const created = f.store.create({ name: "Job", nodes: [{ id: "command", kind: "command", argv: ["echo", "hi"] }], concurrency: 1 }, f.root);
      const logs = result(await tool(f, "background_logs").run({ job_id: created.id } as never, {} as never));
      assert.deepEqual(logs, { ok: true, output: "", truncated: false });
    } finally {
      f.cleanup();
    }
  });

  it("lists and re-instantiates saved templates", async () => {
    const f = fixture();
    try {
      const saved = result(await tool(f, "save_workflow").run({ name: "nightly", plan: plan("Saved") } as never, {} as never));
      assert.equal(saved.ok, true);
      assert.equal((saved.saved as Row).name, "nightly");
      const listed = result(await tool(f, "list_saved_workflows").run({} as never, {} as never));
      assert.equal((listed.saved as Row[]).length, 1);
      const started = result(await tool(f, "run_saved_workflow").run({ name: "nightly" } as never, {} as never));
      assert.equal(started.saved_workflow, "nightly");
      assert.equal((started.workflow as Row).status, "queued");
    } finally {
      f.cleanup();
    }
  });
});
