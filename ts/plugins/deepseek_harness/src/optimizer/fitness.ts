/**
 * Optimizer fitness (H10.03): fold an H06 bench report and an H02 verify
 * summary for one prompt/skill candidate genome into a single deterministic
 * fitness score.
 *
 * Folding rules (fixed, documented, no hidden state):
 *
 *  - **verify gates first (H02 fold).** A candidate whose verify pass failed
 *    any gate is *ineligible*: its score is pinned to 0 no matter how fast the
 *    bench ran, because a candidate that breaks the acceptance gates can never
 *    ship. Gate ratios break ties among eligible candidates.
 *  - **bench quality (H06 fold).** The bench score is the ok/total case ratio
 *    of the H06 runner report; the speed score decays smoothly with the
 *    report's total tick count (`1 / (1 + totalTicks / scaleTicks)`), so a
 *    faster candidate wins among equals without any external baseline.
 *  - **weighted sum.** `score = wV*verifyScore + wB*benchScore + wS*speedScore`
 *    with non-negative weights (defaults 0.5 / 0.3 / 0.2). Scores are finite
 *    and reproducible: same probes in, same score out.
 *  - **total order.** `compareFitness` ranks candidates deterministically:
 *    eligible before ineligible, then score desc, ok-bench-cases desc, total
 *    ticks asc, genome id asc — the final tie-break keeps reports stable even
 *    for candidates that score identically.
 *
 * The genome contract is deliberately structural (an id, a prompt, and the
 * skill-patch paths the candidate would write): the H10.01 genome module and
 * the H10.02 skill-diff applier satisfy it without depending on this file.
 *
 * Pure computation: probes are injected, nothing is measured here.
 */
import type { BenchRunReport } from "../bench/runner.ts";
import type { VerifySummary } from "../builtins/auto-verify.ts";

/**
 * A prompt/skill candidate. Structural so the H10.01 genome and the H10.02
 * skill-diff types satisfy it structurally.
 */
export interface OptimizerGenome {
  /** Stable candidate id; the final tie-break in `compareFitness`. */
  readonly id: string;
  /** The prompt text under optimization. */
  readonly prompt: string;
  /**
   * Workspace-relative paths the candidate's skill patch would write. The
   * H10.04 loop validates every entry against its sandbox root before any
   * apply; fitness itself only reads the genome.
   */
  readonly paths?: readonly string[];
}

/** H06 fold: run the bench suite for one candidate and report it. */
export type BenchProbe = (genome: OptimizerGenome) => BenchRunReport | Promise<BenchRunReport>;

/** H02 fold: run the acceptance gates for one candidate and summarize them. */
export type VerifyProbe = (genome: OptimizerGenome) => VerifySummary | Promise<VerifySummary>;

/** Non-negative weights for the three score components; need not sum to 1. */
export interface FitnessWeights {
  readonly verify: number;
  readonly bench: number;
  readonly speed: number;
}

export const DEFAULT_FITNESS_WEIGHTS: Readonly<FitnessWeights> = { verify: 0.5, bench: 0.3, speed: 0.2 };

/**
 * Score-tuning knobs shared by every fold; all optional. Pure functions take
 * only these — the probes belong to the evaluator, not to the fold.
 */
export interface FitnessFoldOptions {
  readonly weights?: FitnessWeights;
  /**
   * Ticks at which the speed score halves; must be positive. Default 1000.
   * Chosen per run (not per candidate) — mixing scales across candidates
   * would make scores incomparable.
   */
  readonly speedScaleTicks?: number;
}

export interface FitnessOptions extends FitnessFoldOptions {
  readonly bench: BenchProbe;
  readonly verify: VerifyProbe;
}

/** The three folded components plus the inputs they came from. */
export interface FitnessBreakdown {
  /** True iff the H02 verify pass passed every selected gate. */
  readonly verifyPassed: boolean;
  /** Passed gates / selected gates; 1 when no gate was selected. */
  readonly verifyScore: number;
  /** Ok bench cases / total cases; 1 when the suite is empty. */
  readonly benchScore: number;
  /** `1 / (1 + totalTicks / speedScaleTicks)` over ok cases only. */
  readonly speedScore: number;
  /** The weighted sum; pinned to 0 for verify-failing (ineligible) candidates. */
  readonly score: number;
  /** False exactly when `verifyPassed` is false. */
  readonly eligible: boolean;
}

