/**
 * Deterministic single-elimination tournament bracket (H09.01).
 *
 * The bracket is a pure data structure built from the model list alone:
 *
 *  - `buildBracket` seeds models in the order given (seed 1 = first entry)
 *    into a standard single-elimination layout sized to the next power of two.
 *    Slot order comes from the classic bit-reversal style construction
 *    (`order(2s) = for v of order(s): [v, 2s-1-v]`), so adjacent first-round
 *    slots pair the extremes of the seed range: seed 1 meets seed N, seed 2
 *    meets seed N-1. Leftover slots (N below a power of two) become byes,
 *    i.e. `null` entries that are spread across the opening round; a bye never
 *    meets a bye;
 *  - every mutation is a pure function returning a new bracket: `recordResult`
 *    validates the match is ready and the winner is one of its players, then
 *    propagates the winner into the feeding slot of the next round. The input
 *    bracket is never mutated, so replaying the same results in the same order
 *    reproduces the identical bracket;
 *  - match ids are positional (`r<round>m<slot>`), so ids, pairings and bye
 *    placement are a deterministic function of the model list — equal inputs
 *    produce byte-identical structures, no clock, no randomness.
 *
 * Pure computation only: no I/O, no clock, no randomness.
 */

/** Lifecycle of one bracket match. */
export type BracketStatus = "pending" | "ready" | "played" | "bye";

/**
 * One match. `players` holds exactly two entries, `null` until the feeding
 * match resolves; `feeders` names those matches (`null` in round 0). A `bye`
 * match has its winner fixed at build time and was never played.
 */
export interface BracketMatch {
  matchId: string;
  round: number;
  slot: number;
  players: readonly (string | null)[];
  feeders: readonly (string | null)[];
  winner: string | null;
  status: BracketStatus;
}

/** A full bracket: round 0 is the opening round, the last round is the final. */
export interface Bracket {
  models: readonly string[];
  rounds: readonly (readonly BracketMatch[])[];
}

/** Slot order for `size` (a power of two): adjacent entries sum to `size - 1`. */
function seedOrder(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const doubled = order.length * 2;
    const next: number[] = [];
    for (const seed of order) next.push(seed, doubled - 1 - seed);
    order = next;
  }
  return order;
}

const cloneMatch = (match: BracketMatch): BracketMatch => ({
  matchId: match.matchId,
  round: match.round,
  slot: match.slot,
  players: [...match.players],
  feeders: [...match.feeders],
  winner: match.winner,
  status: match.status,
});

const cloneBracket = (bracket: Bracket): Bracket => ({
  models: bracket.models,
  rounds: bracket.rounds.map((round) => round.map(cloneMatch)),
});

/** Index an array, mapping out-of-range to `null` (noUncheckedIndexedAccess-safe). */
function slotOf<T>(values: readonly T[], index: number): T | null {
  return index >= 0 && index < values.length ? (values[index] as T) : null;
}

/**
 * Build the opening bracket for `models` (at least 2, names unique and
 * non-empty). Byes resolve immediately; every other round-0 match is `ready`.
 */
export function buildBracket(models: readonly string[]): Bracket {
  if (models.length < 2) throw new Error("bracket requires at least 2 models");
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model !== "string" || model.length === 0) throw new Error("bracket model names must be non-empty strings");
    if (seen.has(model)) throw new Error(`duplicate bracket model: ${model}`);
    seen.add(model);
  }
  let size = 1;
  while (size < models.length) size *= 2;
  const order = seedOrder(size);
  const slots: (string | null)[] = order.map((seed) => slotOf(models, seed));

  const roundCount = Math.log2(size);
  const rounds: BracketMatch[][] = [];
  for (let round = 0; round < roundCount; round += 1) {
    const matchCount = size >> (round + 1);
    rounds.push(
      Array.from({ length: matchCount }, (_, slot): BracketMatch => {
        const feeders: (string | null)[] =
          round === 0 ? [null, null] : [`r${round - 1}m${slot * 2}`, `r${round - 1}m${slot * 2 + 1}`];
        const players: (string | null)[] = round === 0 ? [slots[slot * 2] ?? null, slots[slot * 2 + 1] ?? null] : [null, null];
        return { matchId: `r${round}m${slot}`, round, slot, players, feeders, winner: null, status: "pending" };
      }),
    );
  }

  const bracket: Bracket = { models, rounds };
  // Round 0 byes resolve at build time; their winners cascade into round 1.
  for (const match of rounds[0] ?? []) {
    const left = match.players[0] ?? null;
    const right = match.players[1] ?? null;
    if (left !== null && right === null) {
      match.winner = left;
      match.status = "bye";
    } else if (left === null && right !== null) {
      match.winner = right;
      match.status = "bye";
    } else {
      match.status = "ready";
    }
  }
  settleReadyState(bracket);
  return bracket;
}

