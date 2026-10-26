/** H10.04: optimizer loop stops on budget and never mutates outside the sandbox. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import type { BenchRunReport, BenchRunSummary } from "../src/bench/runner.ts";
import type { VerifySummary } from "../src/builtins/auto-verify.ts";
import { foldFitness, type FitnessEvaluation, type OptimizerGenome } from "../src/optimizer/fitness.ts";
import {
  genomeInsideSandbox,
  resolveInsideSandbox,
  runOptimizerLoop,
  type OptimizerSandbox,
} from "../src/optimizer/loop.ts";

const benchOf = (ok: number, failed: number, ticks: number): BenchRunReport => {
  const summary: BenchRunSummary = { total: ok + failed, ok, failed, totalTicks: ticks, ranking: [] };
  return { results: [], summary };
};

const evaluationOf = (id: string, ok: number, failed: number, ticks: number, verifyPassed = true): FitnessEvaluation => {
  const benchReport = benchOf(ok, failed, ticks);
  const verifySummary: VerifySummary = { passed: verifyPassed, outcomes: [], summary: "synthetic" };
  return { genomeId: id, breakdown: foldFitness(benchReport, verifySummary), benchReport, verifySummary };
};

/** Scripted candidate source: pops one genome per call; empty pops mean null. */
const scriptMutator = (script: readonly OptimizerGenome[]) => {
  let index = 0;
  return () => script[index++] ?? null;
};

/** Scripted evaluator keyed by genome id, recording the call order. */
const scriptEvaluator = (scores: Record<string, FitnessEvaluation>, log: string[]) => async (g: OptimizerGenome) => {
  log.push(`evaluate:${g.id}`);
  return scores[g.id] ?? evaluationOf(g.id, 0, 1, 0);
};

/** In-memory sandbox: records apply/revert and can flag a stray write. */
const recordingSandbox = (root: string, log: string[]): OptimizerSandbox => ({
  root,
  apply: (g) => {
    log.push(`apply:${g.id}`);
  },
  revert: () => {
    log.push("revert");
  },
});

const genomeOf = (id: string, paths: readonly string[] = []): OptimizerGenome => ({ id, prompt: `p:${id}`, paths });

describe("resolveInsideSandbox (H10.04)", () => {
  const root = "/tmp/opt-sandbox";

  it("accepts relative paths under the root and the root itself", () => {
    assert.deepEqual(resolveInsideSandbox(root, "skills/alpha.md"), { inside: true, resolved: resolve(root, "skills/alpha.md") });
    assert.equal(resolveInsideSandbox(root, ".").inside, true);
  });

  it("accepts absolute paths already inside the root and rejects outside ones", () => {
    assert.equal(resolveInsideSandbox(root, "/tmp/opt-sandbox/skills/beta.md").inside, true);
    assert.equal(resolveInsideSandbox(root, "/tmp/other/x.md").inside, false);
    assert.equal(resolveInsideSandbox(root, "/tmp/opt-sandbox-evil/x.md").inside, false);
  });

  it("rejects traversal that escapes the root", () => {
    assert.equal(resolveInsideSandbox(root, "../escape.md").inside, false);
    assert.equal(resolveInsideSandbox(root, "skills/../../escape.md").inside, false);
    assert.equal(resolveInsideSandbox(root, "skills/../ok.md").inside, true);
  });

  it("genomeInsideSandbox requires every declared path inside", () => {
    const sandbox = recordingSandbox(root, []);
    assert.equal(genomeInsideSandbox(genomeOf("g", []), sandbox), true);
    assert.equal(genomeInsideSandbox(genomeOf("g", ["skills/a.md"]), sandbox), true);
    assert.equal(genomeInsideSandbox(genomeOf("g", ["skills/a.md", "../out.md"]), sandbox), false);
  });
});

