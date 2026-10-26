/** F08.03: coordinator message contract — task identity, safe-boundary inbox delivery, escalations. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChildJournal, answerEscalation, drainInbox, enqueueMessage, newChild, pendingEscalations,
  raiseEscalation, resolveTaskIdentity, respondToCoordinatorTool, TaskCoordinator, TaskRegistry, writeJournalRow } from "../src/index.ts";

const SID = "ab".repeat(16);

function fixture(base: string, parent = SID) {
  const root = join(base, "ws", parent);
  const stateDir = join(base, "state");
  mkdirSync(stateDir, { recursive: true });
  const taskId = "task-" + "1a".repeat(16);
  const journal = new ChildJournal(stateDir, parent, { taskId, root });
  const child = newChild({ parent, taskId, root, system: "system", prompt: "do the work", agent: null, selection: {} });
  writeJournalRow(journal.directory, child);
  return { root, stateDir, taskId, journal, child: () => journal.findTask(taskId) };
}

describe("coordinator message contract (F08.03)", () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-contract-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  it("resolves task identity against the parent's own registry row", () => {
    const row = { id: "task-ok123", parent: SID, childSessionId: "cd".repeat(16) };
    assert.deepEqual(resolveTaskIdentity({ taskId: "task-ok123", row, parentSessionId: SID }),
      { ok: true, taskId: "task-ok123", childSessionId: "cd".repeat(16) });
    // Message admission (shape) and the authorization boundary (ownership) are
    // separate refusals: each failure names its own reason.
    assert.equal(resolveTaskIdentity({ taskId: "nope", row, parentSessionId: SID }).reason, "invalid_task_id");
    assert.equal(resolveTaskIdentity({ taskId: "task-ok123", row: null, parentSessionId: SID }).reason, "not_found");
    assert.equal(resolveTaskIdentity({ taskId: "task-ok123", row: { id: "task-ok123", parent: "ef".repeat(16) }, parentSessionId: SID }).reason, "foreign_parent");
    assert.equal(resolveTaskIdentity({ taskId: "task-ok123", row, parentSessionId: SID, childSessionId: "ef".repeat(16) }).reason, "stale_child");
  });

  it("raises one pending escalation per task, idempotently per requestId", () => {
    const { journal, child } = fixture(base, "11".repeat(16));
    const first = raiseEscalation(journal, child(), "Which branch should I review?", "req-1", "task-raise-1");
    assert.deepEqual(first, { id: "req-1", taskId: "task-raise-1", status: "pending" });
    // Same requestId + same question replays the stored receipt without a second record.
    assert.deepEqual(raiseEscalation(journal, child(), "Which branch should I review?", "req-1", "task-raise-1"), first);
    // Same requestId naming a different question is refused, not overwritten.
    assert.throws(() => raiseEscalation(journal, child(), "A different question?", "req-1", "task-raise-1"), /different escalation/);
    // One open question per task; another task of the same child may still ask.
    assert.throws(() => raiseEscalation(journal, child(), "Second question?", "req-2", "task-raise-1"), /pending escalation/);
    assert.equal(raiseEscalation(journal, child(), "Unrelated task question?", "req-3", "task-raise-2").status, "pending");
    assert.deepEqual(pendingEscalations(journal, child(), "task-raise-1").map((item) => item.id), ["req-1"]);
    assert.equal(pendingEscalations(journal, child()).length, 2);
    // A terminal child cannot escalate.
    const done = child();
    done.status = "completed";
    assert.throws(() => raiseEscalation(journal, done, "Late question?", "req-9", "task-raise-9"), /current state/);
  });

  it("refuses plain messages to a questioning child but admits the answer", () => {
    const { journal, child } = fixture(base, "22".repeat(16));
    raiseEscalation(journal, child(), "Block or fail?", "req-esc", "task-answer-1");
    const held = child();
    held.pending_question = true;
    assert.throws(() => enqueueMessage(journal, held, "unrelated nudge", "req-plain"), /current state/);
    // The authorization to bypass the hold belongs to the escalation answer alone.
    const receipt = enqueueMessage(journal, held, "Please fail the run.", "req-ans", { pendingQuestionOk: true, summary: "answer" });
    assert.deepEqual(receipt, { id: "req-ans", status: "queued" });
    assert.throws(() => enqueueMessage(journal, held, "x", "req-s", { summary: "x".repeat(201) }), /summary/);
  });

  it("answers an escalation exactly once and replays the stored receipt", () => {
    const { journal, child } = fixture(base, "33".repeat(16));
    raiseEscalation(journal, child(), "How many files?", "req-esc", "task-answer-2");
    const answered = answerEscalation(journal, child(), "req-esc", "Forty-two files.", "req-ans");
    assert.equal(answered.status, "answered");
    assert.equal((answered.receipt as Record<string, unknown>).status, "queued");
    // Same answer again: an idempotent replay, never a second queued message.
    const replay = answerEscalation(journal, child(), "req-esc", "Forty-two files.", "req-ans");
    assert.equal(replay.replay, true);
    assert.equal(pendingEscalations(journal, child()).length, 0);
    // A different answer to a settled escalation is refused.
    assert.throws(() => answerEscalation(journal, child(), "req-esc", "A different answer.", "req-other"), /already answered/);
    assert.throws(() => answerEscalation(journal, child(), "req-unknown", "Any answer.", "req-x"), /unknown escalation/);
    // The answer itself is queued in the inbox, deliverable at the next boundary.
    assert.equal(drainInbox(journal, child()).length, 1);
  });

  it("delivers inbox messages once, as coordinator attribution, and clears the answered question", () => {
    const { journal, child } = fixture(base, "44".repeat(16));
    raiseEscalation(journal, child(), "Proceed or stop?", "req-esc", "task-drain-1");
    answerEscalation(journal, child(), "req-esc", "Proceed with the plan.", "req-ans");
    const held = child();
    held.pending_question = true;
    const delivered = drainInbox(journal, held);
    assert.deepEqual(delivered, [{ id: "req-ans", status: "applied" }]);
    const guide = (held.messages as Record<string, unknown>[]).at(-1)!;
    assert.equal(guide.role, "user");
    assert.equal(guide._coordination, true);
    assert.equal(guide._input_kind, "guide");
    assert.equal(guide._message_id, "req-ans");
    assert.equal(guide.content, "Proceed with the plan.");
    // The question flag falls only once no escalation of this child is open.
    assert.equal(held.pending_question, false);
    // A drain replay never re-delivers an applied item.
    assert.deepEqual(drainInbox(journal, held), []);
    assert.equal((held.messages as unknown[]).length, 3);
    // A plain guide message (no escalation involved) keeps the same delivery shape.
    enqueueMessage(journal, held, "Steer: use the other tool.", "req-guide", { summary: "steer" });
    drainInbox(journal, held);
    const steer = (held.messages as Record<string, unknown>[]).at(-1)!;
    assert.equal(steer._coordination_summary, "steer");
  });

  it("prunes answered escalations only when the record is full", () => {
    const { journal, child } = fixture(base, "55".repeat(16));
    const cid = String(child().id);
    const items = Array.from({ length: 40 }, (_, index) => ({ id: "old-" + index, taskId: "task-full-1", question: "q" + index, digest: "d" + index, status: "answered", createdAt: index }));
    mkdirSync(join(journal.directory, "escalations"), { recursive: true });
    writeJournalRow(join(journal.directory, "escalations"), { id: cid, items });
    raiseEscalation(journal, child(), "One more question?", "req-new", "task-full-1");
    const stored = pendingEscalations(journal, child());
    assert.deepEqual(stored.map((item) => item.id), ["req-new"]);
  });
});

describe("coordinator sendMessage and collect wiring (F08.03)", () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-coordwiring-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  function wired(parent = SID) {
    const root = join(base, "ws", parent);
    mkdirSync(join(base, "state"), { recursive: true });
    const registry = new TaskRegistry();
    const session = { id: parent, root, messages: [], task_runs: [] };
    const coordinator = new TaskCoordinator(session, registry);
    const tid = TaskRegistry.newId();
    registry.record(tid, { parentSession: parent, agent: null, prompt: "p", root });
    registry.update(tid, { workerActive: true });
    coordinator.bindExecutor(async () => ({}), join(base, "state"));
    coordinator.records[tid] = { collected: false, turn: coordinator.turn };
    const journal = new ChildJournal(join(base, "state"), parent, { taskId: tid, root });
    const child = newChild({ parent, taskId: tid, root, system: "system", prompt: "p", agent: null, selection: {} });
    writeJournalRow(journal.directory, child);
    return { coordinator, registry, tid, journal, child: () => journal.findTask(tid) };
  }

  it("routes an escalation answer through sendMessage and ends the question", () => {
    const { coordinator, tid, journal, child } = wired();
    raiseEscalation(journal, child(), "Retry or abort?", "req-esc", tid);
    const outcome = coordinator.sendMessage({ task_id: tid, message: "Abort the run.", escalation_id: "req-esc" }, "req-ans");
    assert.equal(outcome.ok, true);
    assert.equal((outcome.escalation as Record<string, unknown>).status, "answered");
    assert.equal(outcome.delivery, "guide");
    // Idempotent replay of the same answer, no second queued message.
    const replay = coordinator.sendMessage({ task_id: tid, message: "Abort the run.", escalation_id: "req-esc" }, "req-ans");
    assert.equal((replay.escalation as Record<string, unknown>).replay, true);
    assert.equal(coordinator.pendingEscalationsFor(tid).length, 0);
  });

  it("keeps the authorization boundary outside the child's transcript", () => {
    const { coordinator, tid } = wired();
    const foreign = coordinator.sendMessage({ task_id: "task-belongs-elsewhere", message: "hi", requestId: "r" }, "r1");
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, "not_found");
    const malformed = coordinator.sendMessage({ task_id: "../escape", message: "hi", requestId: "r" }, "r2");
    assert.equal(malformed.reason, "invalid_task_id");
    // An inactive child is a message-admission refusal, not an authorization one.
    const { registry } = { registry: coordinator.registry };
    registry.finish(tid, { ok: true, summary: "", error: "", steps: 1 });
    const inactive = coordinator.sendMessage({ task_id: tid, message: "hi", requestId: "r" }, "r3");
    assert.equal(inactive.ok, false);
    assert.match(String(inactive.error), /active child/);
  });

  it("surfaces a blocked child's pending question through collect without misreporting completion", async () => {
    const { coordinator, tid, journal, child } = wired();
    raiseEscalation(journal, child(), "Which dataset?", "req-esc", tid);
    const outcome = await coordinator.collect({ task_ids: [tid], wait_seconds: 0 });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.pending, [tid]);
    assert.deepEqual(outcome.tasks, []);
    const escalations = outcome.escalations as Record<string, unknown>[];
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0]?.id, "req-esc");
    assert.equal(escalations[0]?.task_id, tid);
    // Foreign tasks never leak their escalations into this parent's collect.
    assert.deepEqual(coordinator.pendingEscalationsFor("task-not-mine"), []);
  });

  it("runs respond_to_coordinator only where the host bound the escalation port", async () => {
    const tool = respondToCoordinatorTool();
    // The child side only ever reads `escalationPort`; the rest of ToolEnv is the host's.
    const refused = await tool.run({ question: "Why?", requestId: "r" }, {} as never);
    assert.equal(refused.ok, false);
    assert.equal((refused.error as Record<string, unknown>).code, "agent_subagent_not_child");
    let raised: Record<string, unknown> | null = null;
    const port = { escalate: (question: string, requestId: string) => { raised = { question, requestId }; return { id: requestId, status: "pending" }; } };
    const accepted = await tool.run({ question: "Why?", requestId: "req-e" }, { escalationPort: port } as never);
    assert.equal(accepted.ok, true);
    assert.deepEqual(raised, { question: "Why?", requestId: "req-e" });
    assert.equal((accepted.data as Record<string, unknown>).status, "pending");
  });
});
