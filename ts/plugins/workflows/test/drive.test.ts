import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps, pySlice } from "@xueness/contracts";
import { drive, settledStatus, type NodeExecutor, type RunControl } from "../src/drive.ts";
import { executeAgentNode, type AgentNodeHost } from "../src/execute-agent.ts";
import { workspaceFingerprint, type Row } from "../src/plan.ts";
import { WorkflowStore } from "../src/store.ts";

const tick = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const OWNER = "a".repeat(32);
const SID = "b".repeat(32);

interface Fixture { root: string; state: string; store: WorkflowStore; close(): void }

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "xue-wf-drive-"));
  const root = join(base, "workspace"), state = join(base, "state");
  mkdirSync(root);
  mkdirSync(state);
  const store = new WorkflowStore(state);
  return { root, state, store, close() { rmSync(base, { recursive: true, force: true }); } };
}

const control = (overrides: Partial<RunControl> = {}): RunControl => ({ control: () => "run", ownerGone: () => false, ...overrides });
const command = (id: string, needs: string[] = []): Row => ({ id, kind: "command", argv: ["echo", id], needs });

/** A run in the `queued` state `drive` requires, without launching a worker. */
function queued(f: Fixture, plan: Row, owner?: string): Row {
  const created = f.store.create(plan, f.root, undefined, owner);
  return f.store.update(created.id, (row) => { row.status = "queued"; });
}

const nodes = (record: Row): Record<string, Row> => record.nodes as Record<string, Row>;
const eventTypes = (record: Row): string[] => (record.events as Row[]).map((event) => String(event.type));

describe("workflow drive", () => {
  it("runs a two-node chain in dependency order and settles completed", async () => {
    const f = fixture();
    try {
      const order: string[] = [];
      const execute: NodeExecutor = async (_store, _record, spec) => {
        order.push(String(spec.id));
        await tick(5);
        return { status: "completed" };
      };
      const record = queued(f, { name: "chain", nodes: [command("a"), command("b", ["a"])], concurrency: 2 });
      await drive(f.store, String(record.id), execute, control());
      const settled = f.store.load(record.id);
      assert.deepEqual(order, ["a", "b"]);
      assert.equal(settled.status, "completed");
      assert.equal(nodes(settled).a!.status, "completed");
      assert.equal(nodes(settled).b!.status, "completed");
      assert.equal(nodes(settled).a!.attempts, 1);
      assert.ok(typeof nodes(settled).a!.ended_at === "number");
      const types = eventTypes(settled);
      assert.equal(types.filter((type) => type === "node_started").length, 2);
      assert.equal(types.filter((type) => type === "node_finished").length, 2);
      assert.equal(types.at(-1), "settled");
    } finally { f.close(); }
  });

  it("serialises independent nodes at concurrency 1", async () => {
    const f = fixture();
    try {
      let active = 0, peak = 0;
      const execute: NodeExecutor = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(20);
        active -= 1;
        return { status: "completed" };
      };
      const record = queued(f, { name: "serial", nodes: [command("a"), command("b")], concurrency: 1 });
      await drive(f.store, String(record.id), execute, control());
      const settled = f.store.load(record.id);
      assert.equal(peak, 1);
      assert.equal(settled.status, "completed");
      assert.equal(nodes(settled).b!.status, "completed");
    } finally { f.close(); }
  });

  it("settles cancelled when control flips to cancel mid-run", async () => {
    const f = fixture();
    try {
      const execute: NodeExecutor = async (store, record) => {
        store.control(String(record.id), "cancel");
        return { status: "completed" };
      };
      const record = queued(f, { name: "cancel", nodes: [command("a")], concurrency: 1 });
      await drive(f.store, String(record.id), execute, control());
      const settled = f.store.load(record.id);
      assert.equal(settled.control, "cancel");
      assert.equal(settled.status, "cancelled");
    } finally { f.close(); }
  });

  it("settles failed and blocks the untouched pending nodes", async () => {
    const f = fixture();
    try {
      const execute: NodeExecutor = async (_store, _record, spec) => (
        spec.id === "a" ? { status: "failed", error: "boom" } : { status: "completed" }
      );
      const record = queued(f, { name: "fail", nodes: [command("a"), command("b", ["a"]), command("c", ["b"])], concurrency: 1 });
      await drive(f.store, String(record.id), execute, control());
      const settled = f.store.load(record.id);
      assert.equal(settled.status, "failed");
      assert.equal(nodes(settled).a!.status, "failed");
      assert.equal(nodes(settled).b!.status, "blocked");
      assert.equal(nodes(settled).c!.status, "blocked");
    } finally { f.close(); }
  });

  it("settles awaiting_user and leaves the pending nodes alone", async () => {
    const f = fixture();
    try {
      const execute: NodeExecutor = async (_store, _record, spec) => (
        spec.id === "a" ? { status: "awaiting_user", question: "Which one?" } : { status: "completed" }
      );
      const record = queued(f, { name: "ask", nodes: [command("a"), command("b", ["a"])], concurrency: 1 });
      await drive(f.store, String(record.id), execute, control());
      const settled = f.store.load(record.id);
      assert.equal(settled.status, "awaiting_user");
      assert.equal(nodes(settled).b!.status, "pending");
    } finally { f.close(); }
  });

  it("recomputes cache_fingerprint at settlement", async () => {
    const f = fixture();
    try {
      const record = queued(f, { name: "fingerprint", nodes: [command("a")], concurrency: 1 });
      const before = record.cache_fingerprint;
      writeFileSync(join(f.root, "added.txt"), "workspace changed after create\n");
      await drive(f.store, String(record.id), async () => ({ status: "completed" }), control());
      const settled = f.store.load(record.id);
      assert.equal(settled.cache_fingerprint, workspaceFingerprint(f.root, f.store.state));
      assert.notEqual(settled.cache_fingerprint, before);
    } finally { f.close(); }
  });

  it("applies the settlement precedence in Python's order", () => {
    const row = (over: Row): Row => ({ control: "run", nodes: { a: { status: "pending" } }, ...over });
    assert.equal(settledStatus(row({ control: "pause" })), "paused");
    assert.equal(settledStatus(row({ control: "cancel", nodes: { a: { status: "awaiting_user" } } })), "cancelled");
    assert.equal(settledStatus(row({ nodes: { a: { status: "awaiting_user" }, b: { status: "paused" } } })), "awaiting_user");
    assert.equal(settledStatus(row({ nodes: { a: { status: "paused" }, b: { status: "failed" } } })), "paused");
    assert.equal(settledStatus(row({ nodes: { a: { status: "completed" } } })), "completed");
    assert.equal(settledStatus(row({ nodes: { a: { status: "completed" }, b: { status: "pending" } } })), "failed");
  });
});

