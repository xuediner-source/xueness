/**
 * H12.06 — Desktop polish acceptance pack.
 *
 * One offline pack over the desktop renderer surface assembled by the H12
 * rounds: the H05.03/04 review drawer (`critic-review-drawer.ts`) and the
 * H12.05 harness status strip (`harness-status-strip.ts`), both fed by the
 * real H02.05 critic-solver, H02.06 trajectory recorder and H06 profiler.
 *
 * Three sections, all green without any network or wall clock:
 *  - visual pack: every string the renderer would paint is well-formed —
 *    strip lines, diff rows, timeline items — with no NaN/undefined leakage;
 *  - state pack: the interactive state machines hold — strip traffic lights
 *    walk monotonically as usage grows, drawer decisions are idempotent and
 *    never mutate prior snapshots, replay focus lands on the right round;
 *  - integration pack: one scripted solver/critic run drives recorder and
 *    profiler together, and a full second replay is byte-identical.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBenchProfiler, type ProfiledCall, type ProfileSummary } from "../../../plugins/deepseek_harness/src/bench/profiler.ts";
import { runCriticSolver, type HarnessModel, type ModelExchange, type TokenUsage } from "../../../plugins/deepseek_harness/src/builtins/critic-solver.ts";
import { TrajectoryRecorder, memorySink } from "../../../plugins/deepseek_harness/src/builtins/trajectory-recorder.ts";
import { CriticReviewDrawer, diffLines, diffStat, TrajectoryLinkedDrawer } from "../src/renderer/critic-review-drawer.ts";
import { buildStatusStrip } from "../src/renderer/harness-status-strip.ts";

const FIXED_NOW = (): Date => new Date("2026-10-26T10:00:00.000Z");

const patchJson = (path: string, content: string, summary = "fix"): string =>
  `proposing\n{"path": "${path}", "content": ${JSON.stringify(content)}, "summary": "${summary}"}`;

const reviewJson = (verdict: "accept" | "reject", reasons: string[] = ["looks right"]): string =>
  `{"verdict": "${verdict}", "score": ${verdict === "accept" ? 0.9 : 0.2}, "reasons": ${JSON.stringify(reasons)}}`;

/** Scripted model: plays back queued replies with deterministic DeepSeek-style usage. */
function scripted(id: string, replies: string[]): HarnessModel {
  let next = 0;
  return {
    id,
    async complete(request): Promise<{ text: string; usage: TokenUsage }> {
      const text = replies[Math.min(next, replies.length - 1)] ?? "";
      next += 1;
      const promptTokens = 1000 + request.callIndex;
      const cachedTokens = request.callIndex > 1 ? 800 : 0;
      return { text, usage: { promptTokens, completionTokens: 40, cachedTokens } };
    },
  };
}

/**
 * One scripted harness run: solver proposes, critic accepts on round 2 after
 * one rejection. The same `onExchange` tap feeds the trajectory recorder and
 * the H06 profiler, exactly like the desktop host would.
 */
interface ScriptedRun {
  jsonl: string;
  summary: ProfileSummary;
  usageByModel: Map<string, TokenUsage[]>;
  exchangeCount: number;
}

