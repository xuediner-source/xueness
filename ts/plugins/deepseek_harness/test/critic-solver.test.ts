import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { extractJson, parseCriticReview, parseSolverPatch, runCriticSolver, type HarnessModel, type ModelResponse } from "../src/builtins/critic-solver.ts";
import { analyzeTrajectory, fileTrajectoryRecorder, memorySink, parseTrajectory, TrajectoryRecorder } from "../src/builtins/trajectory-recorder.ts";

/** Model that plays back queued replies and records the prompts it saw. */
function scripted(id: string, replies: string[]): HarnessModel & { prompts: string[] } {
  const prompts: string[] = [];
  let next = 0;
  return {
    id,
    prompts,
    async complete(request): Promise<ModelResponse> {
      prompts.push(request.prompt);
      const text = replies[Math.min(next, replies.length - 1)] ?? "";
      next += 1;
      const promptTokens = 1000 + request.callIndex;
      const cachedTokens = request.callIndex > 1 ? 1000 : 0;
      return { text, usage: { promptTokens, completionTokens: 40, cachedTokens } };
    },
  };
}

const patchJson = (content: string, summary = "fix"): string =>
  `Here is the fix.\n{"path": "src/app.ts", "content": ${JSON.stringify(content)}, "summary": "${summary}"}`;

describe("critic-solver parsing", () => {
  it("extracts the last balanced JSON object, ignoring earlier braces and prose", () => {
    const text = 'noise {"a":1} more {"verdict":"accept","score":{"nested":"}"},"reasons":[]} trailing';
    assert.equal((extractJson(text) as { verdict?: string }).verdict, "accept");
    assert.equal(extractJson("no json here"), null);
  });

  it("keeps string-embedded braces and escaped quotes from breaking extraction", () => {
    const tricky = [
      { payload: { path: "a.ts", content: "if (x) { open", summary: "s" }, why: "unbalanced { inside a string" },
      { payload: { path: "a.ts", content: "s = \"a\\\"}\";", summary: "s" }, why: "escaped quote before a brace" },
      { payload: { path: "a.ts", content: "path = \"C:\\\\\"; }", summary: "s" }, why: "escaped backslash before a quote" },
    ];
    for (const { payload, why } of tricky) {
      assert.deepEqual(extractJson(`prose {x} first\n${JSON.stringify(payload)}`), payload, why);
    }
    const critic = { verdict: "reject", score: 0.1, reasons: ["say \"}\""] };
    assert.deepEqual(extractJson(`x ${JSON.stringify(critic)}`), critic);
  });

  it("parses a solver patch and rejects unsafe or malformed paths", () => {
    const patch = parseSolverPatch(patchJson("body"));
    assert.deepEqual(patch, { path: "src/app.ts", content: "body", summary: "fix" });
    assert.equal(parseSolverPatch('{"path": "/etc/passwd", "content": "x"}'), null);
    assert.equal(parseSolverPatch('{"path": "../escape", "content": "x"}'), null);
    assert.equal(parseSolverPatch('{"summary": "no path"}'), null);
  });

  it("treats a malformed critic reply as a malformed rejection", () => {
    const review = parseCriticReview("I refuse to answer in JSON");
    assert.equal(review.verdict, "reject");
    assert.equal(review.malformed, true);
    const badVerdict = parseCriticReview('{"verdict": "maybe", "score": 0.5}');
    assert.equal(badVerdict.verdict, "reject");
    assert.equal(badVerdict.malformed, true);
    const good = parseCriticReview('{"verdict": "accept", "score": 0.9, "reasons": ["ok", 5]}');
    assert.deepEqual(good, { verdict: "accept", score: 0.9, reasons: ["ok"], malformed: false });
  });
});

