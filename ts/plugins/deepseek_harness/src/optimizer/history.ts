/**
 * H10.05 — Optimizer trajectory history + rollback to best genome.
 */
import { canonicalJson } from "../prefix-cache.ts";
import type { OptimizerGenome } from "./fitness.ts";
import type { FitnessEvaluation } from "./fitness.ts";

export interface OptimizerHistoryFrame {
  readonly at: string;
  readonly genome: OptimizerGenome;
  readonly fitness: FitnessEvaluation;
  readonly bestId: string;
}

export interface OptimizerHistory {
  record(frame: Omit<OptimizerHistoryFrame, "bestId"> & { bestId?: string }): OptimizerHistoryFrame;
  frames(): readonly OptimizerHistoryFrame[];
  best(): OptimizerHistoryFrame | null;
  rollbackToBest(): OptimizerGenome | null;
  exportJsonl(): string;
}

function scoreOf(fitness: FitnessEvaluation): number {
  return fitness.breakdown.score;
}

function eligibleOf(fitness: FitnessEvaluation): boolean {
  return fitness.breakdown.eligible;
}

export function createOptimizerHistory(): OptimizerHistory {
  const frames: OptimizerHistoryFrame[] = [];
  let best: OptimizerHistoryFrame | null = null;
  return {
    record(input) {
      const better =
        !best ||
        (eligibleOf(input.fitness) && !eligibleOf(best.fitness)) ||
        (eligibleOf(input.fitness) === eligibleOf(best.fitness) &&
          (scoreOf(input.fitness) > scoreOf(best.fitness) ||
            (scoreOf(input.fitness) === scoreOf(best.fitness) && input.genome.id < best.genome.id)));
      const frame: OptimizerHistoryFrame = {
        at: input.at,
        genome: input.genome,
        fitness: input.fitness,
        bestId: input.bestId ?? (better ? input.genome.id : best!.genome.id),
      };
      frames.push(frame);
      if (better) best = frame;
      return frame;
    },
    frames() { return Object.freeze([...frames]); },
    best() { return best; },
    rollbackToBest() { return best?.genome ?? null; },
    exportJsonl() { return frames.map((f) => canonicalJson({
      at: f.at,
      genomeId: f.genome.id,
      bestId: f.bestId,
      score: f.fitness.breakdown.score,
      eligible: f.fitness.breakdown.eligible,
    })).join("\n"); },
  };
}