async function scriptedRun(): Promise<ScriptedRun> {
  const recorder = new TrajectoryRecorder({ session: "polish-1", sink: memorySink(), now: FIXED_NOW });
  recorder.sessionStarted({ task: "polish the harness", solverModel: "deepseek-chat", criticModel: "deepseek-reasoner" });
  const profiler = createBenchProfiler();
  const usageByModel = new Map<string, TokenUsage[]>();
  let exchangeCount = 0;
  const tap = (exchange: ModelExchange): void => {
    exchangeCount += 1;
    recorder.exchange(exchange);
    usageByModel.set(exchange.modelId, [...(usageByModel.get(exchange.modelId) ?? []), exchange.usage]);
    const call: ProfiledCall = {
      label: `round-${exchange.round}-${exchange.role}`,
      model: exchange.modelId,
      session: `polish-${exchange.role}`,
      request: { messages: [{ role: exchange.role, content: exchange.prompt }] },
      usage: exchange.usage,
    };
    profiler.record(call);
  };
  const solver = scripted("deepseek-chat", [patchJson("src/app.ts", "line1\nline2 fixed\nline3"), patchJson("src/app.ts", "line1\nline2 really fixed\nline3")]);
  const critic = scripted("deepseek-reasoner", [reviewJson("reject"), reviewJson("accept")]);
  const result = await runCriticSolver({
    task: "polish the harness",
    solver,
    critic,
    files: { "src/app.ts": "line1\nline2\nline3" },
    maxRounds: 2,
    onExchange: tap,
  });
  for (const round of result.rounds) recorder.verdict({ round: round.round, verdict: round.review.verdict, path: round.patch?.path ?? null });
  return { jsonl: recorder.close(), summary: profiler.summary(), usageByModel, exchangeCount };
}

/** Every string a renderer paints must be free of NaN/undefined/null leakage. */
function assertCleanText(value: string, what: string): void {
  assert.ok(!/\b(NaN|undefined|null|Infinity)\b/.test(value), `${what} leaks a non-value: ${value}`);
}

const ROW_PATTERN = /^(?:idle|[^\s]+ \d+(?:\.\d+)?(?:k|M)? tok.* (?:idle|ok|warn|critical|exhausted))$/;