export interface FitnessEvaluation {
  readonly genomeId: string;
  readonly breakdown: FitnessBreakdown;
  readonly benchReport: BenchRunReport;
  readonly verifySummary: VerifySummary;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function validateOptions(options: FitnessOptions): void {
  const { bench, verify } = options;
  if (typeof bench !== "function" || typeof verify !== "function") {
    throw new Error("fitness: bench and verify probes are required functions");
  }
  validateFoldOptions(options);
}

/**
 * Fold inputs are validated on every entry point, not only on the probe
 * evaluator: a negative weight or a non-positive scale would otherwise fold
 * silently into an out-of-contract score.
 */
function validateFoldOptions(options: FitnessFoldOptions): void {
  const weights = options.weights ?? DEFAULT_FITNESS_WEIGHTS;
  for (const [name, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`fitness: weight ${name} must be a non-negative number`);
  }
  const scale = options.speedScaleTicks ?? 1000;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("fitness: speedScaleTicks must be a positive number");
}

/**
 * Fold one verify summary into its gate component. An empty gate selection
 * (H02 returns `passed: true` with no outcomes) scores 1: there was nothing
 * to fail. A timed-out gate counts as failed, exactly as H02 reports it.
 */
export function verifyScoreOf(summary: VerifySummary): number {
  const total = summary.outcomes.length;
  if (total === 0) return 1;
  const passed = summary.outcomes.filter((outcome) => outcome.passed).length;
  return round(passed / total);
}

/**
 * Fold one bench report into its case-quality component. Failed cases (a
 * throwing workload, a duplicate id, a bad iteration count per H06) can never
 * raise the score; an empty suite scores 1.
 */
export function benchScoreOf(report: BenchRunReport): number {
  const total = report.summary.total;
  if (total === 0) return 1;
  return round(report.summary.ok / total);
}

/**
 * Fold the bench report's total tick count into the speed component. Ok cases
 * only (failed ones carry no timing), smooth decay, never negative.
 */
export function speedScoreOf(report: BenchRunReport, scaleTicks: number): number {
  const ticks = report.summary.totalTicks;
  if (!Number.isFinite(ticks) || ticks <= 0) return 1;
  return round(1 / (1 + ticks / scaleTicks));
}

/** Fold both probes' outputs into the final breakdown (pure, no probes run). */
export function foldFitness(benchReport: BenchRunReport, verifySummary: VerifySummary, options: FitnessFoldOptions = {}): FitnessBreakdown {
  validateFoldOptions(options);
  const weights = options.weights ?? DEFAULT_FITNESS_WEIGHTS;
  const scale = options.speedScaleTicks ?? 1000;
  const verifyPassed = verifySummary.passed;
  const verifyScore = verifyScoreOf(verifySummary);
  const benchScore = benchScoreOf(benchReport);
  const speedScore = speedScoreOf(benchReport, scale);
  const weighted = weights.verify * verifyScore + weights.bench * benchScore + weights.speed * speedScore;
  const score = verifyPassed ? round(weighted) : 0;
  return { verifyPassed, verifyScore, benchScore, speedScore, score, eligible: verifyPassed };
}

export interface FitnessEvaluator {
  /** Run both probes for one genome and fold the results. */
  evaluate(genome: OptimizerGenome): Promise<FitnessEvaluation>;
}

/**
 * Build the evaluator (H10.03 acceptance: one call folds H06 bench + H02
 * verify). Probes are invoked in order — bench first, then verify — so a
 * verify pass observes exactly what the bench run left behind.
 */
export function createFitnessEvaluator(options: FitnessOptions): FitnessEvaluator {
  validateOptions(options);
  const weights = options.weights ?? DEFAULT_FITNESS_WEIGHTS;
  const speedScaleTicks = options.speedScaleTicks ?? 1000;
  return {
    async evaluate(genome) {
      const benchReport = await options.bench(genome);
      const verifySummary = await options.verify(genome);
      const breakdown = foldFitness(benchReport, verifySummary, { weights, speedScaleTicks });
      return { genomeId: genome.id, breakdown, benchReport, verifySummary };
    },
  };
}

/**
 * Deterministic total order over fitness evaluations (better first):
 * eligible before ineligible, score desc, ok bench cases desc, total ticks
 * asc, then genome id asc as the final stable tie-break.
 */
export function compareFitness(left: FitnessEvaluation, right: FitnessEvaluation): number {
  if (left.breakdown.eligible !== right.breakdown.eligible) return left.breakdown.eligible ? -1 : 1;
  if (left.breakdown.score !== right.breakdown.score) return right.breakdown.score - left.breakdown.score;
  const leftOk = left.benchReport.summary.ok;
  const rightOk = right.benchReport.summary.ok;
  if (leftOk !== rightOk) return rightOk - leftOk;
  const leftTicks = left.benchReport.summary.totalTicks;
  const rightTicks = right.benchReport.summary.totalTicks;
  if (leftTicks !== rightTicks) return leftTicks - rightTicks;
  return left.genomeId < right.genomeId ? -1 : left.genomeId > right.genomeId ? 1 : 0;
}

/** Render one evaluation as a stable single-line score card for reports. */
export function formatFitness(evaluation: FitnessEvaluation): string {
  const b = evaluation.breakdown;
  return `${evaluation.genomeId}  ${b.eligible ? "eligible" : "blocked"}  score ${b.score} (verify ${b.verifyScore}, bench ${b.benchScore}, speed ${b.speedScore})`;
}
