/**
 * DeepSeek Harness plugin entry (H01.06): the `deepseek_harness` RPC
 * methods and the `xueness harness ...` CLI, both backed by one registry
 * the hot loader writes through.
 *
 * RPC methods (method names are `<plugin>/<action>`):
 *   deepseek_harness/load    { source }   hot-load a directory or package
 *   deepseek_harness/unload  { id }       unmount one harness
 *   deepseek_harness/list    {}           every mounted harness with counts
 *   deepseek_harness/verify  { id? }      structured per-item check report
 *   deepseek_harness/bench   { baseline? } run the bench suite; regression report vs baseline (H06.06)
 *   deepseek_harness/tournament { models, turns?, kFactor?, initialRating? }
 *                              offline single-elimination tournament with an
 *                              Elo-lite scoreboard (H09.03/H09.04)
 *   deepseek_harness/optimize  { dryRun?, seedPrompt?, budget? }
 *                              genome optimizer dry-run / sandbox loop (H10.06)
 *   deepseek_harness/chaos     { concurrency?, callsPerScenario?, scenarioIds? }
 *                              chaos stress gate; non-zero on hardFail (H11.06)
 *
 * The plugin owns no tools yet (the adapter round mounts those); nothing
 * here executes code from a harness source.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { loadHarness, type LoadOptions } from "./loader.ts";
import { HarnessRegistry } from "./registry.ts";
import { compareBenchRuns, type BenchRunSummary, type RegressionReport } from "./bench/report.ts";
import { runBenchSuite } from "./bench/suite.ts";
import { runTournament, stableAppendTask } from "./tournament/match-runner.ts";
import { scoreTournament, type ScoringOptions } from "./tournament/scoring.ts";
import { createGenome, mutateGenome, mulberry32 } from "./optimizer/genome.ts";
import { runOptimizerLoop, type OptimizerBudget, type OptimizerSandbox } from "./optimizer/loop.ts";
import { foldFitness, type OptimizerGenome } from "./optimizer/fitness.ts";
import type { BenchRunReport } from "./bench/runner.ts";
import type { VerifySummary } from "./builtins/auto-verify.ts";
import { CHAOS_SCENARIOS, chaosScenarioById } from "./chaos/scenarios.ts";
import { runChaosStress } from "./chaos/stress-runner.ts";
import { buildChaosReport } from "./chaos/report.ts";

export * from "./contracts.ts";
export * from "./adapter.ts";
export * from "./prefix-cache.ts";
export * from "./reasoning-bridge.ts";
export * from "./loader.ts";
export * from "./registry.ts";
export * from "./hook-bridge.ts";
export * from "./builtins/auto-verify.ts";
export * from "./builtins/self-repair.ts";
export * from "./builtins/critic-solver.ts";
export * from "./builtins/trajectory-recorder.ts";
export * from "./builtins/repo-map.ts";
export * from "./builtins/symbol-graph.ts";
export * from "./compat/swe-bench-harness.ts";
export * from "./compat/rule-pack-importer.ts";
export * from "./compat/sandbox-verifier.ts";
export * from "./bench/cases.ts";
export { runBenchCase, runBenchCases, formatBenchReport, type BenchCase, type BenchCaseTimings, type BenchCaseResult as BenchTimedCaseResult, type BenchRunSummary as BenchTimedRunSummary, type BenchRunReport, type BenchRunOptions } from "./bench/runner.ts";
export * from "./bench/report.ts";
export * from "./bench/suite.ts";
export * from "./bench/profiler.ts";
export * from "./bench/profiled-runner.ts";

export const HARNESS_METHODS = ["deepseek_harness/load", "deepseek_harness/unload", "deepseek_harness/list", "deepseek_harness/verify", "deepseek_harness/bench", "deepseek_harness/tournament", "deepseek_harness/optimize", "deepseek_harness/chaos"] as const;
export type HarnessMethod = (typeof HARNESS_METHODS)[number];

type Row = Record<string, unknown>;

export interface HarnessApiOptions {
  /** Existing registry to share (tests pass one in); a fresh one otherwise. */
  registry?: HarnessRegistry;
  /** Feature gate: when given and false, every method answers `disabled`. */
  enabled?: () => boolean;
  /** Injectable clock for deterministic `loadedAt` stamps. */
  now?: () => string;
}

