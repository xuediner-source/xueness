/** C-WFL-04: durable one-time terminal receipts for background subagent tasks. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentContext } from "@xueness/agent";
import { mergeSubagentNotices, pendingSubagentNotices, subagentNoticeKey, subagentsExtension, TaskCoordinator, TaskRegistry } from "../src/index.ts";

const SID = "ab".repeat(16);
const OTHER = "cd".repeat(16);

function state(session: Record<string, unknown> = { id: SID, messages: [], archived_messages: [], task_runs: [] }) {
  let saves = 0;
  let fail = false;
  const context = {
    session,
    async save() { saves += 1; if (fail) throw new Error("save failed"); },
  } as unknown as AgentContext;
  return { context, session, saves: () => saves, failSave: () => { fail = true; }, fixSave: () => { fail = false; } };
}

function coordinatorWith(session: Record<string, unknown>, registry: TaskRegistry) {
  return new TaskCoordinator(session, registry);
}

describe("subagent background receipts", () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-receipts-"));
  after(() => { rmSync(base, { recursive: true, force: true }); });

  it("delivers exactly one hidden terminal notice per task id and status, never for running tasks", async () => {
    const registry = new TaskRegistry();
    const done = TaskRegistry.newId(), running = TaskRegistry.newId(), cancelled = TaskRegistry.newId();
    registry.record(done, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.finish(done, { ok: true, summary: "SECRET CHILD FINDINGS", error: "", steps: 2 });
    registry.record(running, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.record(cancelled, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.cancel(cancelled);
    const { context, session, saves } = state();
    const coordinator = coordinatorWith(session, registry);

    coordinator.sync();
    assert.equal(await mergeSubagentNotices(context), true);
    const notices = (session.messages as Record<string, unknown>[]).filter((message) => typeof message._background_task_notice === "string");
    assert.deepEqual(notices.map((message) => message._background_task_notice).sort(),
      [subagentNoticeKey(cancelled, "cancelled"), subagentNoticeKey(done, "completed")].sort());
    const completed = notices.find((message) => message._background_task_notice === subagentNoticeKey(done, "completed"))!;
    assert.equal(completed.role, "user");
    assert.equal(completed._input_kind, "background_notice");
    assert.equal(completed._meta_source, "task_status");
    assert.match(String(completed.content), new RegExp(`task_collect.*${done}`));
    // The untrusted child summary never becomes notice content.
    assert.doesNotMatch(String(completed.content), /SECRET CHILD FINDINGS/);
    assert.equal(saves(), 1);

    // Every later boundary — same turn, next turn, a fresh coordinator after
    // parent resume — stays quiet: exactly one effective reminder, ever.
    coordinator.sync();
    assert.equal(await mergeSubagentNotices(context), false);
    const resumed = coordinatorWith(session, registry);
    resumed.sync();
    assert.equal(await mergeSubagentNotices(context), false);
    assert.equal(saves(), 1);
    assert.equal((session.messages as unknown[]).filter((message) => (message as Record<string, unknown>)._background_task_notice === subagentNoticeKey(done, "completed")).length, 1);
  });

  it("keeps the durable notified stamp across coordinator syncs so a compacted notice is not resent", async () => {
    const registry = new TaskRegistry();
    const tid = TaskRegistry.newId();
    registry.record(tid, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.finish(tid, { ok: true, summary: "", error: "", steps: 1 });
    const { context, session } = state();
    const coordinator = coordinatorWith(session, registry);
    coordinator.sync();
    assert.equal(await mergeSubagentNotices(context), true);
    assert.equal((session.task_runs as Record<string, unknown>[])[0]!.notified, true);

    // The registry row never carries the stamp, so a mirror must not erase it.
    coordinator.sync();
    assert.equal((session.task_runs as Record<string, unknown>[])[0]!.notified, true, "sync preserves the delivery stamp");
    // Compaction drops both the message and its archived copy: only the stamp remains.
    session.messages = [];
    session.archived_messages = [];
    coordinator.sync();
    assert.equal(await mergeSubagentNotices(context), false, "the stamp alone prevents a second reminder");
    assert.deepEqual(session.messages, []);
    assert.equal(pendingSubagentNotices(session).length, 0);
  });

  it("stays idle-quiet: no terminal tasks means no notices, no saves, no continued loop", async () => {
    const { context, session, saves } = state();
    assert.equal(await mergeSubagentNotices(context), false);
    assert.deepEqual(session.messages, []);
    assert.equal(saves(), 0);
    const registry = new TaskRegistry();
    const live = TaskRegistry.newId();
    registry.record(live, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.update(live, { steps: 9 });
    const coordinator = coordinatorWith(session, registry);
    coordinator.sync();
    assert.equal(await mergeSubagentNotices(context), false);
    assert.deepEqual(session.messages, []);
    assert.equal(saves(), 0);
  });

  it("ignores foreign-parent rows and caps the reminder batch", async () => {
    const foreign = TaskRegistry.newId();
    const registry = new TaskRegistry();
    registry.record(foreign, { parentSession: OTHER, agent: null, prompt: "p", root: null });
    registry.finish(foreign, { ok: true, summary: "", error: "", steps: 1 });
    const session = { id: SID, messages: [], archived_messages: [], task_runs: [{ id: foreign, parent: OTHER, status: "completed" }] };
    assert.deepEqual(pendingSubagentNotices(session), []);

    const many = Array.from({ length: 10 }, () => {
      const tid = TaskRegistry.newId();
      registry.record(tid, { parentSession: SID, agent: null, prompt: "p", root: null });
      registry.finish(tid, { ok: false, summary: "", error: "boom", steps: 1 });
      return tid;
    });
    const bulk = { id: SID, messages: [], archived_messages: [], task_runs: [] as Record<string, unknown>[] };
    const bulkCoordinator = coordinatorWith(bulk, registry);
    bulkCoordinator.sync();
    assert.equal(pendingSubagentNotices(bulk).length, 8);
    const { context } = state(bulk);
    assert.equal(await mergeSubagentNotices(context), true);
    const keys = (bulk.messages as Record<string, unknown>[]).map((message) => message._background_task_notice);
    assert.equal(new Set(keys).size, 8);
    assert.equal(keys.some((key) => String(key).includes(foreign)), false);
    assert.ok(many.length >= 8);
  });

  it("rolls a failed save back so the reminder is resent exactly once later", async () => {
    const registry = new TaskRegistry();
    const tid = TaskRegistry.newId();
    registry.record(tid, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.finish(tid, { ok: false, summary: "", error: "failed hard", steps: 1 });
    const { context, session, failSave, fixSave, saves } = state();
    const coordinator = coordinatorWith(session, registry);
    coordinator.sync();

    failSave();
    await assert.rejects(async () => { await mergeSubagentNotices(context); }, /save failed/);
    assert.deepEqual(session.messages, []);
    assert.equal((session.task_runs as Record<string, unknown>[]).find((row) => row.id === tid)?.notified, false);

    fixSave();
    assert.equal(await mergeSubagentNotices(context), true);
    assert.equal((session.messages as Record<string, unknown>[]).filter((message) => message._background_task_notice === subagentNoticeKey(tid, "failed")).length, 1);
    assert.equal(await mergeSubagentNotices(context), false);
    assert.equal(saves(), 2);
  });

  it("merges at the extension's safe boundaries only while a coordinator is bound", async () => {
    const registry = new TaskRegistry();
    const tid = TaskRegistry.newId();
    registry.record(tid, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.finish(tid, { ok: true, summary: "", error: "", steps: 1 });
    const binding = { coordinator: null as TaskCoordinator | null };
    const extension = subagentsExtension({ stateDir: base, allowed: true, binding });
    const { context, session, saves } = state();

    // Without a coordinator the boundaries are inert — the foreground task tool keeps working.
    await extension.beforeModelRequest?.(context);
    assert.deepEqual(session.messages, []);
    assert.equal(saves(), 0);

    const coordinator = coordinatorWith(session, registry);
    coordinator.bindExecutor(async () => ({}), null);
    binding.coordinator = coordinator;
    await extension.beforeModelRequest?.(context);
    assert.equal((session.messages as Record<string, unknown>[]).filter((message) => message._background_task_notice === subagentNoticeKey(tid, "completed")).length, 1);
    // The final boundary reports a continued loop only when a new notice merged.
    assert.equal(await extension.beforeFinalResponse?.(context, { content: "done" }), false);
    assert.equal(saves(), 1);
    assert.deepEqual(extension.capabilities, ["subagents.tasks", "subagents.coordination"]);
  });

  it("survives compaction: archived notice keys still dedup after the stamp row is gone", async () => {
    const tid = TaskRegistry.newId();
    const key = subagentNoticeKey(tid, "completed");
    const session = { id: SID, messages: [], archived_messages: [{ role: "user", _background_task_notice: key }], task_runs: [{ id: tid, parent: SID, status: "completed", notified: false }] };
    const { context, saves } = state(session);
    assert.equal(await mergeSubagentNotices(context), false);
    assert.deepEqual(session.messages, []);
    assert.equal(saves(), 0);
  });
});