describe("runOptimizerLoop budget semantics (H10.04)", () => {
  it("stops exactly on the iteration budget", async () => {
    const log: string[] = [];
    const candidates = [genomeOf("c1"), genomeOf("c2"), genomeOf("c3"), genomeOf("c4")];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator(candidates),
      evaluate: scriptEvaluator(
        {
          base: evaluationOf("base", 2, 0, 100),
          c1: evaluationOf("c1", 2, 0, 50),
          c2: evaluationOf("c2", 2, 0, 10),
          c3: evaluationOf("c3", 2, 0, 5),
          c4: evaluationOf("c4", 2, 0, 1),
        },
        log,
      ),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 2, evaluations: 10 },
    });
    assert.equal(result.stopReason, "budget_iterations");
    assert.equal(result.iterations, 2);
    assert.equal(result.evaluations, 3);
    assert.equal(result.best.id, "c2");
    assert.equal(result.history.length, 3);
    assert.deepEqual(
      result.history.map((s) => [s.genomeId, s.accepted]),
      [["base", true], ["c1", true], ["c2", true]],
    );
    // best genome is re-applied once at the end, after the last revert
    assert.equal(log.filter((l) => l === "apply:c2").length, 2);
    assert.ok(log.indexOf("revert") < log.lastIndexOf("apply:c2"));
  });

  it("stops on the evaluation budget counting the baseline evaluation", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("c1"), genomeOf("c2")]),
      evaluate: scriptEvaluator({ base: evaluationOf("base", 1, 0, 10), c1: evaluationOf("c1", 2, 0, 5) }, log),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 10, evaluations: 2 },
    });
    assert.equal(result.stopReason, "budget_evaluations");
    assert.equal(result.evaluations, 2);
    assert.equal(result.iterations, 1);
    assert.equal(result.best.id, "c1");
  });

  it("refuses to apply a candidate when the next evaluation would exceed the budget", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("c1"), genomeOf("c2")]),
      evaluate: scriptEvaluator({ base: evaluationOf("base", 1, 0, 10), c1: evaluationOf("c1", 1, 0, 10), c2: evaluationOf("c2", 1, 0, 10) }, log),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 10, evaluations: 2 },
    });
    assert.equal(result.stopReason, "budget_evaluations");
    assert.equal(log.filter((l) => l.startsWith("apply:")).length, 1); // only c1
    assert.ok(!log.includes("apply:c2"));
  });

  it("stops on the wall-clock budget via the injected clock", async () => {
    let ticks = 0;
    const now = (): number => ticks;
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("c1"), genomeOf("c2"), genomeOf("c3")]),
      evaluate: async (g) => {
        ticks += 100; // each evaluation burns 100ms of wall clock
        log.push(`evaluate:${g.id}`);
        return evaluationOf(g.id, 1, 0, 10);
      },
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 10, evaluations: 10, wallMs: 250 },
      now,
    });
    assert.equal(result.stopReason, "budget_wall");
    assert.equal(result.evaluations, 3); // baseline + 2 cycles, third crosses 250ms
    assert.equal(result.elapsedMs, 300);
  });

  it("stops with mutation_exhausted when the mutator runs out of moves", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: () => null,
      evaluate: scriptEvaluator({ base: evaluationOf("base", 1, 0, 10) }, log),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 5, evaluations: 5 },
    });
    assert.equal(result.stopReason, "mutation_exhausted");
    assert.equal(result.iterations, 0);
    assert.equal(result.best.id, "base");
    assert.deepEqual(log, ["evaluate:base"]); // nothing applied, nothing re-applied
  });

  it("stops after patience consecutive non-improving candidates", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("c1"), genomeOf("c2"), genomeOf("c3")]),
      evaluate: scriptEvaluator(
        {
          base: evaluationOf("base", 2, 0, 10),
          c1: evaluationOf("c1", 1, 0, 10),
          c2: evaluationOf("c2", 1, 0, 10),
          c3: evaluationOf("c3", 3, 0, 10),
        },
        log,
      ),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 10, evaluations: 10 },
      patience: 2,
    });
    assert.equal(result.stopReason, "no_improvement");
    assert.equal(result.iterations, 2);
    assert.equal(result.best.id, "base");
  });

  it("rejects invalid budgets, sandboxes and initial genomes up front", async () => {
    const base = { initial: genomeOf("base"), mutate: () => null, evaluate: async () => evaluationOf("base", 1, 0, 0), sandbox: recordingSandbox("/tmp/sb", []) };
    await assert.rejects(() => runOptimizerLoop({ ...base, budget: { iterations: 0, evaluations: 1 } }), /iterations/);
    await assert.rejects(() => runOptimizerLoop({ ...base, budget: { iterations: 1, evaluations: 0 } }), /evaluations/);
    await assert.rejects(() => runOptimizerLoop({ ...base, budget: { iterations: 1, evaluations: 1, wallMs: 0 } }), /wallMs/);
    await assert.rejects(() => runOptimizerLoop({ ...base, budget: { iterations: 1, evaluations: 1 }, patience: 0 }), /patience/);
    await assert.rejects(
      () =>
        runOptimizerLoop({
          ...base,
          budget: { iterations: 1, evaluations: 1 },
          sandbox: { root: "/tmp/sb", apply: undefined as never, revert: () => {} },
        }),
      /apply and revert/,
    );
    await assert.rejects(
      () => runOptimizerLoop({ ...base, budget: { iterations: 1, evaluations: 1 }, initial: genomeOf("bad", ["../outside.md"]) }),
      /outside the sandbox/,
    );
  });
});