describe("critic-solver orchestration", () => {
  it("accepts a patch the critic approves on the first round", async () => {
    const solver = scripted("solver-1", [patchJson("const a = 1;")]);
    const critic = scripted("critic-1", ['{"verdict": "accept", "score": 0.95, "reasons": ["complete"]}']);
    const result = await runCriticSolver({ task: "initialize a", solver, critic, files: { "src/app.ts": "" } });
    assert.equal(result.verdict, "accept");
    assert.equal(result.exhausted, false);
    assert.equal(result.patch?.content, "const a = 1;");
    assert.equal(result.rounds.length, 1);
    assert.ok(solver.prompts[0]!.includes("initialize a"));
    assert.ok(solver.prompts[0]!.includes("--- src/app.ts ---"));
    assert.ok(critic.prompts[0]!.includes("src/app.ts"));
  });

  it("feeds critic reasons back to the solver and stops on acceptance", async () => {
    const solver = scripted("solver-1", [patchJson("v1"), patchJson("v2")]);
    const critic = scripted("critic-1", ['{"verdict": "reject", "score": 0.2, "reasons": ["missing export"]}', '{"verdict": "accept", "score": 0.9, "reasons": []}']);
    const result = await runCriticSolver({ task: "export a", solver, critic });
    assert.equal(result.verdict, "accept");
    assert.equal(result.rounds.length, 2);
    assert.ok(solver.prompts[1]!.includes("missing export"));
    assert.equal(result.patch?.content, "v2");
  });

  it("returns the last proposal with exhausted=true when the budget runs out", async () => {
    const solver = scripted("solver-1", [patchJson("only")]);
    const critic = scripted("critic-1", ['{"verdict": "reject", "score": 0.1, "reasons": ["still wrong"]}']);
    const result = await runCriticSolver({ task: "task", solver, critic, maxRounds: 2 });
    assert.equal(result.verdict, "reject");
    assert.equal(result.exhausted, true);
    assert.equal(result.rounds.length, 2);
    assert.equal(result.patch?.content, "only");
  });

  it("reports exhausted when the final round's critic reply was malformed", async () => {
    const solver = scripted("solver-1", [patchJson("only")]);
    const critic = scripted("critic-1", ["I cannot review this."]);
    const result = await runCriticSolver({ task: "task", solver, critic, maxRounds: 2 });
    assert.equal(result.verdict, "reject");
    assert.equal(result.rounds.at(-1)?.review.malformed, true);
    assert.equal(result.exhausted, true);
  });

  it("records every exchange for the trajectory and reports usage", async () => {
    const solver = scripted("solver-1", [patchJson("x")]);
    const critic = scripted("critic-1", ['{"verdict": "accept", "score": 1, "reasons": []}']);
    const exchanges: Array<{ role: string; round: number; cachedTokens: number }> = [];
    await runCriticSolver({
      task: "t",
      solver,
      critic,
      onExchange: (exchange) => exchanges.push({ role: exchange.role, round: exchange.round, cachedTokens: exchange.usage.cachedTokens ?? 0 }),
    });
    assert.deepEqual(exchanges.map((item) => item.role), ["solver", "critic"]);
    assert.deepEqual(exchanges.map((item) => item.round), [1, 1]);
    assert.deepEqual(exchanges.map((item) => item.cachedTokens), [0, 1000]);
  });

  it("refuses an empty task or a non-positive round budget", async () => {
    const solver = scripted("s", [""]);
    const critic = scripted("c", [""]);
    await assert.rejects(runCriticSolver({ task: "  ", solver, critic }), /non-empty task/);
    await assert.rejects(runCriticSolver({ task: "t", solver, critic, maxRounds: 0 }), /maxRounds/);
  });

  it("keeps the shared prefix byte-identical across rounds for KV reuse", async () => {
    const solver = scripted("solver-1", [patchJson("v1"), patchJson("v2")]);
    const critic = scripted("critic-1", ['{"verdict": "reject", "score": 0, "reasons": ["no"]}', '{"verdict": "accept", "score": 1, "reasons": []}']);
    await runCriticSolver({ task: "stable task", solver, critic });
    const firstNewline = (text: string): number => text.indexOf("Previous reviews:");
    const cut = (text: string): string => text.slice(0, firstNewline(text));
    assert.equal(cut(solver.prompts[0]!), cut(solver.prompts[1]!));
  });
});