export interface HarnessApi {
  readonly methods: readonly string[];
  readonly registry: HarnessRegistry;
  owns(method: string): boolean;
  dispatch(method: string, data: unknown): Promise<Row>;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const failure = (code: string, message: string): Row => ({ ok: false, error: { code, message } });

/** Build the RPC surface over one registry; `data` rows are plain JSON. */
export function createHarnessApi(options: HarnessApiOptions = {}): HarnessApi {
  const registry = options.registry ?? new HarnessRegistry();
  const loadOptions: LoadOptions = options.now ? { now: options.now } : {};
  const enabledNow = (): boolean => (options.enabled ? options.enabled() : true);
  const api: HarnessApi = {
    methods: HARNESS_METHODS,
    registry,
    owns: (method: string): boolean => (HARNESS_METHODS as readonly string[]).includes(method),
    async dispatch(method: string, data: unknown): Promise<Row> {
      if (!api.owns(method)) return failure("unknown_method", `${method} is not a deepseek_harness method`);
      if (!enabledNow()) return failure("disabled", "plugin disabled or dependency unavailable: deepseek_harness");
      const row = isObject(data) ? data : {};
      if (method === "deepseek_harness/load") {
        const source = str(row.source);
        if (source === null) return failure("invalid_input", "load needs a non-empty string `source`");
        const loaded = loadHarness(registry, source, loadOptions);
        return loaded.ok
          ? { ok: true, id: loaded.entry.id, kind: loaded.entry.kind, version: loaded.entry.version, source: loaded.entry.source, loadedAt: loaded.entry.loadedAt }
          : failure(loaded.error.code, loaded.error.message);
      }
      if (method === "deepseek_harness/unload") {
        const id = str(row.id);
        if (id === null) return failure("invalid_input", "unload needs a non-empty string `id`");
        return registry.unmount(id) ? { ok: true, id, unmounted: true } : failure("not_mounted", `harness ${id} is not mounted`);
      }
      if (method === "deepseek_harness/list") return { ok: true, items: registry.list(), count: registry.size };
      if (method === "deepseek_harness/tournament") return dispatchTournament(row);
      if (method === "deepseek_harness/optimize") return await dispatchOptimize(row);
      if (method === "deepseek_harness/chaos") return await dispatchChaos(row);
      if (method === "deepseek_harness/bench") {
        const summary = runBenchSuite({ label: str(row.label) ?? undefined, model: str(row.model) ?? undefined, now: options.now });
        // An explicit `baseline: null` is a malformed baseline, not "no baseline":
        // silently reporting `compared: false` would hide a broken comparison call.
        const baseline = row.baseline === undefined ? null : coerceBenchRun(row.baseline);
        if (baseline === null && row.baseline !== undefined) return failure("invalid_input", "bench baseline must be a BenchRunSummary object");
        const report: RegressionReport | null = baseline ? compareBenchRuns(baseline, summary) : null;
        const healthy = report ? report.healthy : summary.cases.every((item) => item.ok);
        return { ok: true, summary, compared: baseline !== null, healthy, report };
      }
      const report = registry.verify(str(row.id) ?? undefined);
      return { ok: report.ok, checked: report.checked, items: report.items };
    },
  };
  return api;
}

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * `deepseek_harness/tournament` body (H09.04): parse the models list and
 * tuning numbers, run the whole tournament offline on the default
 * stable-append task over the shared prefix cache, and fold the match log
 * into the H09.03 Elo-lite scoreboard. The pipeline has no clock and no
 * randomness, so identical payloads return byte-identical rows.
 */
function dispatchTournament(row: Row): Row {
  const models = row.models;
  if (!Array.isArray(models) || models.length < 2 || !models.every((model) => typeof model === "string" && model.trim().length > 0)) {
    return failure("invalid_input", "tournament needs `models`: an array of at least 2 non-empty strings");
  }
  if (new Set(models as string[]).size !== models.length) return failure("invalid_input", "tournament models must be unique");
  const turns = row.turns === undefined ? 8 : row.turns;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > 10_000) {
    return failure("invalid_input", "tournament `turns` must be an integer in [1, 10000]");
  }
  const scoring: ScoringOptions = {};
  for (const field of ["kFactor", "initialRating", "ratingDecimals"] as const) {
    const value = row[field];
    if (value === undefined) continue;
    if (!num(value)) return failure("invalid_input", `tournament \`${field}\` must be a finite number`);
    scoring[field] = value;
  }

  try {
    const run = runTournament({ models: models as string[], task: stableAppendTask(turns) });
    const board = scoreTournament(run.bracket.models, run.results, scoring);
    return {
      ok: true,
      champion: run.champion,
      complete: run.complete,
      playedMatches: run.playedMatches,
      matches: run.results,
      standings: board.standings,
      matchesCounted: board.matchesCounted,
      matchesSkipped: board.matchesSkipped,
      cacheMetrics: run.cacheMetrics,
    };
  } catch (error) {
    return failure("invalid_input", error instanceof Error ? error.message : String(error));
  }
}