/** Recompute `ready`/`pending` from resolved feeders; resolves bye cascades. */
function settleReadyState(bracket: Bracket): void {
  for (let round = 1; round < bracket.rounds.length; round += 1) {
    for (const match of bracket.rounds[round] ?? []) {
      if (match.status === "played" || match.status === "bye") continue;
      const left = winnerOf(bracket, match.feeders[0] ?? null);
      const right = winnerOf(bracket, match.feeders[1] ?? null);
      match.players = [left, right];
      if (left !== null && right !== null) match.status = "ready";
    }
  }
}

function winnerOf(bracket: Bracket, matchId: string | null): string | null {
  if (matchId === null) return null;
  const match = findMatch(bracket, matchId);
  return match === null ? null : match.winner;
}

/** Every match whose two players are known and which has not been played. */
export function readyMatches(bracket: Bracket): readonly BracketMatch[] {
  const ready: BracketMatch[] = [];
  for (const round of bracket.rounds) for (const match of round) if (match.status === "ready") ready.push(match);
  return ready;
}

/** The match with this id, or null. */
export function findMatch(bracket: Bracket, matchId: string): BracketMatch | null {
  for (const round of bracket.rounds) for (const match of round) if (match.matchId === matchId) return match;
  return null;
}

/** True when every match is resolved (played or bye). */
export function bracketComplete(bracket: Bracket): boolean {
  return bracket.rounds.every((round) => round.every((match) => match.status === "played" || match.status === "bye"));
}

/** Winner of the final, or null while the tournament is unfinished. */
export function bracketChampion(bracket: Bracket): string | null {
  const final = slotOf(slotOf(bracket.rounds, bracket.rounds.length - 1) ?? [], 0);
  return final !== null && (final.status === "played" || final.status === "bye") ? final.winner : null;
}

/**
 * Record `winner` for `matchId` on a fresh copy of the bracket. Throws when
 * the match is unknown, not yet ready, already decided, or the winner is not
 * one of its two players. The input bracket is left untouched.
 */
export function recordResult(bracket: Bracket, matchId: string, winner: string): Bracket {
  const match = findMatch(bracket, matchId);
  if (!match) throw new Error(`unknown match: ${matchId}`);
  if (match.status !== "ready") throw new Error(`match ${matchId} is not ready (status: ${match.status})`);
  if (winner !== (match.players[0] ?? null) && winner !== (match.players[1] ?? null)) {
    throw new Error(`${winner} is not a player of ${matchId}`);
  }

  const next = cloneBracket(bracket);
  const round = slotOf(next.rounds, match.round) ?? [];
  const played = slotOf(round, match.slot);
  if (played === null) throw new Error(`unknown match: ${matchId}`);
  played.winner = winner;
  played.status = "played";
  settleReadyState(next);
  return next;
}

/**
 * Deterministic final standings: models sorted by the number of rounds they
 * survived (descending), then by seed (ascending). The champion — the single
 * model that won the final round — therefore always ranks first.
 */
export function bracketRanking(bracket: Bracket): readonly string[] {
  const champion = bracketChampion(bracket);
  const lastRound = bracket.rounds.length - 1;
  const depth = new Map<string, number>();
  bracket.models.forEach((model) => {
    let reached = -1;
    bracket.rounds.forEach((round) => {
      round.forEach((match) => {
        if (match.players.includes(model)) reached = Math.max(reached, match.round);
      });
    });
    // A model only ever reaches the final round by winning it, so the champion
    // survives one round more than the runner-up it beat there. Without this
    // bonus both share the same depth and the seed tie-break could rank the
    // runner-up (better seed) above the champion.
    const survived = reached === -1 ? 0 : model === champion && reached === lastRound ? reached + 1 : reached;
    depth.set(model, survived);
  });
  const seedOf = (model: string): number => bracket.models.indexOf(model);
  return [...bracket.models].sort((left, right) => {
    const leftDepth = depth.get(left) ?? 0;
    const rightDepth = depth.get(right) ?? 0;
    if (leftDepth !== rightDepth) return rightDepth - leftDepth;
    return seedOf(left) < seedOf(right) ? -1 : 1;
  });
}
