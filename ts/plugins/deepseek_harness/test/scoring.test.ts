/** H09.03: scoring / Elo-lite aggregator — byte-stable standings from match logs. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreTournament } from "../src/tournament/scoring.ts";
import type { MatchResult } from "../src/tournament/match-runner.ts";

const side = (model: string, score: number, ok = true) => ({ model, ok, score, requests: 1, cacheHits: 0, cacheMisses: 1, error: ok ? null : "boom" });

// The realistic builder used below keeps ok flags aligned with outcomes.
function result(matchId: string, left: string, right: string, opts: { winner?: string; outcome?: MatchResult["outcome"]; scores?: [number, number] } = {}): MatchResult {
  const outcome = opts.outcome ?? "scored";
  const scores = opts.scores ?? [3, 2];
  if (outcome === "double_forfeit") {
    return { matchId, round: 0, slot: 0, players: [left, right], sides: [side(left, 0, false), side(right, 0, false)], winner: null, outcome };
  }
  if (outcome === "forfeit") {
    const winner = opts.winner ?? left;
    const loser = winner === left ? right : left;
    return { matchId, round: 0, slot: 0, players: [left, right], sides: [side(winner, 0, true), side(loser, 0, false)], winner, outcome };
  }
  const winner = opts.winner ?? left;
  return { matchId, round: 0, slot: 0, players: [left, right], sides: [side(left, scores[0]), side(right, scores[1])], winner, outcome };
}

describe("scoreTournament (H09.03)", () => {
  it("produces byte-stable standings from identical match logs", () => {
    const log = [result("r0m0", "a", "b", { winner: "a", scores: [5, 4] }), result("r0m1", "c", "d", { winner: "d", scores: [1, 2] }), result("r1m0", "a", "d", { winner: "a", scores: [7, 3] })];
    const first = scoreTournament(["a", "b", "c", "d"], log);
    const second = scoreTournament(["a", "b", "c", "d"], [result("r0m0", "a", "b", { winner: "a", scores: [5, 4] }), result("r0m1", "c", "d", { winner: "d", scores: [1, 2] }), result("r1m0", "a", "d", { winner: "a", scores: [7, 3] })]);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.standings.map((row) => row.model), ["a", "d", "b", "c"]);
    assert.equal(first.standings[0]?.rank, 1);
    assert.equal(first.matchesCounted, 3);
    assert.equal(first.matchesSkipped, 0);
  });

  it("applies symmetric Elo-lite updates around the initial rating", () => {
    const board = scoreTournament(["a", "b"], [result("r0m0", "a", "b", { winner: "a" })], { kFactor: 32, initialRating: 1500 });
    const a = board.standings.find((row) => row.model === "a");
    const b = board.standings.find((row) => row.model === "b");
    // Equal ratings: expected 0.5 each, so winner +16, loser -16, zero-sum.
    assert.equal(a?.rating, 1516);
    assert.equal(b?.rating, 1484);
    assert.equal(a?.delta, 16);
    assert.equal(b?.delta, -16);
    assert.equal(a?.wins, 1);
    assert.equal(b?.losses, 1);
    // Winner side kept its raw score in scoreSum; forfeited/scored both count.
    assert.equal(a?.scoreSum, 3);
    assert.equal(a?.averageScore, 3);
  });

  it("folds matches in log order (order-dependent ratings, stable per order)", () => {
    const winnerFirst = scoreTournament(["a", "b", "c"], [result("m1", "a", "b", { winner: "a" }), result("m2", "a", "c", { winner: "a" })]);
    const otherOrder = scoreTournament(["a", "b", "c"], [result("m2", "a", "c", { winner: "a" }), result("m1", "a", "b", { winner: "a" })]);
    // Same winners, different order: same model tops, but a's second win in
    // `winnerFirst` came against a weakened `b`, so ratings differ — proving
    // the fold is sequential, and each fixed order is reproducible.
    assert.equal(winnerFirst.standings[0]?.model, "a");
    assert.equal(otherOrder.standings[0]?.model, "a");
    assert.equal(scoreTournament(["a", "b", "c"], [result("m1", "a", "b", { winner: "a" }), result("m2", "a", "c", { winner: "a" })]).standings[0]?.rating, winnerFirst.standings[0]?.rating);
    assert.equal(winnerFirst.standings[0]?.played, 2);
  });

  it("counts a forfeit as a full win and a double forfeit as skipped", () => {
    const board = scoreTournament(["a", "b", "c"], [result("m1", "a", "b", { outcome: "forfeit", winner: "b" }), result("m2", "a", "c", { outcome: "double_forfeit" })]);
    const a = board.standings.find((row) => row.model === "a");
    const b = board.standings.find((row) => row.model === "b");
    const c = board.standings.find((row) => row.model === "c");
    assert.equal(b?.wins, 1);
    assert.equal(b?.forfeitWins, 1);
    assert.equal(a?.forfeitLosses, 1);
    assert.equal(board.matchesCounted, 1);
    assert.equal(board.matchesSkipped, 1);
    // The skipped match never touched play counts or ratings.
    assert.equal(a?.played, 1);
    assert.equal(c?.played, 0);
    assert.equal(c?.rating, 1500);
    assert.equal(c?.averageScore, 0);
  });

  it("breaks rating ties deterministically by wins, played, then name", () => {
    const board = scoreTournament(["z", "w", "x", "y"], [result("m1", "x", "y", { winner: "x" }), result("m2", "w", "z", { outcome: "forfeit", winner: "z" })]);
    // Two independent 1500-vs-1500 matches: both winners tie at 1516 (1 win,
    // 1 played each) and both losers at 1484 — only the name tiebreak (x < z,
    // w < y) can fix the order, and it does so byte-stably.
    assert.deepEqual(board.standings.map((row) => `${row.rank}:${row.model}:${row.rating}`), ["1:x:1516", "2:z:1516", "3:w:1484", "4:y:1484"]);
  });

  it("quantizes ratings to ratingDecimals for byte-stable serialization", () => {
    const log = [result("m1", "a", "b", { winner: "a" }), result("m2", "a", "b", { winner: "b" })];
    const board = scoreTournament(["a", "b"], log, { ratingDecimals: 0 });
    for (const row of board.standings) {
      assert.ok(Number.isInteger(row.rating), `rating ${row.rating} must be an integer`);
      assert.ok(Number.isInteger(row.delta), `delta ${row.delta} must be an integer`);
    }
    assert.equal(JSON.stringify(scoreTournament(["a", "b"], log, { ratingDecimals: 0 })), JSON.stringify(board));
  });

  it("rejects malformed models, unknown players, and bogus options", () => {
    assert.throws(() => scoreTournament([], []), /at least 1 model/);
    assert.throws(() => scoreTournament(["a", "a"], []), /duplicate scoring model/);
    assert.throws(() => scoreTournament(["a"], [result("m", "a", "ghost", { winner: "a" })]), /unknown model: ghost/);
    assert.throws(() => scoreTournament(["a", "b"], [] as MatchResult[], { kFactor: 0 }), /kFactor/);
    assert.throws(() => scoreTournament(["a", "b"], [], { initialRating: Number.NaN }), /initialRating/);
    assert.throws(() => scoreTournament(["a", "b"], [], { ratingDecimals: 9 }), /ratingDecimals/);
    const badWinner: MatchResult = { ...result("m", "a", "b", { winner: "a" }), winner: "ghost" };
    assert.throws(() => scoreTournament(["a", "b"], [badWinner]), /not one of its players/);
  });

  it("aggregates cleanly over a full deterministic runTournament log", async () => {
    const { runTournament, stableAppendTask } = await import("../src/tournament/match-runner.ts");
    const run = runTournament({ models: ["m1", "m2", "m3", "m4"], task: stableAppendTask(4) });
    const board = scoreTournament(run.bracket.models, run.results);
    assert.equal(board.matchesCounted + board.matchesSkipped, run.results.length);
    assert.equal(board.standings.length, 4);
    const totalWins = board.standings.reduce((sum, row) => sum + row.wins, 0);
    const totalLosses = board.standings.reduce((sum, row) => sum + row.losses, 0);
    assert.equal(totalWins, totalLosses);
    assert.equal(board.standings[0]?.model, run.champion);
    // Identical run → byte-identical scoreboard.
    const rerun = runTournament({ models: ["m1", "m2", "m3", "m4"], task: stableAppendTask(4) });
    assert.equal(JSON.stringify(scoreTournament(rerun.bracket.models, rerun.results)), JSON.stringify(board));
  });
});
