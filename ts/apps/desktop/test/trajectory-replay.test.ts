import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runCriticSolver,
  type HarnessModel,
  type ModelResponse,
} from "../../../plugins/deepseek_harness/src/builtins/critic-solver.ts";
import { TrajectoryRecorder, memorySink } from "../../../plugins/deepseek_harness/src/builtins/trajectory-recorder.ts";
import {
  buildReplayFrames,
  describeFrame,
  TrajectoryScrubber,
} from "../src/renderer/trajectory-replay.ts";

/** Model that plays back queued replies; mirrors the H05.03 test adapter. */
function scripted(id: string, replies: string[]): HarnessModel {
  let next = 0;
  return {
    id,
    async complete(request): Promise<ModelResponse> {
      const text = replies[Math.min(next, replies.length - 1)] ?? "";
      next += 1;
      return { text, usage: { promptTokens: 1000 + request.callIndex, completionTokens: 40, cachedTokens: request.callIndex > 1 ? 900 : 0 } };
    },
  };
}

const patchJson = (path: string, content: string, summary = "fix"): string =>
  `proposing\n{"path": "${path}", "content": ${JSON.stringify(content)}, "summary": "${summary}"}`;

const reviewJson = (verdict: "accept" | "reject", reasons: string[] = ["looks right"]): string =>
  `{"verdict": "${verdict}", "score": ${verdict === "accept" ? 0.9 : 0.2}, "reasons": ${JSON.stringify(reasons)}}`;

/** Recorded 2-round session: r1 rejected, r2 accepted; verdicts logged after all exchanges. */
async function recordedSession() {
  const sink = memorySink();
  const recorder = new TrajectoryRecorder({ session: "sess-replay", sink, now: () => new Date("2026-10-26T10:00:00.000Z") });
  recorder.sessionStarted({ task: "fix the bug", solverModel: "solver-x", criticModel: "critic-y" });
  const solver = scripted("solver-x", [patchJson("src/app.ts", "fixed body", "round one"), patchJson("src/app.ts", "better body", "round two")]);
  const critic = scripted("critic-y", [reviewJson("reject", ["not yet"]), reviewJson("accept", ["good"])]);
  const result = await runCriticSolver({ task: "fix the bug", solver, critic, files: { "src/app.ts": "old body" }, maxRounds: 2, onExchange: (e) => recorder.exchange(e) });
  for (const round of result.rounds) recorder.verdict({ round: round.round, verdict: round.review.verdict, path: round.patch?.path ?? null });
  return recorder.close();
}

