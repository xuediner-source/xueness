/**
 * Reproducible harness benchmark fixtures (H06.02).
 *
 * Each fixture synthesizes its own input deterministically (index-derived
 * values only — no randomness, no clock, no I/O), runs one real harness
 * pipeline as the workload and returns a `BenchCase` for the H06.01 runner:
 *
 *  - `swe_bench_import`: JSONL task import over a synthesized SWE-bench
 *    document (H04.01 `importSweBenchTasks`);
 *  - `contracts_parse`: package-contract validation over a synthesized
 *    contribution list (H01.01 `parseHarnessPackage`);
 *  - `prefix_cache_replay`: KV-cache stabilization and hit-rate aggregation
 *    over a synthesized multi-session request sequence (H01.03);
 *  - `shard_plan`: greedy LPT shard planning over weighted file scopes
 *    (H07.02 `planShards`).
 *
 * `buildBenchFixtures()` with the same options always yields cases whose runs
 * return structurally equal values, so repeated benchmark sessions are
 * comparable (the runner's value digest makes drift visible).
 */
import { parseHarnessPackage } from "../contracts.ts";
import { createPrefixCache, type StableRequest } from "../prefix-cache.ts";
import { importSweBenchTasks } from "../compat/swe-bench-harness.ts";
import { planShards, shardsAreDisjoint, type FileScope } from "../swarm/sharding.ts";
import type { BenchCase } from "./runner.ts";

/** Fixture sizes default to the values used by the plugin's own checks. */
export interface BenchFixtureOptions {
  /** Lines in the synthesized SWE-bench JSONL document; default 200. */
  readonly sweBenchLines?: number;
  /** Contributions in the synthesized harness package; default 200. */
  readonly contractContributions?: number;
  /** Requests per session in the prefix-cache replay; default 40. */
  readonly prefixRequests?: number;
  /** Sessions in the prefix-cache replay; default 8. */
  readonly prefixSessions?: number;
  /** Files in the synthesized shard-planning scope; default 300. */
  readonly shardFiles?: number;
  /** Iterations stamped on every built case; default 5. */
  readonly iterations?: number;
}

export interface BenchFixture {
  readonly id: string;
  readonly description: string;
  build(options?: BenchFixtureOptions): BenchCase;
}

const DEFAULTS = {
  sweBenchLines: 200,
  contractContributions: 200,
  prefixRequests: 40,
  prefixSessions: 8,
  shardFiles: 300,
  iterations: 5,
} as const;

/** One synthesized SWE-bench JSONL task line; content is a pure function of `index`. */
export function sweBenchTaskLine(index: number): string {
  return JSON.stringify({
    instance_id: `org${index % 7}__repo-${index}`,
    repo: `org${index % 7}/repo`,
    base_commit: `c${(index + 1).toString(16)}`,
    patch: `--- a/src/mod${index % 13}.py\n+++ b/src/mod${index % 13}.py\n@@ -1 +1,2 @@\n-x\n+y${index}\n`,
    test_patch: `--- a/tests/test_mod${index % 13}.py\n+++ b/tests/test_mod${index % 13}.py\n`,
    problem_statement: `Synthetic failure number ${index}: assert result == ${index * 3}.`,
    hints_text: "",
    created_at: "2024-01-01T00:00:00Z",
    version: "1.0",
    environment_setup_commit: `c${(index + 1).toString(16)}`,
    FAIL_TO_PASS: [`test_mod${index % 13}_fix_${index}`],
    PASS_TO_PASS: [`test_mod${index % 13}_keep_a`, `test_mod${index % 13}_keep_b`],
  });
}

/** The full synthesized SWE-bench JSONL document for `lines` tasks. */
export function sweBenchDocument(lines: number): string {
  const parts: string[] = [];
  for (let index = 0; index < lines; index += 1) parts.push(sweBenchTaskLine(index));
  return `${parts.join("\n")}\n`;
}

const CONTRIBUTION_KINDS = ["tool", "hook", "verifier", "skill", "promptTemplate"] as const;

/** A synthetic harness package document with `count` valid contributions. */
export function syntheticHarnessPackage(count: number): Record<string, unknown> {
  const contributions: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = CONTRIBUTION_KINDS[index % CONTRIBUTION_KINDS.length] as (typeof CONTRIBUTION_KINDS)[number];
    if (kind === "tool") contributions.push({ kind, name: `bench_tool_${index}`, gate: "bench_gate", mutating: index % 2 === 0, description: `synthetic tool ${index}` });
    else if (kind === "hook") contributions.push({ kind, event: `bench:event${index % 9}`, handler: `on_event_${index}` });
    else if (kind === "verifier") contributions.push({ kind, name: `bench_verifier_${index}`, command: `xueness check ${index}` });
    else if (kind === "skill") contributions.push({ kind, id: `bench_skill_${index}`, path: `skills/${index}.md` });
    else contributions.push({ kind, id: `bench_template_${index}`, template: `Resolve task {{ ${index} }}` });
  }
  return { sdkApiVersion: 1, id: "bench_harness", version: "1.0.0", contributions };
}