describe("H12.06 desktop polish acceptance pack", () => {
  describe("visual pack", () => {
    it("strip rows and the joined line are well-formed across every state", async () => {
      const { summary } = await scriptedRun();
      for (const [budget, expectedState] of [[4000, "exhausted"], [4200, "critical"], [5000, "warn"], [50_000, "ok"]] as const) {
        const strip = buildStatusStrip(summary, { quota: { totalTokens: budget } });
        assert.equal(strip.overall.state, expectedState);
        assert.ok(strip.render().startsWith("[harness] "));
        assert.equal(strip.render().split(" | ").length, strip.rows.length);
        for (const row of strip.rows) {
          assert.match(row.text, ROW_PATTERN, `budget ${budget} row ${row.model}`);
          assertCleanText(row.text, `strip row ${row.model}`);
        }
        assertCleanText(strip.render(), `strip line @${budget}`);
      }
    });

    it("the idle strip paints exactly one leg", () => {
      const strip = buildStatusStrip(createBenchProfiler().summary(), {});
      assert.equal(strip.render(), "[harness] harness idle");
      assertCleanText(strip.render(), "idle strip");
    });

    it("drawer diff rows carry verbatim lines and stats that add up", async () => {
      const { jsonl } = await scriptedRun();
      const drawer = new TrajectoryLinkedDrawer({
        task: "polish the harness",
        result: {
          verdict: "accept",
          patch: { path: "src/app.ts", content: "line1\nline2 really fixed\nline3", summary: "fix" },
          rounds: [],
          exhausted: false,
        },
        files: { "src/app.ts": "line1\nline2\nline3" },
        trajectory: jsonl,
        now: FIXED_NOW,
      });
      const rows = diffLines("line1\nline2\nline3", "line1\nline2 really fixed\nline3");
      assert.deepEqual(
        rows.map((row) => [row.kind, row.text]),
        [
          ["context", "line1"],
          ["del", "line2"],
          ["add", "line2 really fixed"],
          ["context", "line3"],
        ],
      );
      const stat = diffStat(rows);
      assert.deepEqual(stat, { added: 1, removed: 1, unchanged: 2 });
      assert.equal(stat.added + stat.removed + stat.unchanged, rows.length);
      for (const view of drawer.rounds) assert.deepEqual(diffStat(view.diff), view.diffStat);
      for (const row of rows) assertCleanText(row.text, "diff row");
    });

    it("timeline items render with a stable shape and no leakage", async () => {
      const { jsonl } = await scriptedRun();
      const drawer = new TrajectoryLinkedDrawer({
        task: "polish the harness",
        result: {
          verdict: "accept",
          patch: null,
          rounds: [],
          exhausted: false,
        },
        files: {},
        trajectory: jsonl,
        now: FIXED_NOW,
      });
      const { summary } = drawer;
      assert.equal(summary.session, "polish-1");
      assert.equal(summary.task, "polish the harness");
      assert.equal(summary.solverModel, "deepseek-chat");
      assert.equal(summary.criticModel, "deepseek-reasoner");
      assert.ok(summary.exchanges >= 4);
      assert.deepEqual(summary.rounds, [1, 2]);
      for (const item of summary.timeline) {
        assert.ok(["session", "exchange", "verdict"].includes(item.type));
        assert.ok(item.at.startsWith("2026-10-26T10:00:00"));
        assert.ok(typeof item.index === "number" && item.index >= 0);
        assertCleanText(`${item.type} ${item.role ?? ""} ${item.modelId ?? ""}`, "timeline item");
      }
    });
  });

  describe("state pack", () => {
    it("strip traffic lights walk monotonically as usage accumulates", () => {
      const profiler = createBenchProfiler();
      // 850 tokens per call against a 40k budget: each step moves usage ~2.1%,
      // so the walk visits every band — ok, warn (>=0.8), critical (>=0.95),
      // exhausted (>=1) — in order and never backwards.
      const budget = 40_000;
      const seen: string[] = [];
      for (let call = 1; call <= 60; call += 1) {
        profiler.record({
          label: `call-${call}`,
          model: "deepseek-chat",
          session: "walk",
          request: { messages: [{ role: "user", content: "x".repeat(1000 * call) }] },
          usage: { promptTokens: 800, completionTokens: 50 },
        });
        const state = buildStatusStrip(profiler.summary(), { quota: { totalTokens: budget } }).overall.state;
        if (seen.at(-1) !== state) seen.push(state);
        if (state === "exhausted") break;
      }
      assert.deepEqual(seen, ["ok", "warn", "critical", "exhausted"]);
    });

    it("drawer decisions are idempotent and never rewrite history", async () => {
      const { jsonl } = await scriptedRun();
      const result = {
        verdict: "accept" as const,
        patch: { path: "src/app.ts", content: "line1\nline2 really fixed\nline3", summary: "fix" },
        rounds: [
          {
            round: 1,
            patch: { path: "src/app.ts", content: "line1\nline2 fixed\nline3", summary: "fix" },
            review: { verdict: "reject" as const, score: 0.2, reasons: ["no"], malformed: false },
          },
          {
            round: 2,
            patch: { path: "src/app.ts", content: "line1\nline2 really fixed\nline3", summary: "fix" },
            review: { verdict: "accept" as const, score: 0.9, reasons: ["yes"], malformed: false },
          },
        ],
        exhausted: false,
      };
      const drawer = new CriticReviewDrawer({ task: "polish the harness", result, files: { "src/app.ts": "line1\nline2\nline3" }, now: FIXED_NOW });
      assert.ok(drawer.pending);
      const before = drawer.appliedFiles();
      const decision = drawer.accept();
      assert.equal(drawer.decision, decision);
      assert.equal(drawer.accept(), decision); // idempotent: the first decision stands
      assert.equal(drawer.reject(), decision);
      assert.ok(!drawer.pending);
      const applied = drawer.appliedFiles();
      assert.equal(applied["src/app.ts"], "line1\nline2 really fixed\nline3");
      assert.equal(before["src/app.ts"], "line1\nline2\nline3"); // pre-decision snapshot untouched
      assert.notEqual(drawer.appliedFiles(), applied); // fresh snapshot each call
    });

    it("selection and replay focus land on the round that produced them", async () => {
      const { jsonl } = await scriptedRun();
      const result = await runCriticSolver({
        task: "polish the harness",
        solver: scripted("deepseek-chat", [patchJson("src/app.ts", "line1\nline2 really fixed\nline3")]),
        critic: scripted("deepseek-reasoner", [reviewJson("accept")]),
        files: { "src/app.ts": "line1\nline2\nline3" },
        maxRounds: 1,
      });
      const drawer = new TrajectoryLinkedDrawer({ task: "polish the harness", result, files: { "src/app.ts": "line1\nline2\nline3" }, trajectory: jsonl, now: FIXED_NOW });
      assert.equal(drawer.selectRound(99), null); // unknown rounds leave selection alone
      const firstExchange = drawer.summary.timeline.find((item) => item.type === "exchange" && item.round !== null);
      assert.ok(firstExchange);
      const located = drawer.focus(firstExchange!);
      assert.ok(located);
      assert.equal(located!.round, firstExchange!.round);
      assert.equal(drawer.activeRound?.round, firstExchange!.round);
      const session = drawer.summary.timeline.find((item) => item.type === "session");
      assert.ok(session);
      assert.equal(drawer.focus(session!), null); // session events map to no patch decision
      // Decision points resolve exactly when the drawer's own result has that round.
      for (const point of drawer.decisionPoints()) {
        const known = drawer.rounds.some((view) => view.round === point.round);
        assert.equal(drawer.locateDecision(point.round ?? 0) !== null, known);
      }
    });
  });

  describe("integration pack (offline, deterministic)", () => {
    it("one scripted run feeds recorder and profiler consistently", async () => {
      const run = await scriptedRun();
      assert.equal(run.exchangeCount, run.usageByModel.get("deepseek-chat")!.length + run.usageByModel.get("deepseek-reasoner")!.length);
      const strip = buildStatusStrip(run.summary, { quota: { totalTokens: 6000 } });
      const solverRow = strip.byModel("deepseek-chat");
      const criticRow = strip.byModel("deepseek-reasoner");
      assert.ok(solverRow && criticRow);
      const sum = (list: TokenUsage[]): number => list.reduce((total, usage) => total + usage.promptTokens + usage.completionTokens, 0);
      assert.equal(solverRow!.totalTokens, sum(run.usageByModel.get("deepseek-chat")!));
      assert.equal(criticRow!.totalTokens, sum(run.usageByModel.get("deepseek-reasoner")!));
      assert.equal(strip.overall.totalTokens, solverRow!.totalTokens + criticRow!.totalTokens);
      assert.ok(solverRow!.cacheHitRate >= 0 && solverRow!.cacheHitRate <= 1);
      assert.ok(criticRow!.cacheHitRate >= 0 && criticRow!.cacheHitRate <= 1);
    });

    it("a full second replay is byte-identical (no network, no wall clock)", async () => {
      const first = await scriptedRun();
      const second = await scriptedRun();
      assert.equal(first.jsonl, second.jsonl);
      assert.equal(first.exchangeCount, second.exchangeCount);
      const line = (run: ScriptedRun): string => buildStatusStrip(run.summary, { quota: { totalTokens: 6000 } }).render();
      assert.equal(line(first), line(second));
      const strip = buildStatusStrip(first.summary, { quota: { totalTokens: 6000 } });
      assertCleanText(strip.render(), "replayed strip");
      const drawerOne = new TrajectoryLinkedDrawer({
        task: "polish the harness",
        result: { verdict: "accept", patch: null, rounds: [], exhausted: false },
        files: {},
        trajectory: first.jsonl,
        now: FIXED_NOW,
      });
      const drawerTwo = new TrajectoryLinkedDrawer({
        task: "polish the harness",
        result: { verdict: "accept", patch: null, rounds: [], exhausted: false },
        files: {},
        trajectory: second.jsonl,
        now: FIXED_NOW,
      });
      assert.deepEqual(drawerOne.summary, drawerTwo.summary);
      assert.equal(drawerOne.decisionPoints().length, drawerTwo.decisionPoints().length);
    });
  });
});
