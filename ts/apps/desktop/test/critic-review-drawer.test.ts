import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runCriticSolver,
  type CriticSolverResult,
  type HarnessModel,
  type ModelResponse,
  type SolverRound,
} from "../../../plugins/deepseek_harness/src/builtins/critic-solver.ts";
import { TrajectoryRecorder, memorySink } from "../../../plugins/deepseek_harness/src/builtins/trajectory-recorder.ts";
import {
  CriticDrawerController,
  CriticReviewDrawer,
  diffLines,
  diffStat,
  summarizeTrajectory,
  TrajectoryLinkedDrawer,
} from "../src/renderer/critic-review-drawer.ts";

/** Model that plays back queued replies; mirrors the H02.05 test adapter. */
function scripted(id: string, replies: string[]): HarnessModel {
  let next = 0;
  return {
    id,
    async complete(request): Promise<ModelResponse> {
      const text = replies[Math.min(next, replies.length - 1)] ?? "";
      next += 1;
      const promptTokens = 1000 + request.callIndex;
      const cachedTokens = request.callIndex > 1 ? 1000 : 0;
      return { text, usage: { promptTokens, completionTokens: 40, cachedTokens } };
    },
  };
}

const patchJson = (path: string, content: string, summary = "fix"): string =>
  `proposing\n{"path": "${path}", "content": ${JSON.stringify(content)}, "summary": "${summary}"}`;

const reviewJson = (verdict: "accept" | "reject", reasons: string[] = ["looks right"]): string =>
  `{"verdict": "${verdict}", "score": ${verdict === "accept" ? 0.9 : 0.2}, "reasons": ${JSON.stringify(reasons)}}`;

function acceptedResult(): CriticSolverResult {
  return {
    verdict: "accept",
    patch: { path: "src/app.ts", content: "line1\nline2 patched\nline3", summary: "fix line2" },
    rounds: [
      {
        round: 1,
        patch: { path: "src/app.ts", content: "line1\nline2 patched\nline3", summary: "fix line2" },
        review: { verdict: "accept", score: 0.9, reasons: ["task complete"], malformed: false },
      },
    ],
    exhausted: false,
  };
}

describe("H05.03 diff rendering", () => {
  it("diffs baseline vs proposal into del/add/context rows", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc\nd");
    assert.deepEqual(
      rows.map((row) => `${row.kind}:${row.text}`),
      ["context:a", "del:b", "add:B", "context:c", "add:d"],
    );
    assert.deepEqual(diffStat(rows), { added: 2, removed: 1, unchanged: 2 });
  });

  it("diffs creation (empty baseline) and deletion (empty proposal)", () => {
    assert.deepEqual(diffLines("", "x\ny"), [{ kind: "add", text: "x" }, { kind: "add", text: "y" }]);
    assert.deepEqual(diffLines("x\ny", ""), [{ kind: "del", text: "x" }, { kind: "del", text: "y" }]);
  });

  it("diffs identical content to pure context", () => {
    const rows = diffLines("same\nbody", "same\nbody");
    assert.ok(rows.every((row) => row.kind === "context"));
  });
});

