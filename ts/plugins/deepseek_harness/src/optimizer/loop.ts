/**
 * Optimizer loop (H10.04): hill-climb prompt/skill genomes under a hard
 * budget, applying every candidate only inside a sandbox and always reverting
 * it after evaluation.
 *
 * Budget semantics — the loop *stops on budget*, never past it:
 *
 *  - `maxIterations` bounds mutate→apply→evaluate→revert cycles;
 *  - `maxEvaluations` bounds fitness calls (the initial genome's baseline
 *    evaluation included);
 *  - `wallMs` optionally bounds the whole run via the injected clock.
 *  Every unit is checked *before* it is consumed, so a loop with a budget of
 *  N evaluations performs at most N, even when the wall clock or iteration
 *  caps would have allowed one more, and `stopReason` names the cap that
 *  ended the run.
 *
 * Sandbox containment — *never mutates outside the sandbox*:
 *
 *  - the only mutation channel is the injected `sandbox.apply`, and the loop
 *    refuses to call it for a candidate whose declared `paths` resolve outside
 *    `sandbox.root` (containment via `resolveInsideSandbox`, absolute paths
 *    and `..` traversal included);
 *  - a containment violation aborts the run *before* any apply — fail-stop,
 *    not skip — and reports `stopReason: "sandbox_violation"`;
 *  - after every evaluation the previous state is restored via
 *    `sandbox.revert`, so the loop leaves the sandbox holding the accepted
 *    best genome and nothing else.
 *
 * Determinism: the RNG and the clock are injected; equal inputs and equal
 * probes replay the run byte-identically (H10.01 seeded-RNG contract).
 */
import { isAbsolute, resolve, sep } from "node:path";
import { compareFitness, type FitnessEvaluation, type OptimizerGenome } from "./fitness.ts";

/** Produces one candidate from the current best; `null` means "out of moves". */
export type GenomeMutator = (genome: OptimizerGenome, rng: () => number) => OptimizerGenome | null;

/** Evaluates one applied candidate (H10.03 fitness evaluator's shape). */
export type GenomeEvaluator = (genome: OptimizerGenome) => Promise<FitnessEvaluation>;

/**
 * The only mutation channel. `root` is the sandbox directory; `apply` writes
 * a candidate's skill patch inside it, `revert` restores the previous state.
 */
export interface OptimizerSandbox {
  readonly root: string;
  apply(genome: OptimizerGenome): Promise<void> | void;
  revert(): Promise<void> | void;
}

export interface OptimizerBudget {
  /** Max mutate/apply/evaluate cycles; positive integer. */
  readonly iterations: number;
  /** Max fitness calls including the baseline; positive integer. */
  readonly evaluations: number;
  /** Optional wall-clock cap in ms via the injected clock; positive integer. */
  readonly wallMs?: number;
}

export type OptimizerStopReason =
  | "budget_iterations"
  | "budget_evaluations"
  | "budget_wall"
  | "mutation_exhausted"
  | "no_improvement"
  | "sandbox_violation";

/** One accepted-or-rejected candidate, in evaluation order. */
export interface OptimizerStep {
  readonly iteration: number;
  readonly genomeId: string;
  readonly score: number;
  readonly accepted: boolean;
}

export interface OptimizerRunResult {
  readonly best: OptimizerGenome;
  readonly bestEvaluation: FitnessEvaluation;
  /** Every evaluated candidate, baseline first; entry i took evaluation i+1. */
  readonly history: readonly OptimizerStep[];
  readonly iterations: number;
  readonly evaluations: number;
  readonly elapsedMs: number;
  readonly stopReason: OptimizerStopReason;
}

export interface OptimizerLoopOptions {
  readonly initial: OptimizerGenome;
  readonly mutate: GenomeMutator;
  readonly evaluate: GenomeEvaluator;
  readonly sandbox: OptimizerSandbox;
  readonly budget: OptimizerBudget;
  /** Seeded RNG source; defaults to a deterministic 0-returning generator. */
  readonly rng?: () => number;
  /** Clock for `wallMs` and `elapsedMs`; defaults to a 0-based fake. */
  readonly now?: () => number;
  /** Stop after this many consecutive non-improving candidates; default off. */
  readonly patience?: number;
}

const zeroRng = (): number => 0;
const zeroClock = (): number => 0;

function validateBudget(budget: OptimizerBudget): void {
  for (const [name, value] of [["iterations", budget.iterations], ["evaluations", budget.evaluations]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`optimizer loop: budget ${name} must be a positive integer`);
  }
  if (budget.wallMs !== undefined && (!Number.isSafeInteger(budget.wallMs) || budget.wallMs < 1)) {
    throw new Error("optimizer loop: budget wallMs must be a positive integer");
  }
}

/**
 * Resolve `candidatePath` (workspace-relative or absolute) under `root` and
 * return the containment decision. Absolute paths are accepted only when they
 * already sit inside `root`; `..` segments that escape are rejected.
 */
export function resolveInsideSandbox(root: string, candidatePath: string): { inside: boolean; resolved: string } {
  const rootDir = resolve(root);
  const cleaned = candidatePath.replaceAll("\\", "/");
  const resolved = cleaned.startsWith("/") || isAbsolute(cleaned) ? resolve(cleaned) : resolve(rootDir, cleaned);
  if (resolved === rootDir) return { inside: true, resolved };
  const prefix = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  return { inside: resolved.startsWith(prefix), resolved };
}