describe("H12.03 replay frames match recorded events", () => {
  it("builds one frame per event with session metadata carried forward", async () => {
    const jsonl = await recordedSession();
    const frames = buildReplayFrames({ trajectory: jsonl, files: { "src/app.ts": "old body" } });
    assert.equal(frames.length, 7); // 1 session + 4 exchanges + 2 verdicts
    assert.deepEqual(
      frames.map((frame) => frame.kind),
      ["session", "exchange", "exchange", "exchange", "exchange", "verdict", "verdict"],
    );
    const session = frames[0]!;
    assert.equal(session.session, "sess-replay");
    assert.equal(session.task, "fix the bug");
    assert.equal(session.round, null);
    for (const frame of frames.slice(1)) {
      assert.equal(frame.session, "sess-replay");
      assert.equal(frame.solverModel, "solver-x");
      assert.equal(frame.criticModel, "critic-y");
    }
  });

  it("tracks rounds, roles, pending proposals and verdicts per frame", async () => {
    const jsonl = await recordedSession();
    const frames = buildReplayFrames({ trajectory: jsonl, files: { "src/app.ts": "old body" } });
    const [session, solver1, critic1, solver2, critic2, verdict1, verdict2] = frames;
    assert.equal(session!.pendingProposal, null);
    assert.equal(solver1!.round, 1);
    assert.equal(solver1!.role, "solver");
    assert.deepEqual(solver1!.pendingProposal, { round: 1, path: "src/app.ts", summary: "round one" });
    assert.equal(critic1!.role, "critic");
    assert.deepEqual(critic1!.pendingProposal, { round: 1, path: "src/app.ts", summary: "round one" });
    assert.deepEqual(solver2!.pendingProposal, { round: 2, path: "src/app.ts", summary: "round two" });
    assert.equal(verdict1!.verdict, "reject");
    assert.deepEqual(verdict1!.rejectedRounds, [1]);
    assert.deepEqual(verdict1!.acceptedRounds, []);
    assert.equal(verdict1!.pendingProposal, null);
    assert.equal(verdict1!.lastVerdict, "reject");
    assert.equal(verdict2!.verdict, "accept");
    assert.deepEqual(verdict2!.acceptedRounds, [2]);
    assert.deepEqual(verdict2!.rejectedRounds, [1]);
    assert.equal(critic2!.lastVerdict, null); // no verdict recorded yet at that point
    assert.equal(verdict1!.lastVerdict, "reject");
  });

  it("applies accepted patches to the workspace snapshot only from the accept verdict on", async () => {
    const jsonl = await recordedSession();
    const frames = buildReplayFrames({ trajectory: jsonl, files: { "src/app.ts": "old body" } });
    for (const frame of frames.slice(0, 6)) assert.equal(frame.files["src/app.ts"], "old body");
    assert.equal(frames[6]!.files["src/app.ts"], "better body"); // round 2 accepted
  });

  it("flags solver proposals and verdicts as decision points", async () => {
    const jsonl = await recordedSession();
    const frames = buildReplayFrames({ trajectory: jsonl });
    assert.deepEqual(
      frames.map((frame) => frame.decisionPoint),
      [false, true, false, true, false, true, true],
    );
  });

  it("handles an empty or blank trajectory", () => {
    assert.deepEqual(buildReplayFrames({ trajectory: "" }), []);
    assert.deepEqual(buildReplayFrames({ trajectory: "\n \nnot json\n" }), []);
  });
});