/** H10.06 — optimize dry-run / offline sandbox loop. */
async function dispatchOptimize(row: Row): Promise<Row> {
  const dryRun = row.dryRun === true || row.dryRun === undefined;
  const seedPrompt = str(row.seedPrompt) ?? "Solve tasks with verify gates.";
  const budgetRow = isObject(row.budget) ? row.budget : {};
  const iterations = num(budgetRow.iterations) ? budgetRow.iterations : (num(budgetRow.maxGenerations) ? budgetRow.maxGenerations : 1);
  const evaluations = num(budgetRow.evaluations) ? budgetRow.evaluations : (num(budgetRow.maxEvaluations) ? budgetRow.maxEvaluations : 2);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger(evaluations) || evaluations < 1) {
    return failure("invalid_input", "optimize budget needs positive iterations/evaluations");
  }
  const budget: OptimizerBudget = { iterations, evaluations };
  const seed = createGenome({ id: "seed-0", prompt: seedPrompt, paths: [] });
  if (dryRun) {
    return { ok: true, dryRun: true, seed: { id: seed.id, prompt: seed.prompt }, budget, plannedMutations: budget.iterations };
  }
  const sandbox: OptimizerSandbox = { root: "/tmp/xueness-optimizer-dry", apply: async () => {}, revert: async () => {} };
  const localEvaluate = async (genome: OptimizerGenome) => {
    const benchReport: BenchRunReport = {
      results: [],
      summary: { total: 1, ok: 1, failed: 0, totalTicks: Math.max(1, 200 - genome.prompt.length), ranking: [] },
    };
    const verifySummary: VerifySummary = { passed: true, outcomes: [], summary: "optimize-rpc" };
    return { genomeId: genome.id, breakdown: foldFitness(benchReport, verifySummary), benchReport, verifySummary };
  };
  const result = await runOptimizerLoop({
    initial: seed,
    mutate: (genome, rng) => mutateGenome(genome, { rng }),
    evaluate: localEvaluate,
    sandbox,
    budget,
    rng: mulberry32(7),
    now: () => 0,
  });
  return {
    ok: true,
    dryRun: false,
    stopReason: result.stopReason,
    bestId: result.best.id,
    bestPrompt: result.best.prompt,
    evaluations: result.evaluations,
    iterations: result.iterations,
  };
}

/** H11.06 — chaos stress gate; `ok` is false when the report hard-fails. */
async function dispatchChaos(row: Row): Promise<Row> {
  const concurrency = row.concurrency === undefined ? 2 : row.concurrency;
  const callsPerScenario = row.callsPerScenario === undefined ? 2 : row.callsPerScenario;
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
    return failure("invalid_input", "chaos `concurrency` must be a positive integer");
  }
  if (typeof callsPerScenario !== "number" || !Number.isInteger(callsPerScenario) || callsPerScenario < 1) {
    return failure("invalid_input", "chaos `callsPerScenario` must be a positive integer");
  }
  let scenarios = [...CHAOS_SCENARIOS];
  if (row.scenarioIds !== undefined) {
    if (!Array.isArray(row.scenarioIds) || !row.scenarioIds.every((id) => typeof id === "string")) {
      return failure("invalid_input", "chaos `scenarioIds` must be a string array");
    }
    // An explicitly empty list would run nothing and report `ok`, which reads
    // as a passing chaos gate without a single call executed.
    if (row.scenarioIds.length === 0) {
      return failure("invalid_input", "chaos `scenarioIds` must name at least one scenario");
    }
    const picked = [];
    for (const id of row.scenarioIds as string[]) {
      const scenario = chaosScenarioById(id);
      if (!scenario) return failure("invalid_input", `unknown chaos scenario: ${id}`);
      picked.push(scenario);
    }
    scenarios = picked;
  }
  const run = await runChaosStress({ scenarios, concurrency, callsPerScenario });
  const report = buildChaosReport(run);
  return { ok: !report.hardFail, hardFail: report.hardFail, report };
}