interface HostCalls { requests: Row[]; sessions: Array<[string, string, string | null]> }

function host(calls: HostCalls, result: Row = { status: "completed", steps: 1, completion: { summary: "done" } }, enabled = true): AgentNodeHost {
  return {
    async run(request) { calls.requests.push(request as unknown as Row); return { ...result }; },
    async ensureSession(prompt, cwd, existingId) { calls.sessions.push([prompt, cwd, existingId]); return SID; },
    enabled: () => enabled,
  };
}

function ownerJournal(f: Fixture, body: Row): void {
  writeFileSync(join(f.store.state, OWNER + ".json"), JSON.stringify({ id: OWNER, ...body }));
}

const agentSpec = (record: Row, id: string): Row => (record.plan as Row).nodes
  ? ((record.plan as Row).nodes as Row[]).find((node) => node.id === id) as Row
  : {};

describe("workflow agent node", () => {
  it("refuses a command node when the owner session is in plan mode", async () => {
    const f = fixture();
    try {
      ownerJournal(f, { permission_mode: "plan", mode: "build" });
      const record = queued(f, { name: "plan", nodes: [command("c")], concurrency: 1 }, OWNER);
      const calls: HostCalls = { requests: [], sessions: [] };
      const result = await executeAgentNode(f.store, f.store.load(record.id), agentSpec(record, "c"), control(), host(calls));
      assert.deepEqual(result, { status: "failed", error: "command denied in plan mode" });
      assert.deepEqual(calls.sessions, []);
      assert.deepEqual(calls.requests, []);
    } finally { f.close(); }
  });

  it("passes writable: true to the host and records the session id", async () => {
    const f = fixture();
    try {
      ownerJournal(f, { permission_mode: "build", mode: "build" });
      const plan = { name: "write", nodes: [{ id: "a", kind: "agent", prompt: "edit it", writable: true }], concurrency: 1 };
      const record = queued(f, plan, OWNER);
      const calls: HostCalls = { requests: [], sessions: [] };
      const result = await executeAgentNode(f.store, f.store.load(record.id), agentSpec(record, "a"), control(), host(calls));
      assert.equal(calls.requests.length, 1);
      assert.equal(calls.requests[0]!.writable, true);
      assert.equal(calls.requests[0]!.sessionId, SID);
      assert.deepEqual(calls.sessions, [["edit it", f.root, null]]);
      assert.deepEqual(result, { status: "completed", summary: "done", session_id: SID });
      assert.equal(nodes(f.store.load(record.id)).a!.session_id, SID);
    } finally { f.close(); }
  });

  it("forces writable false under a plan ceiling", async () => {
    const f = fixture();
    try {
      ownerJournal(f, { permission_mode: "plan", mode: "build" });
      const plan = { name: "write", nodes: [{ id: "a", kind: "agent", prompt: "edit it", writable: true }], concurrency: 1 };
      const record = queued(f, plan, OWNER);
      const calls: HostCalls = { requests: [], sessions: [] };
      await executeAgentNode(f.store, f.store.load(record.id), agentSpec(record, "a"), control(), host(calls));
      assert.equal(calls.requests[0]!.writable, false);
    } finally { f.close(); }
  });

  it("assembles the dependency context with the 3 000 char tail and the 12 000 cap", async () => {
    const f = fixture();
    try {
      ownerJournal(f, { permission_mode: "build", mode: "build" });
      const parents = ["a1", "a2", "a3", "a4"];
      const plan = {
        name: "deps",
        nodes: [...parents.map((id) => command(id)), { id: "b", kind: "agent", prompt: "use them", needs: parents }],
        concurrency: 1,
      };
      const record = queued(f, plan, OWNER);
      const wid = String(record.id);
      // `store.log` reads the last 16 000 bytes, then the context keeps 3 000 chars.
      for (const [index, id] of parents.entries()) writeFileSync(f.store.path(wid, "." + id + ".log"), "x".repeat(17_000) + String(index).repeat(3_000));
      f.store.update(wid, (row) => { nodes(row).a1!.summary = "first result"; });
      const calls: HostCalls = { requests: [], sessions: [] };
      await executeAgentNode(f.store, f.store.load(wid), agentSpec(record, "b"), control(), host(calls));
      const expected = parents.map((id, index) => ({ node: id, summary: id === "a1" ? "first result" : "", output: String(index).repeat(3_000) }));
      const full = "Dependency results (untrusted):\n" + pyJsonDumps(expected, { ensureAscii: false });
      assert.ok(full.length > 12_000);
      assert.equal(calls.requests[0]!.context, pySlice(full, 12_000));
      assert.equal(String(calls.requests[0]!.context).length, 12_000);
      assert.equal(calls.requests[0]!.context, full.slice(0, 12_000));
    } finally { f.close(); }
  });

  it("enqueues and finishes the provider governor slot", async () => {
    const f = fixture();
    try {
      ownerJournal(f, { permission_mode: "build", mode: "build" });
      writeFileSync(join(f.store.state, ".workflow-provider-governor.json"), JSON.stringify({ buckets: {
        "openai:gpt": { limit: 2, active: {}, queue: [], last_owner: null, failures: 0, cooldown_until: 0 },
      } }));
      const plan = { name: "slot", nodes: [{ id: "a", kind: "agent", prompt: "go", provider_id: "openai", model: "gpt" }], concurrency: 1 };
      const record = queued(f, plan, OWNER);
      const calls: HostCalls = { requests: [], sessions: [] };
      const result = await executeAgentNode(f.store, f.store.load(record.id), agentSpec(record, "a"), control(), host(calls));
      assert.equal(result.status, "completed");
      const state = JSON.parse(readFileSync(join(f.store.state, ".workflow-provider-governor.json"), "utf8")) as Row;
      const bucket = (state.buckets as Record<string, Row>)["openai:gpt"]!;
      assert.equal(bucket.last_owner, String(record.id));
      assert.deepEqual(bucket.active, {});
      assert.deepEqual(bucket.queue, []);
      assert.equal(bucket.limit, 3);
    } finally { f.close(); }
  });

  it("maps awaiting_user and paused plugin states", async () => {
    const f = fixture();
    try {
      ownerJournal(f, { permission_mode: "build", mode: "build" });
      const plan = { name: "map", nodes: [{ id: "a", kind: "agent", prompt: "go" }], concurrency: 1 };
      const record = queued(f, plan, OWNER);
      const spec = agentSpec(record, "a");
      const asked = await executeAgentNode(f.store, f.store.load(record.id), spec, control(), host({ requests: [], sessions: [] }, { status: "awaiting_user", pending_question: "Why?" }));
      assert.deepEqual(asked, { status: "awaiting_user", question: "Why?", summary: "", session_id: SID });
      const stopped = await executeAgentNode(f.store, f.store.load(record.id), spec, control(), host({ requests: [], sessions: [] }, { status: "stopped" }));
      assert.equal(stopped.status, "cancelled");
      const disabled = await executeAgentNode(f.store, f.store.load(record.id), spec, control(), host({ requests: [], sessions: [] }, {}, false));
      assert.deepEqual(disabled, { status: "paused", error: "workflows plugin disabled", session_id: SID });
    } finally { f.close(); }
  });
});