describe("H12.03 scrubber seek/step", () => {
  it("seeks to an arbitrary frame; out-of-range seeks leave the cursor untouched", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl, files: { "src/app.ts": "old body" } });
    assert.equal(scrubber.length, 7);
    assert.equal(scrubber.position, 0);
    const sought = scrubber.seek(6);
    assert.ok(sought);
    assert.equal(sought.kind, "verdict");
    assert.equal(scrubber.position, 6);
    assert.equal(scrubber.atEnd, true);
    assert.equal(scrubber.seek(7), null);
    assert.equal(scrubber.seek(-1), null);
    assert.equal(scrubber.seek(1.5), null);
    assert.equal(scrubber.position, 6);
    assert.equal(scrubber.seek(0)?.kind, "session");
    assert.equal(scrubber.atStart, true);
  });

  it("steps forward and back, clamping at both timeline ends", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl });
    assert.equal(scrubber.step()?.kind, "exchange");
    assert.equal(scrubber.step()?.kind, "exchange");
    assert.equal(scrubber.position, 2);
    assert.equal(scrubber.stepBack()?.index, 1);
    assert.equal(scrubber.step(3)?.index, 4);
    assert.equal(scrubber.step(-99)?.index, 0);
    assert.equal(scrubber.step(99)?.index, 6); // clamped at the last frame
    assert.equal(scrubber.step()?.index, 6);
    assert.equal(scrubber.stepBack()?.index, 5);
  });

  it("stepping from the start reproduces every recorded frame exactly", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl, files: { "src/app.ts": "old body" } });
    const seen = [scrubber.current];
    while (!scrubber.atEnd) seen.push(scrubber.step());
    assert.deepEqual(seen, scrubber.frames);
    // seek and step agree on each position
    scrubber.reset();
    for (let index = 0; index < scrubber.length; index += 1) {
      assert.deepEqual(scrubber.seek(index), scrubber.frames[index]);
    }
  });

  it("state at a seeked position matches the recorded frame (files, rounds, verdict)", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl, files: { "src/app.ts": "old body" } });
    const frame = scrubber.seek(6)!;
    assert.equal(frame.files["src/app.ts"], "better body");
    assert.deepEqual(frame.acceptedRounds, [2]);
    // stepping back from there never leaks the future state backwards
    const before = scrubber.stepBack()!;
    assert.equal(before.files["src/app.ts"], "old body");
    assert.deepEqual(before.acceptedRounds, []);
  });

  it("jumps between decision points in both directions and parks when none remain", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl });
    scrubber.reset();
    assert.equal(scrubber.nextDecision()?.index, 1);
    assert.equal(scrubber.nextDecision()?.index, 3);
    assert.equal(scrubber.nextDecision()?.index, 5);
    assert.equal(scrubber.nextDecision()?.index, 6);
    assert.equal(scrubber.nextDecision(), null); // nothing after the last verdict
    assert.equal(scrubber.position, 6);
    assert.equal(scrubber.previousDecision()?.index, 5);
    assert.equal(scrubber.previousDecision()?.index, 3);
    assert.equal(scrubber.previousDecision()?.index, 1);
    assert.equal(scrubber.previousDecision(), null); // nothing before the first proposal
    assert.equal(scrubber.position, 1);
  });

  it("resets to the first recorded frame", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl });
    scrubber.seek(5);
    assert.equal(scrubber.reset()?.index, 0);
    assert.equal(scrubber.atStart, true);
  });

  it("ignores non-integer steps so the cursor can never leave the timeline", async () => {
    const jsonl = await recordedSession();
    const scrubber = new TrajectoryScrubber({ trajectory: jsonl });
    assert.equal(scrubber.step(1.5), null);
    assert.equal(scrubber.position, 0);
    assert.equal(scrubber.step(NaN), null);
    assert.equal(scrubber.position, 0);
    // the cursor still walks normally afterwards
    assert.equal(scrubber.step()?.index, 1);
    assert.equal(scrubber.step(-99)?.index, 0);
    assert.equal(scrubber.atStart, true);
  });

  it("keeps a garbled verdict frame from deciding anything", () => {
    const jsonl = [
      { type: "session", at: "2026-10-26T10:00:00.000Z", session: "s", task: "t", solverModel: "a", criticModel: "b" },
      { type: "exchange", at: "2026-10-26T10:00:01.000Z", session: "s", round: 1, role: "solver", modelId: "a", callIndex: 0, prompt: "p", response: patchJson("f.ts", "new"), usage: { promptTokens: 1, completionTokens: 1 } },
      { type: "verdict", at: "2026-10-26T10:00:02.000Z", session: "s", round: 1 },
    ].map((event) => JSON.stringify(event)).join("\n");
    const frames = buildReplayFrames({ trajectory: jsonl, files: { "f.ts": "old" } });
    const verdict = frames[2]!;
    assert.equal(verdict.kind, "verdict");
    assert.equal(verdict.verdict, null);
    assert.equal(verdict.lastVerdict, null);
    assert.deepEqual(verdict.acceptedRounds, []);
    assert.deepEqual(verdict.rejectedRounds, []);
    assert.equal(verdict.files["f.ts"], "old"); // no accept was recorded, so nothing is applied
    assert.deepEqual(verdict.pendingProposal, { round: 1, path: "f.ts", summary: "fix" }); // still unreviewed
  });

  it("degrades safely on an empty timeline", () => {
    const scrubber = new TrajectoryScrubber({ trajectory: "" });
    assert.equal(scrubber.length, 0);
    assert.equal(scrubber.empty, true);
    assert.equal(scrubber.current, null);
    assert.equal(scrubber.seek(0), null);
    assert.equal(scrubber.step(), null);
    assert.equal(scrubber.stepBack(), null);
    assert.equal(scrubber.reset(), null);
    assert.equal(scrubber.nextDecision(), null);
    assert.equal(scrubber.previousDecision(), null);
  });

  it("labels frames for the scrubber UI", async () => {
    const jsonl = await recordedSession();
    const frames = buildReplayFrames({ trajectory: jsonl });
    assert.equal(describeFrame(frames[0]!), "session sess-replay — fix the bug");
    assert.equal(describeFrame(frames[1]!), "round 1 · solver");
    assert.equal(describeFrame(frames[2]!), "round 1 · critic");
    assert.equal(describeFrame(frames[5]!), "round 1 · verdict reject");
    assert.equal(describeFrame(frames[6]!), "round 2 · verdict accept");
  });
});
