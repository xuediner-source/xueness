/** Sub-agents on the TS front door: a read-only foreground child per Agent call, Python's child-session and task_runs layout, no Python fallback. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import type { AgentProvider, Row } from "@xueness/agent";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { createAgentService } from "../src/agent-service.ts";
import { configuredAgentFeatures } from "../src/agent-features.ts";
import { childSelection, childToolPolicy } from "../src/agent-subagents.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const call = (id: string, name: string, input: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const policy = (request: Row = {}): RunPolicy => ({ mode: "build", permissionMode: "build", disallowed: [], selection: {}, request });
const enabled = (id: string): boolean => ["sessions", "providers", "files", "shell", "planning", "subagents"].includes(id);
const names = (tools: Row[]): string[] => tools.map((tool) => String((tool.function as Row).name));
const isChild = (messages: Row[]): boolean => String(messages[0]?.content ?? "").includes("This delegated task is read-only.");
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xueness-sub-ws-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "xueness-sub-state-")));
  return { root, state, store: new SessionStore(join(state, "sessions")), close() { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); } };
}

describe("subagents on the TS agent service", () => {
  it("dispatches a read-only Explore child in the background and returns its report through task_collect", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "secret-42\n");
    const session = await local.store.new("Ask a subagent what a.txt says", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    const parentSeen: { messages: Row[]; tools: string[] }[] = []; const childSeen: { messages: Row[]; tools: string[] }[] = [];
    const provider: AgentProvider = { async complete(messages, tools) {
      if (isChild(messages)) {
        childSeen.push({ messages, tools: names(tools) });
        return childSeen.length === 1 ? { tool_calls: [call("c1", "Read", { file_path: join(local.root, "a.txt") }), call("c2", "Bash", { command: "touch b", description: "touch" })] } : { content: "a.txt says secret-42" };
      }
      parentSeen.push({ messages, tools: names(tools) });
      if (parentSeen.length === 1) return { tool_calls: [call("a1", "Agent", { description: "read a.txt", prompt: "Read a.txt and report its content", subagent_type: "Explore" })] };
      if (parentSeen.length === 2) return { tool_calls: [call("c1", "task_collect", { wait_seconds: 30, reason: "no_independent_work", detail: "the answer is the child report" })] };
      return parentSeen.length === 3 ? { tool_calls: [call("e1", "Edit", { file_path: join(local.root, "a.txt"), old_string: "secret-42", new_string: "changed" })] } : { content: "It says secret-42." };
    } };
    try {
      const request = { allow_subagents: true };
      const features = configuredAgentFeatures(session, request, { stateDir: local.state, enabled, settings: {} });
      assert.ok(features.includes("subagents.tasks") && !features.includes("subagents.coordination"));
      assert.equal(service.supports(session, request), true, "delegation runs on the TS subagents plugin, not the Python executor");
      await service.createRunner(session, provider, { ...policy(request), permissionMode: "edit" }).run(session);
      assert.equal(session.status, "completed");
      assert.ok(parentSeen[0]!.tools.includes("Agent"));
      assert.ok(parentSeen[0]!.tools.includes("task_collect"), "a bound coordinator offers the collection tool");
      assert.ok(String(((session.results as Row).e1 as Row).output).includes("File has not been read yet"), "the child's read does not count as the parent's");
      assert.equal(readFileSync(join(local.root, "a.txt"), "utf8"), "secret-42\n");
      const listing = parentSeen[0]!.messages.find((message) => String(message.content).includes("Available agent types for the Agent tool:"));
      assert.ok(listing && /- Explore: .*\(Tools: Glob, Grep, Read, Bash\)/.test(String(listing.content)));
      for (const name of ["Agent", "TodoWrite", "TodoRead", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Write", "Edit"]) assert.ok(!childSeen[0]!.tools.includes(name), `child has no ${name}`);
      assert.deepEqual(childSeen[0]!.tools.sort(), ["Bash", "Glob", "Grep", "Read"]);
      assert.equal(existsSync(join(local.root, "b")), false, "the child cannot change the workspace");
      // ZCode's Agent result is a dispatch receipt, not the findings.
      const receiptRow = (session.results as Row).a1 as Row;
      assert.equal(receiptRow.ok, true);
      const dispatched = receiptRow.data as Row;
      const taskId = String(dispatched.task_id);
      assert.match(taskId, /^task-[0-9a-f]{32}$/);
      assert.deepEqual([dispatched.status, dispatched.background, dispatched.evidence_eligible], ["running", true, false]);
      const tool = (session.messages as Row[]).find((message) => message.role === "tool" && message.tool_call_id === "a1")!;
      assert.ok(!String(tool.content).includes("secret-42"), "the dispatch receipt carries no findings");
      const collected = (session.results as Row).c1 as Row;
      assert.equal(collected.ok, true);
      assert.deepEqual(((collected.data as Row).tasks as Row[]).map((row) => [row.id, row.status, row.summary]), [[taskId, "completed", "a.txt says secret-42"]]);
      const runs = session.task_runs as Row[];
      assert.equal(runs.length, 1);
      assert.deepEqual({ ...runs[0], startedAt: 0, endedAt: 0 }, { id: taskId, parent: session.id, agent: "explore", promptChars: 33, status: "completed", steps: 2, startedAt: 0, endedAt: 0,
        summary: "a.txt says secret-42", error: "", root: local.root, childSessionId: runs[0]!.childSessionId, parentSessionId: session.id, rootSessionId: session.id, canResume: true, recoveryReason: "followup_required", notified: true });
      const directory = join(local.state, "subagent-sessions", String(session.id));
      assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".json")), [`${String(runs[0]!.childSessionId)}.json`]);
      const child = await new SessionStore(directory).load(String(runs[0]!.childSessionId));
      assert.deepEqual([child.status, child.read_only, child.permission_mode, child.mode, (child.delegation as Row).taskId, (child.delegation as Row).agent], ["completed", true, "plan", "plan", taskId, "explore"]);
      const denied = (child.results as Row).c2 as Row;
      assert.equal(denied.ok, false);
      assert.equal(((child.results as Row).c1 as Row).ok, true);
      const saved = await local.store.load(String(session.id));
      assert.deepEqual((saved.task_runs as Row[]).map((row) => row.status), ["completed"]);
      if (!pythonUnavailableReason()) {
        const python = JSON.parse(runPython(String.raw`
import json, sys
from xueness.bundled_plugins.subagents.child_sessions import ChildStore, recovery_info
from xueness.bundled_plugins.sessions.subagent_rows import project_journal_subagents
c = json.load(sys.stdin)
store = ChildStore(c["state"], c["parent"]["id"], task_id=c["task"], root=c["root"])
child = store.load(c["child"])
rows = project_journal_subagents(c["parent"], c["parent"]["messages"])
print(json.dumps({"child": child["id"], "recovery": recovery_info(child), "rows": [[r["tool_call_id"], r["task_id"], r["status"]] for r in rows]}))
`, JSON.stringify({ state: local.state, root: local.root, parent: saved, task: taskId, child: runs[0]!.childSessionId }))) as Row;
        assert.deepEqual(python, { child: runs[0]!.childSessionId, recovery: { canResume: true, recoveryReason: "followup_required" }, rows: [["a1", taskId, "completed"]] },
          "Python's ChildStore accepts the child and its projection shows the delegation");
      }
    } finally { await service.dispose(); local.close(); }
  });
  it("uses a stored definition's prompt and tool allowlist", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "x\n");
    mkdirSync(join(local.state, "resources", "subagents"), { recursive: true });
    writeFileSync(join(local.state, "resources", "subagents", "reviewer.json"), JSON.stringify({ id: "reviewer", name: "Reviewer", description: "Reviews code", systemPrompt: "Review with care.", tools: ["read", "Grep"], disallowedTools: ["Grep"] }));
    const session = await local.store.new("Review", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let child = null as { system: string; tools: string[] } | null; let parent = 0;
    const provider: AgentProvider = { async complete(messages, tools) {
      if (isChild(messages)) { child = { system: String(messages[0]!.content), tools: names(tools) }; return { content: "Looks fine." }; }
      parent += 1;
      if (parent === 1) assert.ok(messages.some((message) => String(message.content).includes("- Reviewer: Reviews code (Tools: read)")));
      if (parent === 1) return { tool_calls: [call("a1", "Agent", { description: "review", prompt: "Review a.txt", subagent_type: "reviewer" })] };
      return parent === 2 ? { tool_calls: [call("c1", "task_collect", { wait_seconds: 30, reason: "no_independent_work", detail: "the review is the answer" })] } : { content: "Reviewed." };
    } };
    try {
      await service.createRunner(session, provider, policy({ allowSubagents: true })).run(session);
      assert.ok(child);
      assert.ok(child!.system.includes("\nReview with care.\n\nNotes:"));
      assert.deepEqual(child!.tools, ["Read"]);
      // The definition's id is on the task row, not on the dispatch receipt.
      const run = (session.task_runs as Row[])[0]!;
      assert.equal(run.agent, "reviewer");
      assert.equal(run.status, "completed");
      // `steps` is the child's own count, so one completed provider turn.
      assert.deepEqual((((session.results as Row).c1 as Row).data as Row).tasks as Row[], [{ id: run.id, agent: "reviewer", status: "completed", summary: "Looks fine.", error: "", steps: 1 }]);
    } finally { await service.dispose(); local.close(); }
  });
  it("offers no Agent tool unless the request allows delegation, and reports an unknown type", async () => {
    const local = scratch();
    const session = await local.store.new("Delegate", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let requests = 0; let tools: string[] = [];
    const provider: AgentProvider = { async complete(_messages, offered) {
      requests += 1; if (requests === 1) tools = names(offered);
      return requests === 1 ? { tool_calls: [call("a1", "Agent", { description: "x", prompt: "y" })] } : { content: "ok" };
    } };
    try {
      await service.createRunner(session, provider, policy()).run(session);
      assert.ok(!tools.includes("Agent"));
      assert.match(String(((session.results as Row).a1 as Row).error), /not active/);
      const second = await local.store.new("Delegate", local.root); requests = 0;
      // Background dispatch: the unknown type is refused inside the child run, so
      // it surfaces as a failed task the collection reports.
      const unknown: AgentProvider = { async complete() {
        requests += 1;
        if (requests === 1) return { tool_calls: [call("a2", "Agent", { description: "x", prompt: "y", subagent_type: "Nope" })] };
        return requests === 2 ? { tool_calls: [call("c2", "task_collect", { wait_seconds: 30, reason: "no_independent_work", detail: "nothing else to do" })] } : { content: "ok" };
      } };
      await service.createRunner(second, unknown, policy({ allow_subagents: true })).run(second);
      const collected = ((second.results as Row).c2 as Row).data as Row;
      const [failed] = collected.tasks as Row[];
      assert.deepEqual([failed!.status, failed!.ok], ["failed", undefined]);
      assert.match(String(failed!.error), /Agent type 'Nope' not found\. Available agents: general-purpose, Explore/);
      assert.equal((second.results as Row).a2 && ((second.results as Row).a2 as Row).ok, true, "the dispatch receipt itself succeeded");
    } finally { await service.dispose(); local.close(); }
  });
  it("stops the child when the parent run stops, recording a cancelled task", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "x\n");
    const session = await local.store.new("Delegate then stop", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let stop = false; let parent = 0;
    const provider: AgentProvider = { async complete(messages) {
      if (isChild(messages)) { stop = true; return { tool_calls: [call("c1", "Read", { file_path: join(local.root, "a.txt") })] }; }
      parent += 1;
      return parent === 1 ? { tool_calls: [call("a1", "Agent", { description: "x", prompt: "Read a.txt" })] } : { content: "done" };
    } };
    try {
      await service.createRunner(session, provider, policy({ allow_subagents: true })).run(session, { shouldStop: () => stop });
      // The dispatch receipt succeeds: the child is stopped inside its worker,
      // and the cancellation shows on the task row, not on the tool result.
      const result = (session.results as Row).a1 as Row;
      assert.equal(result.ok, true);
      const run = (session.task_runs as Row[])[0]!;
      assert.deepEqual([run.status, run.agent, run.canResume, run.recoveryReason], ["cancelled", null, false, "cancelled"]);
      const child = await new SessionStore(join(local.state, "subagent-sessions", String(session.id))).load(String(run.childSessionId));
      assert.deepEqual([child.status, (child.delegation as Row).cancelled], ["stopped", true]);
    } finally { await service.dispose(); local.close(); }
  });
  it("runs a session with background tasks left by the removed Python backend on TS", async () => {
    const local = scratch();
    const session = await local.store.new("Collect", local.root);
    session.subagent_coordination = { "task-abc": { call_id: "t1", collected: false, turn: 1 } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      assert.ok(!configuredAgentFeatures(session, {}, { stateDir: local.state, enabled, settings: {} }).includes("subagents.coordination"));
      assert.equal(service.supports(session, {}), true);
      session.subagent_coordination = { "task-abc": { call_id: "t1", collected: true, turn: 1 } };
      assert.equal(service.supports(session, { allow_subagents: true }), true);
    } finally { await service.dispose(); local.close(); }
  });
  it("F08.01: a definition's model override is clamped to the host ceiling and its tools never exceed the parent's", async () => {
    const parent = { model_selection: { provider_id: "prov-a", model: "model-a", reasoning_effort: "low" } } as never;
    // Inside the ceiling the override holds; outside it the parent's model wins.
    assert.deepEqual(childSelection(parent, { providerId: "prov-a", model: "model-b" }, ["model-a", "model-b"]).selection, { provider_id: "prov-a", model: "model-b", reasoning_effort: "low" });
    const clamped = childSelection(parent, { providerId: "prov-a", model: "model-z" }, ["model-a", "model-b"]);
    assert.deepEqual(clamped.selection, { provider_id: "prov-a", model: "model-a", reasoning_effort: "low" });
    // A host with no saved profiles (env-configured) declares no ceiling.
    assert.deepEqual(childSelection(parent, { model: "model-z" }, null).selection.model, "model-z");
    // The child's tools stay inside the parent's offered set minus every denial.
    const grant = childToolPolicy({ tools: null, disallowedTools: ["Grep"] } as never, ["read", "grep", "bash", "Task"], ["bash"]);
    assert.equal(grant.allowed("read"), true);
    assert.equal(grant.allowed("bash"), false, "the parent's denial bounds the child");
    assert.equal(grant.allowed("grep"), false, "the profile's denial applies through the alias");
    assert.equal(grant.allowed("Task"), false, "delegation itself is denied");
  });
  it("F08.01: inherit_history branches the parent's narration into the child without touching the parent journal", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "x\n");
    const session = await local.store.new("Branch history", local.root);
    (session.messages as Row[]).push(
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    );
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let childPrompt: Row[] = []; let parent = 0;
    const provider: AgentProvider = { async complete(messages, tools) {
      if (isChild(messages)) { childPrompt = messages; return { content: "done" }; }
      parent += 1;
      if (parent === 1) return { tool_calls: [call("a1", "Agent", { description: "x", prompt: "Read a.txt", inherit_history: true })] };
      return parent === 2 ? { tool_calls: [call("c1", "task_collect", { wait_seconds: 30, reason: "no_independent_work", detail: "need the branch" })] } : { content: "ok" };
    } };
    try {
      await service.createRunner(session, provider, policy({ allow_subagents: true })).run(session);
      const branch = childPrompt.filter((message) => message._meta_source === "inherited_history");
      assert.deepEqual(branch.map((message) => [message.role, message.content]), [["user", "Branch history"], ["user", "earlier question"], ["assistant", "earlier answer"]],
        "the inherited turns sit between the system and task prompts, tagged");
      assert.ok(String(childPrompt[0]!.content).includes("This delegated task is read-only."));
      const task = childPrompt.findIndex((message) => message._meta_source !== "inherited_history" && message.role === "user" && String(message.content).includes("Read a.txt"));
      assert.ok(branch.length && task > branch.length, "the task prompt follows the branch");
      const run = (session.task_runs as Row[])[0]!;
      const child = await new SessionStore(join(local.state, "subagent-sessions", String(session.id))).load(String(run.childSessionId));
      assert.deepEqual((child.delegation as Row).contextInherited !== undefined ? [(child.delegation as Row).contextInherited, (child.delegation as Row).inheritedMessages] : [false, 0], [true, 3]);
      // The parent's own journal is unchanged: its turns carry no inherited tag.
      assert.ok((session.messages as Row[]).every((message) => message._meta_source !== "inherited_history"));
      const saved = await local.store.load(String(session.id));
      assert.deepEqual((saved.messages as Row[]).map((message) => message.content), (session.messages as Row[]).map((message) => message.content));
    } finally { await service.dispose(); local.close(); }
  });
});