describe("trajectory recorder", () => {
  const clock = (): Date => new Date("2026-10-26T00:00:00Z");

  it("writes one JSON object per line with session, exchange and verdict events", () => {
    const recorder = new TrajectoryRecorder({ session: "s1", sink: memorySink(), now: clock });
    recorder.sessionStarted({ task: "t", solverModel: "solver-1", criticModel: "critic-1" });
    recorder.exchange({ round: 1, role: "solver", modelId: "solver-1", callIndex: 1, prompt: "p", response: "r", usage: { promptTokens: 100, completionTokens: 5, cachedTokens: 0 } });
    recorder.verdict({ round: 1, verdict: "accept", path: "src/app.ts" });
    const text = recorder.close();
    const events = text.trim().split("\n").map((line) => JSON.parse(line) as { type: string; at: string; session: string });
    assert.deepEqual(events.map((event) => event.type), ["session", "exchange", "verdict"]);
    assert.ok(events.every((event) => event.at === "2026-10-26T00:00:00.000Z" && event.session === "s1"));
  });

  it("refuses an empty session id and writes nothing after close", () => {
    assert.throws(() => new TrajectoryRecorder({ session: " " }), /session id/);
    const recorder = new TrajectoryRecorder({ session: "s", now: clock });
    recorder.close();
    assert.throws(() => recorder.verdict({ round: 1, verdict: "accept", path: null }), /closed/);
  });

  it("round-trips through a real JSONL file in the state area", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-harness-"));
    try {
      const path = join(dir, "trajectory.jsonl");
      const recorder = fileTrajectoryRecorder(path, "file-session");
      recorder.exchange({ round: 1, role: "critic", modelId: "critic-1", callIndex: 2, prompt: "p", response: "r", usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 10 } });
      recorder.close();
      const events = parseTrajectory(readFileSync(path, "utf8"));
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "exchange");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips blank and torn lines when parsing", () => {
    const text = '{"type":"verdict","at":"x","session":"s","round":1,"verdict":"accept","path":null}\n\n{torn\n';
    assert.equal(parseTrajectory(text).length, 1);
  });
});

describe("kv hit-rate analysis", () => {
  const line = (modelId: string, role: string, callIndex: number, promptTokens: number, cachedTokens: number): string =>
    JSON.stringify({ type: "exchange", at: "x", session: "s", round: 1, role, modelId, callIndex, prompt: "p", response: "r", usage: { promptTokens, completionTokens: 1, cachedTokens } });

  it("aggregates hit-rate overall, per model and per role", () => {
    const analysis = analyzeTrajectory([
      line("solver-1", "solver", 1, 1000, 0),
      line("solver-1", "solver", 2, 1000, 1000),
      line("critic-1", "critic", 3, 500, 250),
    ].join("\n"));
    assert.equal(analysis.calls, 3);
    assert.equal(analysis.promptTokens, 2500);
    assert.equal(analysis.cachedTokens, 1250);
    assert.equal(analysis.hitRate, 0.5);
    assert.equal(analysis.uncachedPromptTokens, 1250);
    assert.equal(analysis.byModel["solver-1"]!.hitRate, 0.5);
    assert.equal(analysis.byModel["critic-1"]!.hitRate, 0.5);
    assert.equal(analysis.byRole["solver"]!.coldCalls, 1);
    assert.equal(analysis.byRole["solver"]!.fullyCached, 1);
    assert.deepEqual(analysis.callsList.map((call) => call.hitRate), [0, 1, 0.5]);
  });

  it("treats missing or negative usage numbers as zero instead of failing", () => {
    const bad = JSON.stringify({ type: "exchange", at: "x", session: "s", round: 1, role: "solver", modelId: "m", callIndex: 1, prompt: "p", response: "r", usage: { promptTokens: -5, cachedTokens: "n/a" } });
    const analysis = analyzeTrajectory(bad);
    assert.equal(analysis.calls, 1);
    assert.equal(analysis.promptTokens, 0);
    assert.equal(analysis.hitRate, 0);
  });

  it("reports an empty analysis for a trajectory without exchanges", () => {
    const analysis = analyzeTrajectory('{"type":"verdict","at":"x","session":"s","round":1,"verdict":"accept","path":null}');
    assert.equal(analysis.calls, 0);
    assert.deepEqual(analysis.byModel, {});
    assert.deepEqual(analysis.byRole, {});
  });
});