/** One stable request for session `session` at turn `turn`; content derived from both. */
export function stableRequestFor(session: number, turn: number): StableRequest {
  return {
    system: `You are bench session ${session}.`,
    tools: Array.from({ length: 4 }, (_, slot) => ({ name: `tool_${slot}_${session}`, parameters: { type: "object", index: slot } })),
    messages: Array.from({ length: turn + 1 }, (_, step) => ({ role: step % 2 === 0 ? "user" : "assistant", content: `session ${session} turn ${turn} step ${step}` })),
  };
}

/** Weighted file scopes for shard planning; path and weight derive from `index`. */
export function syntheticFileScopes(count: number): FileScope[] {
  const files: FileScope[] = [];
  for (let index = 0; index < count; index += 1) {
    files.push({ path: `src/pkg${index % 11}/mod_${index}.ts`, weight: 1 + ((index * 7) % 53) });
  }
  return files;
}

const caseFor = (id: string, description: string, iterations: number, run: () => unknown): BenchCase => ({ id, description, iterations, run });

/** The fixture catalog: at least three reproducible harness benchmarks. */
export const BENCH_FIXTURES: readonly BenchFixture[] = [
  {
    id: "swe_bench_import",
    description: "importSweBenchTasks over a synthesized JSONL task document",
    build(options: BenchFixtureOptions = {}): BenchCase {
      const lines = options.sweBenchLines ?? DEFAULTS.sweBenchLines;
      const iterations = options.iterations ?? DEFAULTS.iterations;
      const document = sweBenchDocument(lines);
      return caseFor(this.id, this.description, iterations, () => {
        const { tasks, issues } = importSweBenchTasks(document);
        return { tasks: tasks.length, issues: issues.length, first: tasks[0]?.instanceId ?? null, last: tasks[tasks.length - 1]?.instanceId ?? null };
      });
    },
  },
  {
    id: "contracts_parse",
    description: "parseHarnessPackage over a synthesized contribution list",
    build(options: BenchFixtureOptions = {}): BenchCase {
      const count = options.contractContributions ?? DEFAULTS.contractContributions;
      const iterations = options.iterations ?? DEFAULTS.iterations;
      const document = syntheticHarnessPackage(count);
      return caseFor(this.id, this.description, iterations, () => {
        const parsed = parseHarnessPackage(document);
        return parsed.ok ? { ok: true, contributions: parsed.package.contributions.length } : { ok: false, issues: parsed.issues.length };
      });
    },
  },
  {
    id: "prefix_cache_replay",
    description: "createPrefixCache record/metrics over a synthesized multi-session request sequence",
    build(options: BenchFixtureOptions = {}): BenchCase {
      const requests = options.prefixRequests ?? DEFAULTS.prefixRequests;
      const sessions = options.prefixSessions ?? DEFAULTS.prefixSessions;
      const iterations = options.iterations ?? DEFAULTS.iterations;
      return caseFor(this.id, this.description, iterations, () => {
        const cache = createPrefixCache({ capacity: sessions });
        for (let session = 0; session < sessions; session += 1) {
          for (let turn = 0; turn < requests; turn += 1) {
            cache.record(`bench_session_${session}`, "deepseek-v4.1", stableRequestFor(session, turn));
          }
        }
        return cache.metrics();
      });
    },
  },
  {
    id: "shard_plan",
    description: "planShards greedy LPT balance over weighted file scopes",
    build(options: BenchFixtureOptions = {}): BenchCase {
      const count = options.shardFiles ?? DEFAULTS.shardFiles;
      const iterations = options.iterations ?? DEFAULTS.iterations;
      return caseFor(this.id, this.description, iterations, () => {
        const files = syntheticFileScopes(count);
        const shards = planShards(files, 8);
        return { shards: shards.length, files: shards.reduce((sum, shard) => sum + shard.files.length, 0), disjoint: shardsAreDisjoint(shards) };
      });
    },
  },
];

/** Build every fixture into a runnable case list (ids are unique by construction). */
export function buildBenchFixtures(options: BenchFixtureOptions = {}): BenchCase[] {
  return BENCH_FIXTURES.map((fixture) => fixture.build(options));
}