describe("H05.03 review drawer view model", () => {
  const baseline = { "src/app.ts": "line1\nline2\nline3" };

  it("builds round views with the Solver/Critic diff against the baseline", () => {
    const drawer = new CriticReviewDrawer({ task: "patch line2", result: acceptedResult(), files: baseline });
    assert.equal(drawer.pending, true);
    assert.equal(drawer.rounds.length, 1);
    const view = drawer.activeRound;
    assert.ok(view);
    assert.equal(view.patch?.path, "src/app.ts");
    assert.deepEqual(
      view.diff.map((row) => `${row.kind}:${row.text}`),
      ["context:line1", "del:line2", "add:line2 patched", "context:line3"],
    );
    assert.equal(view.review.verdict, "accept");
    assert.deepEqual(view.diffStat, { added: 1, removed: 1, unchanged: 2 });
  });

  it("renders an explanation-only round (null content) with an empty diff", () => {
    const result: CriticSolverResult = {
      verdict: "reject",
      patch: { path: "src/app.ts", content: null, summary: "cannot fix" },
      rounds: [{ round: 1, patch: { path: "src/app.ts", content: null, summary: "cannot fix" }, review: { verdict: "reject", score: 0, reasons: ["no patch"], malformed: false } }],
      exhausted: false,
    };
    const drawer = new CriticReviewDrawer({ task: "do anything", result, files: baseline });
    assert.deepEqual(drawer.activeRound?.diff, []);
    assert.deepEqual(drawer.activeRound?.diffStat, { added: 0, removed: 0, unchanged: 0 });
  });

  it("one-key accept applies the displayed patch immutably and is idempotent", () => {
    const frozen = new Date("2026-10-26T00:00:00.000Z");
    const drawer = new CriticReviewDrawer({ task: "patch line2", result: acceptedResult(), files: baseline, now: () => frozen });
    const decision = drawer.accept();
    assert.deepEqual(decision, { kind: "accepted", round: 1, patch: drawer.rounds[0]?.patch ?? null, at: frozen.toISOString() });
    assert.equal(drawer.pending, false);
    assert.equal(drawer.accept().at, decision.at);
    assert.equal(drawer.reject().kind, "accepted");
    assert.equal(drawer.appliedFiles()["src/app.ts"], "line1\nline2 patched\nline3");
    assert.equal(baseline["src/app.ts"], "line1\nline2\nline3");
  });

  it("one-key reject keeps the workspace snapshot and is idempotent", () => {
    const drawer = new CriticReviewDrawer({ task: "patch line2", result: acceptedResult(), files: baseline });
    const decision = drawer.reject();
    assert.equal(decision.kind, "rejected");
    assert.equal(decision.patch?.path, "src/app.ts");
    assert.equal(drawer.accept().kind, "rejected");
    assert.deepEqual(drawer.appliedFiles(), baseline);
  });

  it("accepts from the selected round; unknown rounds do not move the selection", () => {
    const round1: SolverRound = { round: 1, patch: { path: "a.ts", content: "one", summary: "r1" }, review: { verdict: "reject", score: 0.1, reasons: ["no"], malformed: false } };
    const round2: SolverRound = { round: 2, patch: { path: "a.ts", content: "two", summary: "r2" }, review: { verdict: "accept", score: 0.8, reasons: ["yes"], malformed: false } };
    const drawer = new CriticReviewDrawer({ task: "multi", result: { verdict: "accept", patch: round2.patch, rounds: [round1, round2], exhausted: false }, files: { "a.ts": "zero" } });
    assert.equal(drawer.activeRound?.round, 2);
    assert.equal(drawer.selectRound(7), null);
    assert.equal(drawer.activeRound?.round, 2);
    assert.ok(drawer.selectRound(1));
    const decision = drawer.accept();
    assert.equal(decision.round, 1);
    assert.equal(drawer.appliedFiles()["a.ts"], "one");
  });

  it("requires a non-empty task", () => {
    assert.throws(() => new CriticReviewDrawer({ task: "  ", result: acceptedResult(), files: {} }), /non-empty task/);
  });
});

