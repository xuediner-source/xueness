/**
 * Scoring / Elo-lite aggregator over tournament match logs (H09.03).
 *
 * The aggregator folds a `MatchResult` log (H09.02 match-runner) into final
 * per-model standings with an Elo-lite rating:
 *
 *  - matches are folded strictly in log order with the standard update
 *    `expected = 1 / (1 + 10 ** ((opponent - self) / 400))` and one `kFactor`
 *    step per decided match, so identical logs produce byte-identical
 *    ratings — no clock, no randomness, no floating-point-order ambiguity;
 *  - `scored` and `forfeit` matches both update ratings (a forfeit is a full
 *    win for the surviving side); `double_forfeit` matches are skipped and
 *    counted in `matchesSkipped`, never silently dropped;
 *  - ratings are quantized to `ratingDecimals` (default 2) once per update,
 *    so serialized scores are byte-stable across runs;
 *  - standings sort by rating (desc), then wins (desc), then played (desc),
 *    then model name (asc) — a total order, so the ranking array itself is
 *    byte-stable even when ratings tie.
 *
 * Pure computation only: no I/O, no clock, no randomness.
 */
import type { MatchResult } from "./match-runner.ts";

/** Tunables; every field optional, all defaults fixed constants. */
export interface ScoringOptions {
  /** Elo step per decided match; default 32. */
  kFactor?: number;
  /** Starting rating for every model; default 1500. */
  initialRating?: number;
  /** Quantization of stored/serialized ratings; default 2. */
  ratingDecimals?: number;
}

/** One model's final line in the standings table. */
export interface ModelStanding {
  model: string;
  rank: number;
  rating: number;
  /** Rating change over the whole log (rating - initialRating). */
  delta: number;
  played: number;
  wins: number;
  losses: number;
  /** Decided matches this model lost by forfeit (task threw / non-finite). */
  forfeitLosses: number;
  /** Decided matches this model won because the opponent forfeited. */
  forfeitWins: number;
  /** Sum of raw task scores across sides that finished `ok`. */
  scoreSum: number;
  /** `scoreSum / played`, quantized like ratings; 0 when never played. */
  averageScore: number;
}

/** The full aggregated scoreboard for one tournament log. */
export interface Scoreboard {
  standings: readonly ModelStanding[];
  /** Decided matches folded into the ratings. */
  matchesCounted: number;
  /** `double_forfeit` matches skipped (they move no rating). */
  matchesSkipped: number;
  kFactor: number;
  initialRating: number;
}

const roundTo = (value: number, decimals: number): number => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};

interface Tally {
  rating: number;
  played: number;
  wins: number;
  losses: number;
  forfeitWins: number;
  forfeitLosses: number;
  scoreSum: number;
}

const expectedScore = (self: number, opponent: number): number => 1 / (1 + 10 ** ((opponent - self) / 400));

/**
 * Fold `results` (in array order) into standings for `models`. Throws when
 * `models` is empty/duplicated, when a result references an unknown model,
 * or when a decided match has no winner. Identical inputs return a
 * byte-identical scoreboard.
 */
export function scoreTournament(models: readonly string[], results: readonly MatchResult[], options: ScoringOptions = {}): Scoreboard {
  if (models.length === 0) throw new Error("scoring requires at least 1 model");
  const kFactor = options.kFactor ?? 32;
  const initialRating = options.initialRating ?? 1500;
  const ratingDecimals = options.ratingDecimals ?? 2;
  if (!Number.isFinite(kFactor) || kFactor <= 0) throw new Error("kFactor must be a positive finite number");
  if (!Number.isFinite(initialRating)) throw new Error("initialRating must be a finite number");
  if (!Number.isInteger(ratingDecimals) || ratingDecimals < 0 || ratingDecimals > 6) throw new Error("ratingDecimals must be an integer in [0, 6]");

  const tallies = new Map<string, Tally>();
  for (const model of models) {
    if (typeof model !== "string" || model.length === 0) throw new Error("scoring model names must be non-empty strings");
    if (tallies.has(model)) throw new Error(`duplicate scoring model: ${model}`);
    tallies.set(model, { rating: initialRating, played: 0, wins: 0, losses: 0, forfeitWins: 0, forfeitLosses: 0, scoreSum: 0 });
  }

  let matchesCounted = 0;
  let matchesSkipped = 0;
  for (const result of results) {
    const [left, right] = result.players;
    if (typeof left !== "string" || typeof right !== "string") throw new Error(`match ${result.matchId} has malformed players`);
    for (const player of [left, right]) {
      if (!tallies.has(player)) throw new Error(`match ${result.matchId} references unknown model: ${player}`);
    }
    // Side scores count whenever the side finished ok (forfeit sides carry 0).
    for (const side of result.sides) {
      if (side.ok) {
        const tally = tallies.get(side.model);
        if (tally) tally.scoreSum += side.score;
      }
    }
    if (result.outcome === "double_forfeit" || result.winner === null) {
      matchesSkipped += 1;
      continue;
    }
    if (result.winner !== left && result.winner !== right) throw new Error(`match ${result.matchId} winner ${result.winner} is not one of its players`);

    const loser = result.winner === left ? right : left;
    const winnerTally = tallies.get(result.winner) as Tally;
    const loserTally = tallies.get(loser) as Tally;
    const expectedWinner = expectedScore(winnerTally.rating, loserTally.rating);
    const expectedLoser = 1 - expectedWinner;
    winnerTally.rating = roundTo(winnerTally.rating + kFactor * (1 - expectedWinner), ratingDecimals);
    loserTally.rating = roundTo(loserTally.rating + kFactor * (0 - expectedLoser), ratingDecimals);

    winnerTally.played += 1;
    loserTally.played += 1;
    winnerTally.wins += 1;
    loserTally.losses += 1;
    if (result.outcome === "forfeit") {
      winnerTally.forfeitWins += 1;
      loserTally.forfeitLosses += 1;
    }
    matchesCounted += 1;
  }

  const standings: ModelStanding[] = [...tallies.entries()].map(([model, tally]) => ({
    model,
    rank: 0,
    rating: roundTo(tally.rating, ratingDecimals),
    delta: roundTo(tally.rating - initialRating, ratingDecimals),
    played: tally.played,
    wins: tally.wins,
    losses: tally.losses,
    forfeitWins: tally.forfeitWins,
    forfeitLosses: tally.forfeitLosses,
    scoreSum: roundTo(tally.scoreSum, ratingDecimals),
    averageScore: tally.played === 0 ? 0 : roundTo(tally.scoreSum / tally.played, ratingDecimals),
  }));
  standings.sort((a, b) => {
    if (a.rating !== b.rating) return b.rating - a.rating;
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.played !== b.played) return b.played - a.played;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
  standings.forEach((standing, index) => {
    standing.rank = index + 1;
  });

  return { standings, matchesCounted, matchesSkipped, kFactor, initialRating };
}
