/**
 * Tournament match runner over the shared H01 prefix-cache (H09.02).
 *
 * One `PrefixCache` instance (H01.03) is shared by every match of a
 * tournament run: each playing model records its turns through the runner's
 * `ctx.record` under the session key `<matchId>/<model>`, so cache hits are
 * measured exactly the way production sessions are, and the aggregated
 * `cacheMetrics` of the run cover all matches and models reproducibly.
 *
 * Failure isolation is per side and per match:
 *
 *  - a task that throws (or returns a non-finite score) marks only that side
 *    `ok: false` with the message; the opponent wins by forfeit and the
 *    tournament continues;
 *  - when both sides fail the match has no winner (`double_forfeit`); the
 *    runner stops advancing that bracket branch instead of aborting the run;
 *  - the runner loops round by round over `readyMatches` with a stall guard,
 *    so an undecided bracket terminates the loop with `complete: false`
 *    rather than spinning forever.
 *
 * Scores come from the injected task; a strict score tie goes to the better
 * seed (slot 0 of the match), keeping every outcome deterministic. Pure
 * computation only: no I/O, no clock, no randomness.
 */
import {
  createPrefixCache,
  type PrefixCache,
  type PrefixMeasurement,
  type PrefixMetrics,
  type StableRequest,
} from "../prefix-cache.ts";
import {
  bracketChampion,
  bracketComplete,
  buildBracket,
  readyMatches,
  recordResult,
  type Bracket,
  type BracketMatch,
} from "./bracket.ts";

/** Handed to the task for one side of one match. */
export interface MatchTurnContext {
  matchId: string;
  round: number;
  slot: number;
  model: string;
  /** Record one request on the shared prefix cache; returns the measurement. */
  record(request: StableRequest): PrefixMeasurement;
}

/** One side's workload: returns a finite score (plain number or `{ score }`). */
export type MatchTask = (ctx: MatchTurnContext) => number | { score: number };

/** What one model did in one match. */
export interface MatchSideResult {
  model: string;
  ok: boolean;
  score: number;
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  error: string | null;
}

/** One decided (or forfeited) match. */
export interface MatchResult {
  matchId: string;
  round: number;
  slot: number;
  players: readonly string[];
  sides: readonly MatchSideResult[];
  winner: string | null;
  outcome: "scored" | "forfeit" | "double_forfeit";
}

export interface MatchRunnerOptions {
  /** Injectable shared cache; defaults to a fresh `createPrefixCache()`. */
  cache?: PrefixCache;
}

/** Run both sides of `match` through `task`, isolated per side. */
export function runMatch(match: BracketMatch, task: MatchTask, options: MatchRunnerOptions = {}): MatchResult {
  const cache = options.cache ?? createPrefixCache();
  const sides: MatchSideResult[] = match.players.map((model, index) => playSide(match, model as string, index, task, cache));
  const left = sides[0] as MatchSideResult;
  const right = sides[1] as MatchSideResult;
  if (left.ok && right.ok) {
    // Higher score wins; a strict tie goes to the better seed (slot 0).
    const winner = left.score >= right.score ? left.model : right.model;
    return {
      matchId: match.matchId,
      round: match.round,
      slot: match.slot,
      players: match.players as readonly string[],
      sides,
      winner,
      outcome: "scored",
    };
  }
  if (left.ok !== right.ok) {
    return {
      matchId: match.matchId,
      round: match.round,
      slot: match.slot,
      players: match.players as readonly string[],
      sides,
      winner: left.ok ? left.model : right.model,
      outcome: "forfeit",
    };
  }
  return {
    matchId: match.matchId,
    round: match.round,
    slot: match.slot,
    players: match.players as readonly string[],
    sides,
    winner: null,
    outcome: "double_forfeit",
  };
}

function playSide(
  match: BracketMatch,
  model: string,
  index: number,
  task: MatchTask,
  cache: PrefixCache,
): MatchSideResult {
  let requests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const ctx: MatchTurnContext = {
    matchId: match.matchId,
    round: match.round,
    slot: match.slot,
    model,
    record(request) {
      const measurement = cache.record(`${match.matchId}/${model}`, model, request);
      requests += 1;
      if (measurement.hitChars > 0) cacheHits += 1;
      else cacheMisses += 1;
      return measurement;
    },
  };
  try {
    const returned = task(ctx);
    const score = typeof returned === "number" ? returned : returned.score;
    if (!Number.isFinite(score)) throw new Error(`task returned a non-finite score for ${model}`);
    return { model, ok: true, score, requests, cacheHits, cacheMisses, error: null };
  } catch (error) {
    return { model, ok: false, score: 0, requests, cacheHits, cacheMisses, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TournamentOptions extends MatchRunnerOptions {
  models: readonly string[];
  task: MatchTask;
  /** Hard cap on decided matches; default `4 * models.length`. */
  maxMatches?: number;
}

/** Everything about one full tournament run. */
export interface TournamentRunResult {
  bracket: Bracket;
  results: readonly MatchResult[];
  champion: string | null;
  complete: boolean;
  playedMatches: number;
  /** Aggregated shared-cache metrics over the whole run. */
  cacheMetrics: PrefixMetrics;
}

/**
 * Play the tournament round by round: every `ready` match runs through `task`
 * on the shared cache; decided matches advance the bracket, double forfeits
 * stop their branch (each match is attempted at most once, so a stalled match
 * contributes one log entry, not one per round), and the loop ends when the
 * bracket completes, stalls, or hits the match cap.
 */
export function runTournament(options: TournamentOptions): TournamentRunResult {
  const cache = options.cache ?? createPrefixCache();
  const cap = options.maxMatches ?? Math.max(1, 4 * options.models.length);
  let bracket = buildBracket(options.models);
  const results: MatchResult[] = [];
  let decided = 0;
  // A stalled undecided match stays `ready` forever, so it must be replayed at
  // most once per run; re-running it would duplicate its log entry and redo the
  // task's cache work.
  const attempted = new Set<string>();

  while (decided < cap) {
    const ready = readyMatches(bracket).filter((match) => !attempted.has(match.matchId));
    if (ready.length === 0) break;
    let advanced = 0;
    for (const match of ready) {
      if (decided >= cap) break;
      attempted.add(match.matchId);
      const result = runMatch(match, options.task, { cache });
      results.push(result);
      if (result.winner !== null) {
        bracket = recordResult(bracket, match.matchId, result.winner);
        decided += 1;
        advanced += 1;
      }
    }
    if (advanced === 0) break;
  }

  return {
    bracket,
    results,
    champion: bracketChampion(bracket),
    complete: bracketComplete(bracket),
    playedMatches: decided,
    cacheMetrics: cache.metrics(),
  };
}

/**
 * Default bench-style task: the model plays `turns` stable-append turns (each
 * request extends the previous conversation, the H01 pattern that maximizes
 * prefix hits) and scores the summed cache hit length. Deterministic: equal
 * turn counts and equal requests produce equal scores.
 */
export function stableAppendTask(turns = 8): MatchTask {
  return (ctx) => {
    const history: { role: string; content: string }[] = [];
    let score = 0;
    for (let turn = 0; turn < turns; turn += 1) {
      history.push({ role: "user", content: `tournament turn ${turn}: propose a patch.` });
      history.push({ role: "assistant", content: `tournament reply ${turn}: prefix stays byte-stable.` });
      const measurement = ctx.record({ messages: [...history] });
      score += measurement.hitChars;
    }
    return score;
  };
}