describe("H05.04 trajectory linkage", () => {
  async function recordedSession() {
    const sink = memorySink();
    const recorder = new TrajectoryRecorder({ session: "sess-42", sink, now: () => new Date("2026-10-26T10:00:00.000Z") });
    recorder.sessionStarted({ task: "fix the bug", solverModel: "solver-x", criticModel: "critic-y" });
    const solver = scripted("solver-x", [patchJson("src/app.ts", "fixed body", "round one"), patchJson("src/app.ts", "better body", "round two")]);
    const critic = scripted("critic-y", [reviewJson("reject", ["not yet"]), reviewJson("accept", ["good"])]);
    const result = await runCriticSolver({ task: "fix the bug", solver, critic, files: { "src/app.ts": "old body" }, maxRounds: 2, onExchange: (e) => recorder.exchange(e) });
    for (const round of result.rounds) recorder.verdict({ round: round.round, verdict: round.review.verdict, path: round.patch?.path ?? null });
    return { jsonl: recorder.close(), result };
  }

  it("summarizes an H02.06 trajectory with models, rounds and cache hit rate", async () => {
    const { jsonl } = await recordedSession();
    const summary = summarizeTrajectory(jsonl);
    assert.equal(summary.session, "sess-42");
    assert.equal(summary.task, "fix the bug");
    assert.equal(summary.solverModel, "solver-x");
    assert.equal(summary.criticModel, "critic-y");
    assert.equal(summary.exchanges, 4);
    assert.deepEqual(summary.rounds, [1, 2]);
    assert.ok(summary.hitRate > 0 && summary.hitRate <= 1);
    assert.equal(summary.timeline.length, 7); // 1 session + 4 exchanges + 2 verdicts
    assert.equal(summary.timeline[0]?.type, "session");
    assert.equal(summary.timeline.at(-1)?.type, "verdict");
  });

  it("locates a patch decision from a replayed trajectory event", async () => {
    const { jsonl, result } = await recordedSession();
    const drawer = new TrajectoryLinkedDrawer({ task: "fix the bug", result, files: { "src/app.ts": "old body" }, trajectory: jsonl });
    const verdictRound2 = drawer.summary.timeline.filter((item) => item.type === "verdict").at(-1);
    assert.ok(verdictRound2);
    assert.equal(verdictRound2.round, 2);
    const location = drawer.focus(verdictRound2);
    assert.ok(location);
    assert.equal(location.round, 2);
    assert.equal(location.verdict, "accept");
    assert.equal(location.path, "src/app.ts");
    assert.equal(location.patch?.content, "better body");
    assert.deepEqual(location.review?.reasons, ["good"]);
    assert.deepEqual(location.diff, [{ kind: "del", text: "old body" }, { kind: "add", text: "better body" }]);
    assert.equal(drawer.activeRound?.round, 2);
    const accepted = drawer.accept();
    assert.equal(accepted.kind, "accepted");
    assert.equal(drawer.appliedFiles()["src/app.ts"], "better body");
  });

  it("focuses solver exchange events too, and ignores session events", async () => {
    const { jsonl, result } = await recordedSession();
    const drawer = new TrajectoryLinkedDrawer({ task: "fix the bug", result, files: { "src/app.ts": "old body" }, trajectory: jsonl });
    const solverRound1 = drawer.summary.timeline.find((item) => item.type === "exchange" && item.round === 1 && item.role === "solver");
    assert.ok(solverRound1);
    const location = drawer.focus(solverRound1);
    assert.ok(location);
    assert.equal(location.round, 1);
    assert.equal(location.verdict, "reject");
    assert.equal(location.patch?.content, "fixed body");
    assert.equal(drawer.focus(drawer.summary.timeline[0]!), null);
    assert.equal(drawer.locateDecision(9), null);
  });

  it("lists replay decision points: verdicts plus solver proposals", async () => {
    const { jsonl, result } = await recordedSession();
    const drawer = new TrajectoryLinkedDrawer({ task: "fix the bug", result, files: {}, trajectory: jsonl });
    const points = drawer.decisionPoints();
    assert.equal(points.length, 4); // 2 solver proposals + 2 verdicts
    assert.deepEqual(
      points.map((item) => `${item.type}:${item.round}`),
      ["exchange:1", "exchange:2", "verdict:1", "verdict:2"],
    );
  });
});