/** Every declared path of `genome` must resolve inside `sandbox.root`. */
export function genomeInsideSandbox(genome: OptimizerGenome, sandbox: OptimizerSandbox): boolean {
  const paths = genome.paths ?? [];
  if (paths.length === 0) return true;
  return paths.every((candidatePath) => resolveInsideSandbox(sandbox.root, candidatePath).inside);
}

/**
 * Run the loop (H10.04). The baseline evaluation consumes the first evaluation
 * unit; each cycle then applies the candidate inside the sandbox, evaluates it
 * against the *live* sandbox state, reverts, and keeps the best genome by
 * `compareFitness`. The returned `best` is re-applied before returning only
 * when it differs from the initial genome.
 */
export async function runOptimizerLoop(options: OptimizerLoopOptions): Promise<OptimizerRunResult> {
  const { initial, mutate, evaluate, sandbox } = options;
  if (typeof mutate !== "function" || typeof evaluate !== "function") {
    throw new Error("optimizer loop: mutate and evaluate are required functions");
  }
  if (!initial || typeof initial.id !== "string") throw new Error("optimizer loop: initial genome needs a string id");
  if (!sandbox || typeof sandbox.apply !== "function" || typeof sandbox.revert !== "function") {
    throw new Error("optimizer loop: sandbox needs apply and revert functions");
  }
  validateBudget(options.budget);
  if (!genomeInsideSandbox(initial, sandbox)) {
    throw new Error(`optimizer loop: initial genome ${initial.id} declares paths outside the sandbox root`);
  }
  const rng = options.rng ?? zeroRng;
  const now = options.now ?? zeroClock;
  // `Infinity` (the default) means "no patience cap": keep climbing until a
  // budget or the mutator stops the run.
  const patience = options.patience ?? Number.POSITIVE_INFINITY;
  if (patience !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(patience) || patience < 1)) {
    throw new Error("optimizer loop: patience must be a positive integer");
  }

  const startedAt = now();
  const wallRemaining = (): number | null => {
    if (options.budget.wallMs === undefined) return null;
    return options.budget.wallMs - (now() - startedAt);
  };

  const history: OptimizerStep[] = [];
  let iterations = 0;
  let evaluations = 0;

  // Baseline: the initial genome is evaluated as-is, no apply/revert cycle.
  let best = initial;
  let bestEvaluation = await evaluate(initial);
  evaluations += 1;
  history.push({ iteration: 0, genomeId: initial.id, score: bestEvaluation.breakdown.score, accepted: true });
  let stagnant = 0;

  let stopReason: OptimizerStopReason = "budget_iterations";
  let running = true;
  while (running) {
    if (iterations >= options.budget.iterations) {
      stopReason = "budget_iterations";
      break;
    }
    if (evaluations >= options.budget.evaluations) {
      stopReason = "budget_evaluations";
      break;
    }
    const wall = wallRemaining();
    if (wall !== null && wall <= 0) {
      stopReason = "budget_wall";
      break;
    }

    const candidate = mutate(best, rng);
    if (candidate === null || candidate === undefined) {
      stopReason = "mutation_exhausted";
      break;
    }
    // Containment is a hard precondition of apply: fail-stop before mutating.
    if (!genomeInsideSandbox(candidate, sandbox)) {
      stopReason = "sandbox_violation";
      break;
    }
    // The evaluation unit is reserved before apply so a budget exhausted
    // mid-cycle still leaves the sandbox in its pre-cycle state.
    if (evaluations + 1 > options.budget.evaluations) {
      stopReason = "budget_evaluations";
      break;
    }
    if (wallRemaining() !== null && (wallRemaining() as number) <= 0) {
      stopReason = "budget_wall";
      break;
    }

    await sandbox.apply(candidate);
    let candidateEvaluation: FitnessEvaluation | null = null;
    try {
      candidateEvaluation = await evaluate(candidate);
    } catch {
      // An exploding probe rejects the candidate; the sandbox is still
      // reverted below so the cycle leaves no trace behind.
    } finally {
      await sandbox.revert();
    }
    iterations += 1;
    evaluations += 1;

    if (candidateEvaluation === null) {
      // Recorded in history (score 0, rejected) so the H10.05 trajectory sees
      // every evaluated candidate, crashed probes included.
      history.push({ iteration: iterations, genomeId: candidate.id, score: 0, accepted: false });
      stagnant += 1;
      if (stagnant >= patience) {
        stopReason = "no_improvement";
        running = false;
      }
      continue;
    }
    const accepted = compareFitness(candidateEvaluation, bestEvaluation) < 0;
    if (accepted) {
      best = candidate;
      bestEvaluation = candidateEvaluation;
      stagnant = 0;
    } else {
      stagnant += 1;
    }
    history.push({ iteration: iterations, genomeId: candidate.id, score: candidateEvaluation.breakdown.score, accepted });
    if (stagnant >= patience) {
      stopReason = "no_improvement";
      running = false;
    }
  }

  // Leave the sandbox holding the winner: re-apply the best genome when the
  // loop moved on from the initial one (the last revert restored the
  // pre-cycle state, which is not necessarily the best candidate).
  if (best !== initial) await sandbox.apply(best);

  return {
    best,
    bestEvaluation,
    history,
    iterations,
    evaluations,
    elapsedMs: Math.max(0, now() - startedAt),
    stopReason,
  };
}
