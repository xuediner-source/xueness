import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Row } from "../src/index.ts";
import {
  COMMAND_MERGE_BOUNDARIES, COMMAND_PRIORITY_ORDER, TURN_TRANSITION_TABLE, TurnCommandRouter, TurnPromptOwnership,
  commandPriority, type TurnCommand,
} from "../src/command-priority.ts";
import { canTransitionTurn } from "../src/turn-state.ts";
import { fixture } from "./fixtures.ts";
import { sessionsTurnRuntimeExtension } from "../../../plugins/sessions/src/turn-runtime.ts";

const command = (id: string, kind: TurnCommand["kind"], prompt = id): TurnCommand => ({ id, kind, prompt });

describe("command priority table (C-WFL-01)", () => {
  it("user actions outrank steering, which outranks background continuations", () => {
    assert.deepEqual(COMMAND_PRIORITY_ORDER, ["user_prompt", "start_now", "steer_guide", "task_notification", "goal_continuation"]);
    assert.ok(commandPriority("user_prompt") < commandPriority("goal_continuation"));
  });
  it("each kind has explicit merge boundaries", () => {
    assert.deepEqual(COMMAND_MERGE_BOUNDARIES.user_prompt, ["before_run"]);
    assert.deepEqual(COMMAND_MERGE_BOUNDARIES.start_now, ["before_run"]);
    assert.deepEqual(COMMAND_MERGE_BOUNDARIES.steer_guide, ["before_model_request", "before_final_response"]);
    assert.deepEqual(COMMAND_MERGE_BOUNDARIES.task_notification, ["after_run"]);
    assert.deepEqual(COMMAND_MERGE_BOUNDARIES.goal_continuation, ["after_run"]);
  });
  it("the formal transition table is the one turn-state enforces", () => {
    assert.equal(canTransitionTurn("idle", "processing_input"), true);
    assert.equal(canTransitionTurn("idle", "streaming"), false);
    assert.equal(canTransitionTurn("executing_tools", "awaiting_permission"), true);
    assert.equal(canTransitionTurn("completing", "streaming"), false);
    assert.deepEqual(TURN_TRANSITION_TABLE.completing, []);
  });
});

describe("TurnCommandRouter queue discipline", () => {
  it("orders by priority and keeps arrival order within one priority", () => {
    const router = new TurnCommandRouter();
    router.enqueue(command("goal-1", "goal_continuation"));
    router.enqueue(command("task-1", "task_notification"));
    router.enqueue(command("user-2", "user_prompt"));
    router.enqueue(command("user-1", "user_prompt"));
    router.enqueue(command("guide-1", "steer_guide"));
    assert.deepEqual(router.pending().map((item) => item.id), ["user-2", "user-1", "guide-1", "task-1", "goal-1"]);
  });
  it("enqueue is idempotent by id — never duplicates a user message", () => {
    const router = new TurnCommandRouter();
    router.enqueue(command("user-1", "user_prompt", "hello"));
    const again = router.enqueue(command("user-1", "user_prompt", "hello"));
    assert.equal(again.prompt, "hello");
    assert.equal(router.pending().length, 1);
  });
  it("start_now promotion jumps the queue without dropping or duplicating any message", () => {
    const router = new TurnCommandRouter();
    router.enqueue(command("user-1", "user_prompt"));
    router.enqueue(command("guide-1", "steer_guide"));
    router.enqueue(command("task-1", "task_notification"));
    router.enqueue(command("goal-1", "goal_continuation"));
    assert.equal(router.promote("task-1"), true);
    assert.deepEqual(router.pending().map((item) => item.id), ["task-1", "user-1", "guide-1", "goal-1"]);
    assert.deepEqual(router.pending().map((item) => item.kind), ["start_now", "user_prompt", "steer_guide", "goal_continuation"]);
    const ids = router.pending().map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, "no message lost or duplicated");
    assert.equal(router.promote("missing"), false);
  });
  it("admit dequeues only commands due at the boundary and resets reminders before running", () => {
    const router = new TurnCommandRouter();
    router.enqueue(command("user-1", "user_prompt"));
    router.enqueue(command("guide-1", "steer_guide"));
    router.setReminder("repeated tool call warning");
    assert.deepEqual(router.admit("before_model_request").map((item) => item.id), ["guide-1"]);
    assert.equal(router.reminder, null);
    assert.deepEqual(router.pending().map((item) => item.id), ["user-1"]);
    assert.deepEqual(router.admit("before_run").map((item) => item.id), ["user-1"]);
    assert.equal(router.activeCommandId, "user-1");
    router.setReminder("another warning");
    assert.deepEqual(router.admit("before_model_request"), []);
    assert.equal(router.reminder, "another warning", "no command runs, reminders persist");
  });
  it("draining settles the queue to idle and resets reminder state", () => {
    const router = new TurnCommandRouter();
    router.enqueue(command("user-1", "user_prompt"));
    router.enqueue(command("goal-1", "goal_continuation"));
    router.setReminder("stale reminder");
    router.admit("before_run");
    assert.deepEqual(router.drain("2026-10-25T00:00:00Z").map((item) => item.id), ["goal-1"]);
    assert.equal(router.idle, true);
    assert.equal(router.reminder, null);
    assert.equal(router.drainedAt, "2026-10-25T00:00:00Z");
    assert.deepEqual(router.snapshot().pending, []);
  });
});

