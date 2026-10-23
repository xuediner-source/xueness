import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentProvider, Row } from "../src/index.ts";
import { call, fixture } from "./fixtures.ts";
import { sessionsSteeringExtension } from "../../../plugins/sessions/src/steering-runtime.ts";
import { SteeringInbox } from "../../../plugins/sessions/src/steering.ts";
import { fingerprint } from "../../../plugins/sessions/src/queue-types.ts";
import { sessionsTurnRuntimeExtension } from "../../../plugins/sessions/src/turn-runtime.ts";

const sessionExtensions = () => [sessionsTurnRuntimeExtension(), sessionsSteeringExtension()];

async function assertLeaseReleased(local: ReturnType<typeof fixture>): Promise<void> {
  const lease = await local.store.lease(String(local.session.id));
  await lease.release();
}

function finalTurn(local: ReturnType<typeof fixture>): Row {
  const history = local.session.runtime_turn_history as Row[];
  assert.ok(Array.isArray(history) && history.length > 0);
  return history.at(-1)!;
}

describe("session turn runtime integration", () => {
  it("publishes one trace across a model-tool-model turn with final counts", async () => {
    const phases: Row[] = [];
    const responses: Row[] = [{ tool_calls: [call("turn-tool")] }, { content: "finished" }];
    let request = 0;
    const provider: AgentProvider = {
      async complete() { throw new Error("stream expected"); },
      async stream(_messages, _tools, observers) {
        observers?.onDelta?.(request === 0 ? "tool request" : "final response");
        return responses[request++]!;
      },
    };
    const local = fixture([], [{ ok: true, output: "tool output" }], {
      provider,
      onEvent: (event) => { if (event.type === "turn_phase") phases.push(event); },
    });
    local.hooks.extensions = [sessionsTurnRuntimeExtension()];
    const savedTurns: Row[] = [];
    const save = local.store.save.bind(local.store);
    local.store.save = async (session) => {
      await save(session);
      const turn = session.runtime_turn as Row | undefined;
      if (turn) savedTurns.push(structuredClone(turn));
    };
    try {
      await local.runner.run(local.session);
      const turn = finalTurn(local);
      const phaseNames = phases.map((event) => event.phase);
      for (const phase of ["processing_input", "awaiting_model_response", "streaming", "scheduling_tools", "aggregating_results", "completing"]) {
        assert.ok(phaseNames.includes(phase), `missing ${phase}: ${phaseNames.join(", ")}`);
      }
      const traceId = String(turn.traceId);
      assert.ok(traceId.length > 0);
      assert.ok(phases.every((event) => event.traceId === traceId));
      assert.ok(savedTurns.some((snapshot) => snapshot.phase === "streaming"), "stream deltas publish a streaming snapshot");
      assert.ok(savedTurns.every((snapshot) => snapshot.traceId === traceId));
      assert.equal(turn.id, "turn-1");
      assert.equal(turn.phase, "completing");
      assert.equal(turn.resultType, "success");
      assert.equal(turn.requestCount, 2);
      assert.equal(turn.toolCallCount, 1);
      assert.equal((turn.tools as Row[]).length, 1);
      assert.equal((turn.tools as Row[])[0]?.status, "completed");
      assert.equal(Object.keys(local.session.results as Row).length, 1);
      assert.equal(((local.session.results as Row)["turn-tool"] as Row).ok, true);
      assert.equal((local.session.messages as Row[]).filter((row) => row.role === "tool" && row.tool_call_id === "turn-tool").length, 1);
    } finally { local.close(); }
  });

  it("records cancellation, local error and step limit without success and releases each lease", async () => {
    let cancel: (() => void) | undefined;
    const cancelProvider: AgentProvider = {
      async complete() { cancel?.(); return { content: "late response" }; },
    };
    const cancelled = fixture([], [], { provider: cancelProvider });
    cancel = () => { cancelled.runner.cancel(String(cancelled.session.id)); };
    cancelled.hooks.extensions = [sessionsTurnRuntimeExtension()];
    try {
      await cancelled.runner.run(cancelled.session);
      assert.equal(cancelled.session.status, "stopped");
      assert.equal(finalTurn(cancelled).resultType, "cancelled");
      assert.notEqual(finalTurn(cancelled).resultType, "success");
      await assertLeaseReleased(cancelled);
    } finally { cancelled.close(); }

    const failed = fixture([], [], { provider: { async complete() { throw new Error("fixture provider failure"); } } });
    failed.hooks.extensions = [sessionsTurnRuntimeExtension()];
    try {
      await assert.rejects(failed.runner.run(failed.session), /fixture provider failure/);
      assert.equal(finalTurn(failed).resultType, "error_during_execution");
      assert.notEqual(finalTurn(failed).resultType, "success");
      await assertLeaseReleased(failed);
    } finally { failed.close(); }

    const limited = fixture([{ tool_calls: [call("limit-tool")] }], [{ ok: true, output: "done" }]);
    limited.hooks.extensions = [sessionsTurnRuntimeExtension()];
    try {
      await limited.runner.run(limited.session, { maxSteps: 1 });
      assert.equal(limited.session.pause_code, "step_limit_reached");
      assert.equal(finalTurn(limited).resultType, "paused");
      assert.notEqual(finalTurn(limited).resultType, "success");
      await assertLeaseReleased(limited);
    } finally { limited.close(); }
  });

  it("closes a missing cold-resume tool result as interrupted without replaying the old call", async () => {
    let sawInterruptedResult = false;
    const provider: AgentProvider = {
      async complete(messages) {
        const tool = messages.find((row) => row.role === "tool" && row.tool_call_id === "old-tool");
        assert.ok(tool, "projected request closes the old tool call");
        const result = JSON.parse(String(tool.content)) as Row;
        sawInterruptedResult = result.ok === false && (result.error as Row).code === "tool_interrupted";
        return { content: "resumed safely" };
      },
    };
    const local = fixture([], [], { provider });
    local.hooks.extensions = [sessionsTurnRuntimeExtension()];
    (local.session.messages as Row[]).push({ role: "assistant", content: "", tool_calls: [call("old-tool")] });
    try {
      await local.runner.run(local.session);
      const result = (local.session.results as Row)["old-tool"] as Row;
      assert.equal(sawInterruptedResult, true);
      assert.equal(result.ok, false);
      assert.equal((result.error as Row).code, "tool_interrupted");
      assert.equal((local.session.messages as Row[]).filter((row) => row.role === "tool" && row.tool_call_id === "old-tool").length, 1);
      assert.equal(local.effects(), 0);
      await assertLeaseReleased(local);
    } finally { local.close(); }
  });

  it("admits a guide during a text response after the assistant save and completes its same-turn receipt", async () => {
    let local!: ReturnType<typeof fixture>;
    let inbox!: SteeringInbox;
    let admitted = false;
    let receipt: Row | undefined;
    let requests = 0;
    const seen: Row[][] = [];
    const saves: number[] = [];
    const provider: AgentProvider = {
      async complete(messages) {
        seen.push(structuredClone(messages));
        if (requests++ === 0) {
          const turnId = String(local.session.active_turn_id);
          assert.equal(turnId, "turn-1");
          const admittedRow = await inbox.locked(String(local.session.id), () => inbox.admitLocked(
            String(local.session.id), "guide during response", turnId, "e".repeat(32), fingerprint("guide during response"),
          ));
          receipt = admittedRow[0]; admitted = true;
          return { content: "first answer" };
        }
        return { content: "answer with guide" };
      },
    };
    local = fixture([], [], { provider });
    inbox = new SteeringInbox(local.store);
    inbox.media.itemId = () => "d".repeat(32);
    const save = local.store.save.bind(local.store);
    local.store.save = async (session) => {
      await save(session);
      const messages = session.messages as Row[];
      if (!messages.some((row) => row.role === "assistant" && row.content === "first answer")) return;
      saves.push(messages.filter((row) => row._input_kind === "guide").length);
    };
    local.hooks.extensions = sessionExtensions();
    try {
      await local.runner.run(local.session);
      assert.equal(admitted, true);
      assert.equal(receipt?.id, "d".repeat(32));
      assert.ok(saves.indexOf(0) >= 0 && saves.indexOf(0) < saves.indexOf(1), `assistant/guide saves: ${saves}`);
      assert.equal(requests, 2);
      assert.equal(seen[1]?.some((row) => row.role === "user" && row._input_id === receipt?.id), true);
      const guide = (local.session.messages as Row[]).find((row) => row._input_id === receipt?.id);
      assert.equal(guide?._turn_id, "turn-1");
      const snapshot = await inbox.snapshot(String(local.session.id));
      const completed = (snapshot.queue_history as Row[]).find((row) => row.id === receipt?.id);
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.targetTurnId, "turn-1");
    } finally { local.close(); }
  });

  it("delivers only one queued guide per model boundary and leaves the next for the next request", async () => {
    const seen: Row[][] = [];
    let request = 0;
    const responses: Row[] = [{ tool_calls: [call("guide-boundary-tool")] }, { content: "finished" }];
    const provider: AgentProvider = {
      async complete(messages) { seen.push(structuredClone(messages)); return responses[request++]!; },
    };
    const local = fixture([], [], {
      provider,
      toolBridge: { async call() { return { ok: true, output: "tool done" }; }, async callAll() { return []; } },
    });
    const inbox = new SteeringInbox(local.store);
    const ids = ["b".repeat(32), "c".repeat(32)];
    const requestIds = ["d".repeat(32), "e".repeat(32)];
    let nextId = 0;
    inbox.media.itemId = () => ids[nextId++]!;
    await inbox.locked(String(local.session.id), async () => {
      for (const [index, text] of ["guide one", "guide two"].entries()) {
        await inbox.admitLocked(String(local.session.id), text, "turn-1", requestIds[index]!, fingerprint(text));
      }
    });
    local.hooks.extensions = sessionExtensions();
    try {
      await local.runner.run(local.session);
      const guideCounts = seen.map((messages) => messages.filter((row) => row._input_kind === "guide").length);
      assert.deepEqual(guideCounts, [1, 2]);
      assert.equal((local.session.messages as Row[]).filter((row) => row._input_kind === "guide").length, 2);
      const snapshot = await inbox.snapshot(String(local.session.id));
      assert.deepEqual((snapshot.queue_history as Row[]).filter((row) => ids.includes(String(row.id))).map((row) => row.status), ["completed", "completed"]);
      assert.equal((local.session.messages as Row[]).filter((row) => row.role === "tool" && row.tool_call_id === "guide-boundary-tool").length, 1);
    } finally { local.close(); }
  });

  it("emits tool_result only after a successful journal save, and never on save failure", async () => {
    const callId = "saved-tool";
    let local!: ReturnType<typeof fixture>;
    const durableEvents: boolean[] = [];
    local = fixture([{ tool_calls: [call(callId)] }, { content: "finished" }], [{ ok: true, output: "saved" }], {
      onEvent(event) {
        if (event.type !== "tool_result" || event.id !== callId) return;
        const saved = JSON.parse(readFileSync(local.store.pathFor(String(local.session.id)), "utf8")) as Row;
        const message = (saved.messages as Row[]).find((row) => row.role === "tool" && row.tool_call_id === callId);
        const result = message ? JSON.parse(String(message.content)) as Row : {};
        durableEvents.push(result.ok === true && ((saved.results as Row)[callId] as Row)?.ok === true);
      },
    });
    local.hooks.extensions = [sessionsTurnRuntimeExtension()];
    try {
      await local.runner.run(local.session);
      assert.deepEqual(durableEvents, [true]);
    } finally { local.close(); }

    const failedCallId = "failed-save-tool";
    let failed!: ReturnType<typeof fixture>;
    const emitted: Row[] = [];
    failed = fixture([{ tool_calls: [call(failedCallId)] }], [{ ok: true, output: "not durably saved" }], {
      onEvent(event) { if (event.type === "tool_result" && event.id === failedCallId) emitted.push(event); },
    });
    failed.hooks.extensions = [sessionsTurnRuntimeExtension()];
    const save = failed.store.save.bind(failed.store);
    let rejectOnce = true;
    failed.store.save = async (session) => {
      const hasToolMessage = (session.messages as Row[]).some((row) => row.role === "tool" && row.tool_call_id === failedCallId);
      if (rejectOnce && hasToolMessage) { rejectOnce = false; throw new Error("tool result journal save failed"); }
      await save(session);
    };
    try {
      await assert.rejects(failed.runner.run(failed.session), /tool result journal save failed/);
      assert.deepEqual(emitted, []);
      await assertLeaseReleased(failed);
    } finally { failed.close(); }
  });
});
