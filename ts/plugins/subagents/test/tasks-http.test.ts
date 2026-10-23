/** Session task list, cancel, resume, message and background collection. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { completionCheck, contextReminder, createSubagentTasksHttp, TaskCoordinator, TaskRegistry } from "../src/index.ts";

const SID = "ab".repeat(16);
const ACTIVE = "messages require this parent\u2019s active child";

describe("subagent tasks http", () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-tasks-"));
  const state = join(base, "state"), root = join(base, "ws"), runs = join(base, "runs");
  mkdirSync(state, { recursive: true }); mkdirSync(root, { recursive: true }); mkdirSync(runs, { recursive: true });
  const store = new SessionStore(state);
  const registry = new TaskRegistry();
  let cancelOn = false;
  const api = createSubagentTasksHttp({ stateDir: state, enabled: () => true, store, projectDir: root, webRuns: runs, allowedRoots: () => [root], registry, cancelEnabled: () => cancelOn, authorize: () => null });
  const off = createSubagentTasksHttp({ stateDir: state, enabled: () => false, store, projectDir: root, webRuns: runs, allowedRoots: () => [root], registry: new TaskRegistry(), cancelEnabled: () => true, authorize: () => null });
  let sessionId = "";
  after(() => rmSync(base, { recursive: true, force: true }));

  it("owns only the implemented task actions and refuses before lookup", async () => {
    const session = await store.new("parent", root, { sessionId: SID });
    sessionId = String(session.id);
    assert.equal(sessionId, SID);
    assert.equal(api.owns("GET", ["api", "sessions", SID, "tasks"]), true);
    assert.equal(api.owns("POST", ["api", "sessions", SID, "tasks", "task-a", "cancel"]), true);
    assert.equal(api.owns("POST", ["api", "sessions", SID, "tasks", "task-a", "evict"]), false);
    assert.equal(api.owns("GET", ["api", "workflows"]), false);
    assert.equal(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-a", "evict"], {}, null), null);
    assert.deepEqual(await off.dispatch("GET", ["api", "sessions", SID, "tasks"], {}, { extra: true }), [403, { error: "plugin disabled or dependency unavailable: subagents", plugin: "subagents" }]);
    assert.equal("code" in (await off.dispatch("POST", ["api", "sessions", "nope", "tasks", "task-a", "cancel"], {}, null) as [number, Record<string, unknown>])[1], false);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", "nope", "tasks"], {}, null), [403, { error: "workspace root not permitted" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", "cd".repeat(16), "tasks"], {}, null), [404, { error: "session not found" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks"], {}, null), [405, { error: "method not allowed" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", SID, "tasks"], {}, { extra: 1 }), [400, { error: "request body must be empty" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", SID, "tasks"], {}, {}), [200, { tasks: [] }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", SID, "tasks", "task-a", "cancel"], {}, null), [405, { error: "method not allowed" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-a", "cancel"], {}, { extra: 1 }), [400, { error: "request body must be empty" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", "cd".repeat(16), "tasks", "task-missing", "cancel"], {}, null), [403, { error: "single subtask cancellation is disabled" }]);
    cancelOn = true;
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-missing", "cancel"], {}, null), [404, { error: "subtask not found" }]);
    registry.record("task-live", { parentSession: SID, agent: "review", prompt: "look", root });
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-live", "cancel"], {}, null), [200, { cancelled: true, taskId: "task-live" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-live", "cancel"], {}, null), [409, { error: "subtask is not running" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "nope", "resume"], {}, {}), [404, { error: "subtask not found" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-live", "resume"], {}, {}), [409, { error: "start a parent turn before resuming this child" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", SID, "tasks", "task-live", "message"], {}, { requestId: "m1", message: "steer" }), [409, { error: ACTIVE }]);
    assert.deepEqual(await api.dispatch("PUT", ["api", "sessions", SID, "tasks", "task-live", "transcript"], {}, null), [405, { error: "method not allowed" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", SID, "tasks", "task-live", "transcript"], {}, null), [404, { error: "subtask not found" }]);
  });

  it("projects a retained child onto the task list", async () => {
    const childId = "ef".repeat(16);
    const directory = join(state, "subagent-sessions", SID);
    mkdirSync(directory, { recursive: true });
    const child = { id: childId, root, status: "completed", messages: [{ role: "user", content: "find the bug" }], results: {}, read_only: true, permission_mode: "plan", mode: "plan", steps: 2,
      delegation: { taskId: "task-child", parentSessionId: SID, rootSessionId: SID, agent: "review", createdAt: 10 }, completion: { summary: "done" } };
    writeFileSync(join(directory, childId + ".json"), pyJsonDumps(child, { indent: 2 }));
    const listed = await api.dispatch("GET", ["api", "sessions", SID, "tasks"], {}, null) as [number, { tasks: Record<string, unknown>[] }];
    assert.equal(listed[0], 200);
    const row = listed[1].tasks.find((item) => item.id === "task-child");
    assert.equal(row?.status, "completed");
    assert.equal(row?.canResume, true);
    assert.equal(row?.recoveryReason, "followup_required");
    assert.equal(row?.childSessionId, childId);
    assert.equal(row?.summary, "done");
    const transcript = await api.dispatch("GET", ["api", "sessions", SID, "tasks", "task-child", "transcript"], {}, null) as [number, { initialPrompt: string; timeline: { schema: string } }];
    assert.equal(transcript[0], 200);
    assert.equal(transcript[1].initialPrompt, "find the bug");
    assert.equal(transcript[1].timeline.schema, "xueness.events.v1");
  });
});

describe("task coordinator", () => {
  it("dispatches in the background and collects the result", async () => {
    const session: Record<string, unknown> = { id: SID, root: "/ws", messages: [{ role: "user", content: "go", _turn_id: "turn-3" }], task_runs: [] };
    const registry = new TaskRegistry();
    const coordinator = new TaskCoordinator(session, registry);
    const receipt = coordinator.dispatch("call-1", { prompt: "inspect", agent: "review" }, async () => ({ ok: true, summary: "found it", steps: 1 }));
    assert.equal(receipt.ok, true);
    assert.equal(receipt.background, true);
    assert.equal(receipt.status, "running");
    assert.match(String(receipt.task_id), /^task-/);
    const collected = await coordinator.collect({ task_ids: [receipt.task_id], wait_seconds: 2, reason: "dependency", detail: "need the finding" });
    assert.equal(collected.ok, true);
    assert.equal((collected.tasks as { summary: string }[])[0]?.summary, "found it");
    assert.equal((session.subagent_coordination as Record<string, { collected: boolean }>)[String(receipt.task_id)]?.collected, true);
    assert.equal(completionCheck(session).status, "passed");
    assert.equal(contextReminder(session), "");
    await coordinator.close();
  });
});