describe("TurnPromptOwnership single-execution claims", () => {
  it("a prompt id belongs to at most one turn", () => {
    const ownership = new TurnPromptOwnership();
    assert.equal(ownership.claim("p1", "turn-1", "exec-1"), true);
    assert.equal(ownership.claim("p1", "turn-2", "exec-2"), false, "a second execution cannot claim it");
    assert.equal(ownership.claim("p1", "turn-1", "exec-1"), true, "the owner's claim is idempotent");
    assert.equal(ownership.claimOf("p1")!.turnId, "turn-1");
  });
  it("release frees the prompt; stale releases from another turn change nothing", () => {
    const ownership = new TurnPromptOwnership();
    ownership.claim("p1", "turn-1", "exec-1");
    assert.equal(ownership.release("p1", "turn-2"), false);
    assert.equal(ownership.release("p1", "turn-1"), true);
    assert.equal(ownership.claim("p1", "turn-2", "exec-2"), true);
    assert.equal(ownership.size, 1);
  });
  it("the router claims admitted commands through its ownership", () => {
    const router = new TurnCommandRouter();
    router.enqueue(command("user-1", "user_prompt"));
    router.admit("before_run");
    assert.equal(router.claimFor("user-1", "turn-1", "exec-1"), true);
    assert.equal(router.claimFor("user-1", "turn-9", "exec-9"), false);
    router.releaseActive("turn-1");
    assert.equal(router.ownership.claimOf("user-1"), undefined);
  });
});

describe("sessions turn runtime command routing", () => {
  it("claims the initiating prompt for one execution and drains to idle at settle", async () => {
    const phases: Row[] = [];
    const local = fixture([{ content: "done" }], [], {
      onEvent: (event) => { if (event.type === "turn_phase") phases.push(event); },
    });
    local.hooks.extensions = [sessionsTurnRuntimeExtension()];
    try {
      await local.runner.run(local.session);
      const queue = local.session.runtime_command_queue as Row;
      assert.ok(Array.isArray(queue.pending) && queue.pending.length === 0);
      assert.equal(queue.activeCommandId, null);
      assert.equal(typeof queue.drainedAt, "string");
      assert.equal(queue.reminder, null);
      const idle = phases.find((event) => event.phase === "idle");
      assert.ok(idle, "draining emits an idle turn_phase");
      assert.equal(idle.commandQueueIdle, true);
    } finally { local.close(); }
  });
});
