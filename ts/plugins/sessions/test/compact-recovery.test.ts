import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SessionStore } from "@xueness/sessions";
import type { AgentContext, Row } from "@xueness/agent";
import { sessionsCompactPersistenceExtension } from "../src/compact-runtime.ts";

function committedResults(): Row {
  return {
    tool_call_1: { ok: true, content: "committed tool output" },
    tool_call_2: { ok: true, content: [{ type: "text", text: "structured result" }] },
  };
}

async function context() {
  const directory = mkdtempSync(join(tmpdir(), "xueness-compact-recovery-"));
  const root = join(directory, "workspace");
  const store = new SessionStore(join(directory, "state"));
  const session = await store.new("crash recovery", root);
  const saves: string[] = [];
  const ctx = {
    session, store, stateDir: store.directory, root,
    save: async () => { saves.push(String(session.id)); await store.save(session); },
  } as unknown as AgentContext;
  return { directory, store, session, ctx, saves, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("crash recovery converges open compact operations without touching committed results", async () => {
  const f = await context(); try {
    f.session.results = committedResults();
    f.session.messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "task" },
      { role: "assistant", content: "", tool_calls: [{ id: "tool_call_1", type: "function", function: { name: "write", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tool_call_1", content: "committed tool output" },
    ];
    f.session.compactions = [{ operationId: "older", archived: [{ role: "user", content: "archived original" }] }];
    f.session.compact_timeline = [
      { id: "done", trigger: "auto", status: "completed", attempt: 1 },
      { id: "crashed", trigger: "auto", status: "started", attempt: 1, startedAt: "2026-10-01T00:00:00Z" },
      { id: "retrying", trigger: "manual", status: "retrying", attempt: 2, startedAt: "2026-10-01T00:10:00Z" },
    ];
    f.session.context_checkpoints = [{ id: "cp-done", operationId: "done" }];
    await f.store.save(f.session); // stabilize message identities before the snapshot
    const resultsBefore = JSON.stringify(f.session.results);
    const messagesBefore = JSON.stringify(f.session.messages);
    const compactionsBefore = JSON.stringify(f.session.compactions);

    await sessionsCompactPersistenceExtension().beforeRun!(f.ctx);

    const timeline = f.session.compact_timeline as Row[];
    assert.equal(timeline.find((row) => row.id === "done")!.status, "completed", "settled rows keep their verdict");
    assert.equal(timeline.find((row) => row.id === "crashed")!.status, "interrupted");
    assert.equal(timeline.find((row) => row.id === "crashed")!.reason, "runtime_interrupted");
    assert.equal(timeline.find((row) => row.id === "retrying")!.status, "interrupted");
    assert.equal(JSON.stringify(f.session.results), resultsBefore, "committed tool results survive recovery");
    assert.equal(JSON.stringify(f.session.messages), messagesBefore, "message history survives recovery");
    assert.equal(JSON.stringify(f.session.compactions), compactionsBefore, "archived originals survive recovery");
    assert.deepEqual(f.saves, [String(f.session.id)], "the recovered timeline is persisted once");
  } finally { f.close(); }
});

test("a started operation recovers completed only through its own checkpoint, never a nearby summary", async () => {
  const f = await context(); try {
    f.session.messages = [
      { role: "system", content: "prompt" },
      { role: "user", _compact_summary: true, content: "an unrelated summary happens to exist" },
    ];
    f.session.compact_timeline = [
      { id: "checkpointed", trigger: "auto", status: "started", attempt: 1 },
      { id: "orphan", trigger: "auto", status: "started", attempt: 1 },
    ];
    f.session.context_checkpoints = [{ id: "cp-other", operationId: "checkpointed" }];
    await sessionsCompactPersistenceExtension().beforeRun!(f.ctx);
    const timeline = f.session.compact_timeline as Row[];
    assert.equal(timeline.find((row) => row.id === "checkpointed")!.status, "completed");
    assert.equal(timeline.find((row) => row.id === "checkpointed")!.checkpointId, "cp-other");
    assert.equal(timeline.find((row) => row.id === "orphan")!.status, "interrupted");

    // A second run finds nothing left to converge and must not publish again.
    f.saves.length = 0;
    await sessionsCompactPersistenceExtension().beforeRun!(f.ctx);
    assert.deepEqual(f.saves, [], "an already converged timeline is not re-published");
  } finally { f.close(); }
});