/** Accept one untrusted `BenchRunSummary` row (CLI baseline / RPC payload). */
function coerceBenchRun(value: unknown): BenchRunSummary | null {
  if (!isObject(value)) return null;
  if (typeof value.label !== "string" || typeof value.model !== "string" || typeof value.createdAt !== "string" || !Array.isArray(value.cases)) return null;
  const metricsKeys = ["latencyMs", "tokensIn", "tokensOut", "cacheHits", "cacheMisses"] as const;
  for (const item of value.cases) {
    if (!isObject(item) || typeof item.caseId !== "string" || typeof item.ok !== "boolean") return null;
    if (!isObject(item.metrics) || !metricsKeys.every((key) => num((item.metrics as Row)[key]))) return null;
    if (item.error !== undefined && typeof item.error !== "string") return null;
  }
  return { label: value.label, model: value.model, createdAt: value.createdAt, cases: value.cases as BenchRunSummary["cases"] };
}

export interface HarnessCommandResult {
  code: number;
  output: string;
}

/**
 * The `xueness harness load|unload|list|verify` CLI: thin printing shell
 * over the same dispatch, so CLI and RPC cannot drift apart.
 */
export async function harnessCommand(argv: readonly string[], options: HarnessApiOptions = {}): Promise<HarnessCommandResult> {
  const api = createHarnessApi(options);
  const [action, argument] = argv;
  const usage = "usage: xueness harness <load <path> | unload <id> | list | verify [id] | bench [baseline-json] | tournament <models-csv> [turns] | optimize [--dry-run] | chaos [--calls N] [--concurrency N]>";
  if (action === "optimize") {
    const dryRun = argv.includes("--dry-run") || !argv.includes("--live");
    const result = await api.dispatch("deepseek_harness/optimize", { dryRun });
    if (!result.ok) return { code: 2, output: JSON.stringify(result) };
    return { code: 0, output: JSON.stringify(result) };
  }
  if (action === "chaos") {
    let calls = 2;
    let concurrency = 2;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--calls" && argv[i + 1]) { calls = Number(argv[++i]); continue; }
      if (argv[i] === "--concurrency" && argv[i + 1]) { concurrency = Number(argv[++i]); continue; }
    }
    const result = await api.dispatch("deepseek_harness/chaos", { callsPerScenario: calls, concurrency });
    if (result.error) return { code: 2, output: JSON.stringify(result) };
    return { code: result.ok ? 0 : 1, output: JSON.stringify(result) };
  }
  if (action === "tournament") {
    const models = (argument ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    let turns: number | undefined;
    const rawTurns = argv[2];
    if (rawTurns !== undefined) {
      turns = Number(rawTurns);
      if (!Number.isInteger(turns) || turns < 1) return { code: 2, output: usage };
    }
    const result = await api.dispatch("deepseek_harness/tournament", turns === undefined ? { models } : { models, turns });
    if (!result.ok) return { code: 2, output: JSON.stringify(result) };
    // A stalled bracket (double forfeits) is a real answer, but not exit 0.
    return { code: result.complete === false ? 1 : 0, output: JSON.stringify(result) };
  }
  if (action === "bench") {
    let baseline: unknown;
    if (argument !== undefined) {
      try {
        baseline = JSON.parse(argument);
      } catch {
        return { code: 2, output: usage };
      }
    }
    const result = await api.dispatch("deepseek_harness/bench", baseline === undefined ? {} : { baseline });
    if (!result.ok) return { code: 2, output: JSON.stringify(result) };
    return { code: result.healthy === false ? 1 : 0, output: JSON.stringify(result) };
  }
  const call: readonly [string, Row] | null =
    action === "load" && argument ? ["deepseek_harness/load", { source: argument }]
    : action === "unload" && argument ? ["deepseek_harness/unload", { id: argument }]
    : action === "list" ? ["deepseek_harness/list", {}]
    : action === "verify" ? ["deepseek_harness/verify", argument ? { id: argument } : {}]
    : null;
  if (call === null) return { code: 2, output: usage };
  const result = await api.dispatch(call[0], call[1]);
  return { code: result.ok ? 0 : 1, output: JSON.stringify(result) };
}

/** The bundled plugin: manifest plus an empty apply — the API is created by the host. */
export const deepseekHarness: BundledPlugin = { manifest, plugin: definePlugin({ name: "deepseek_harness", apply() {} }) };
export * from "./swarm/coordinator.ts";
export * from "./swarm/sharding.ts";
export * from "./swarm/critic-slots.ts";
export * from "./swarm/job-runner.ts";
export * from "./swarm/verify-integration.ts";
export * from "./swarm/trajectory-rollup.ts";
export * from "./tournament/bracket.ts";
export * from "./tournament/match-runner.ts";
export * from "./tournament/scoring.ts";
export * from "./optimizer/fitness.ts";
export * from "./optimizer/loop.ts";
export * from "./chaos/scenarios.ts";
export * from "./chaos/stress-runner.ts";
