/**
 * H10.01 — Genome constructors + deterministic mutate over H10.03 OptimizerGenome.
 */
import type { OptimizerGenome } from "./fitness.ts";

export type { OptimizerGenome } from "./fitness.ts";

export interface GenomeLineage {
  readonly generation: number;
  readonly parentId: string | null;
}

const lineage = new WeakMap<OptimizerGenome, GenomeLineage>();

const DEFAULT_SUFFIXES = [" Be concise.", " Prefer tests first.", " Cite invariants.", " Avoid speculation."];

export function createGenome(seed: { id: string; prompt: string; paths?: readonly string[]; parentId?: string | null; generation?: number }): OptimizerGenome {
  if (!seed.id.trim()) throw new Error("genome id required");
  if (!seed.prompt.trim()) throw new Error("genome prompt required");
  const genome: OptimizerGenome = {
    id: seed.id,
    prompt: seed.prompt,
    paths: seed.paths ? Object.freeze([...seed.paths]) : undefined,
  };
  lineage.set(genome, { generation: seed.generation ?? 0, parentId: seed.parentId ?? null });
  return genome;
}

export function genomeLineageOf(genome: OptimizerGenome): GenomeLineage {
  return lineage.get(genome) ?? { generation: 0, parentId: null };
}

export interface GenomeMutateOptions {
  readonly rng: () => number;
  readonly idFactory?: () => string;
}

export function mutateGenome(genome: OptimizerGenome, options: GenomeMutateOptions): OptimizerGenome {
  const r = options.rng();
  if (!Number.isFinite(r) || r < 0 || r >= 1) throw new Error("rng must return [0,1)");
  const suffix = DEFAULT_SUFFIXES[Math.floor(r * DEFAULT_SUFFIXES.length)]!;
  const id = options.idFactory ? options.idFactory() : `${genome.id}-m${Math.floor(r * 1e6)}`;
  const prev = genomeLineageOf(genome);
  return createGenome({
    id,
    prompt: `${genome.prompt}${suffix}`,
    paths: genome.paths,
    parentId: genome.id,
    generation: prev.generation + 1,
  });
}

/** Seeded mulberry32 for deterministic mutate sequences. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