/** Deferred harness for driving the controller's async loads in tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("H12.04 drawer visual states", () => {
  const emptyResult: CriticSolverResult = { verdict: "reject", patch: null, rounds: [], exhausted: false };

  it("starts idle with no drawer painted", () => {
    const controller = new CriticDrawerController({ task: "t", load: () => Promise.resolve(acceptedResult()) });
    assert.equal(controller.state, "idle");
    assert.equal(controller.drawer, null);
    assert.equal(controller.error, null);
    assert.equal(controller.attempts, 0);
    assert.deepEqual(controller.status, { state: "idle", message: "No critic review loaded yet.", retryable: false });
  });

  it("shows the loading state while the fetch is in flight, then ready", async () => {
    const gate = deferred<CriticSolverResult>();
    const controller = new CriticDrawerController({ task: "patch line2", files: { "src/app.ts": "line1\nline2\nline3" }, load: () => gate.promise });
    const pending = controller.refresh();
    assert.equal(controller.state, "loading");
    assert.equal(controller.drawer, null);
    assert.equal(controller.status.retryable, false);
    gate.resolve(acceptedResult());
    const drawer = await pending;
    assert.ok(drawer);
    assert.equal(controller.state, "ready");
    assert.equal(controller.drawer, drawer);
    assert.equal(controller.status.message, "Critic review ready.");
    assert.equal(drawer.rounds.length, 1);
    assert.equal(controller.attempts, 1);
  });

  it("shows the error state with the failure message and recovers on retry", async () => {
    let fail = true;
    const controller = new CriticDrawerController({
      task: "patch line2",
      load: () => (fail ? Promise.reject(new Error("harness offline")) : Promise.resolve(acceptedResult())),
    });
    assert.equal(await controller.refresh(), null);
    assert.equal(controller.state, "error");
    assert.equal(controller.error, "harness offline");
    assert.equal(controller.status.message, "harness offline");
    assert.equal(controller.status.retryable, true);
    assert.equal(controller.drawer, null);
    fail = false;
    const drawer = await controller.refresh();
    assert.ok(drawer);
    assert.equal(controller.state, "ready");
    assert.equal(controller.error, null);
    assert.equal(controller.attempts, 2);
  });

  it("renders non-Error rejections and blank messages as a generic error", async () => {
    const controller = new CriticDrawerController({ task: "t", load: () => Promise.reject("   ") });
    assert.equal(await controller.refresh(), null);
    assert.equal(controller.state, "error");
    assert.equal(controller.error, "Failed to load critic review.");
  });

  it("covers the empty state: loaded result with zero rounds", async () => {
    const controller = new CriticDrawerController({ task: "nothing to review", files: { "src/app.ts": "keep" }, load: () => Promise.resolve(emptyResult) });
    const drawer = await controller.refresh();
    assert.ok(drawer);
    assert.equal(controller.state, "empty");
    assert.equal(controller.status.message, "Critic finished without review rounds.");
    assert.equal(controller.status.retryable, true);
    assert.equal(drawer.activeRound, null);
    assert.deepEqual(drawer.appliedFiles(), { "src/app.ts": "keep" });
    const decision = drawer.accept();
    assert.equal(decision.round, 0);
    assert.equal(decision.patch, null);
    assert.equal(drawer.appliedFiles()["src/app.ts"], "keep");
  });

  it("keeps the last loaded drawer during a reload and after a failed reload", async () => {
    const gate = deferred<CriticSolverResult>();
    let first = true;
    const controller = new CriticDrawerController({
      task: "patch line2",
      files: { "src/app.ts": "line1\nline2\nline3" },
      load: () => (first ? ((first = false), Promise.resolve(acceptedResult())) : gate.promise),
    });
    const initial = await controller.refresh();
    assert.equal(controller.state, "ready");
    const reloading = controller.refresh();
    assert.equal(controller.state, "loading");
    assert.equal(controller.drawer, initial); // stale review stays painted while reloading
    gate.reject(new Error("reload failed"));
    assert.equal(await reloading, null);
    assert.equal(controller.state, "error");
    assert.equal(controller.drawer, initial); // an open review is never blanked by a failed reload
    assert.equal(initial?.appliedFiles()["src/app.ts"], "line1\nline2\nline3");
  });

  it("shares one in-flight load between concurrent refresh calls", async () => {
    const gate = deferred<CriticSolverResult>();
    let calls = 0;
    const controller = new CriticDrawerController({ task: "t", load: () => { calls += 1; return gate.promise; } });
    const a = controller.refresh();
    const b = controller.refresh();
    assert.equal(calls, 1);
    gate.resolve(acceptedResult());
    assert.equal(await a, await b);
    assert.equal(controller.attempts, 1);
  });

  it("treats a synchronously throwing loader as a normal load failure", async () => {
    const controller = new CriticDrawerController({ task: "t", load: () => { throw new Error("loader blew up"); } });
    assert.equal(await controller.refresh(), null); // rejects nowhere: awaited value is null
    assert.equal(controller.state, "error");
    assert.equal(controller.error, "loader blew up");
    assert.equal(controller.status.retryable, true);
    assert.equal(controller.attempts, 1);
  });

  it("requires a non-empty task like the drawer it wraps", () => {
    assert.throws(() => new CriticDrawerController({ task: "", load: () => Promise.resolve(acceptedResult()) }), /non-empty task/);
  });
});