describe("runOptimizerLoop sandbox containment (H10.04 acceptance)", () => {
  it("fails stop before any apply when a candidate declares a path outside the root", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base", ["skills/base.md"]),
      mutate: scriptMutator([genomeOf("evil", ["skills/ok.md", "../outside/escape.md"]), genomeOf("c2")]),
      evaluate: scriptEvaluator({ base: evaluationOf("base", 1, 0, 10) }, log),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 5, evaluations: 5 },
    });
    assert.equal(result.stopReason, "sandbox_violation");
    assert.equal(result.iterations, 0);
    assert.ok(!log.includes("apply:evil"));
    assert.equal(result.best.id, "base");
  });

  it("applies and reverts each candidate around its evaluation", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("c1"), genomeOf("c2")]),
      evaluate: scriptEvaluator(
        { base: evaluationOf("base", 1, 0, 100), c1: evaluationOf("c1", 1, 0, 60), c2: evaluationOf("c2", 1, 0, 20) },
        log,
      ),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 2, evaluations: 5 },
    });
    assert.deepEqual(log, [
      "evaluate:base",
      "apply:c1",
      "evaluate:c1",
      "revert",
      "apply:c2",
      "evaluate:c2",
      "revert",
      "apply:c2", // winner re-applied so the sandbox holds the best genome
    ]);
    assert.equal(result.best.id, "c2");
    assert.equal(result.bestEvaluation.genomeId, "c2");
  });

  it("reverts even when the evaluation throws, then keeps the previous best", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("boom")]),
      evaluate: async (g) => {
        log.push(`evaluate:${g.id}`);
        if (g.id === "boom") throw new Error("probe exploded");
        return evaluationOf("base", 1, 0, 10);
      },
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 1, evaluations: 5 },
    });
    assert.deepEqual(log, ["evaluate:base", "apply:boom", "evaluate:boom", "revert"]);
    assert.equal(result.best.id, "base");
  });

  it("never re-applies when no candidate improved", async () => {
    const log: string[] = [];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: scriptMutator([genomeOf("worse"), genomeOf("worse2")]),
      evaluate: scriptEvaluator(
        { base: evaluationOf("base", 3, 0, 10), worse: evaluationOf("worse", 1, 0, 50), worse2: evaluationOf("worse2", 1, 0, 50) },
        log,
      ),
      sandbox: recordingSandbox("/tmp/sb", log),
      budget: { iterations: 2, evaluations: 5 },
    });
    assert.equal(result.best.id, "base");
    assert.equal(log.filter((l) => l.startsWith("apply:")).length, 2); // two applies, zero re-applies
    assert.equal(result.history.filter((s) => s.accepted).length, 1); // baseline only
  });
});

describe("runOptimizerLoop determinism (H10.04)", () => {
  const runOnce = async (): Promise<string> => {
    let seed = 42;
    const rng = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const letters = ["c1", "c2", "c3"];
    const result = await runOptimizerLoop({
      initial: genomeOf("base"),
      mutate: (g, r) => genomeOf(letters[Math.floor(r() * letters.length)] ?? "c1", [`${g.id}.md`]),
      evaluate: async (g) => evaluationOf(g.id, 1 + (g.id.charCodeAt(1) % 3), 0, 10 * (g.id.charCodeAt(1) % 5)),
      sandbox: recordingSandbox("/tmp/sb", []),
      budget: { iterations: 6, evaluations: 10 },
      rng,
      now: () => 0,
    });
    return JSON.stringify({
      best: result.best.id,
      stop: result.stopReason,
      iterations: result.iterations,
      history: result.history.map((s) => [s.genomeId, s.score, s.accepted]),
    });
  };

  it("replays identically under the same seeded RNG", async () => {
    assert.equal(await runOnce(), await runOnce());
  });
});
