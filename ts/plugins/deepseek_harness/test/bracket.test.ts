/** H09.01: deterministic tournament bracket and match contracts. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bracketChampion,
  bracketComplete,
  bracketRanking,
  buildBracket,
  findMatch,
  readyMatches,
  recordResult,
  type Bracket,
} from "../src/tournament/bracket.ts";

const models = (count: number): string[] => Array.from({ length: count }, (_, i) => `model-${i + 1}`);

describe("buildBracket (H09.01)", () => {
  it("rejects fewer than 2 models, empty names and duplicates", () => {
    assert.throws(() => buildBracket([]), /at least 2 models/);
    assert.throws(() => buildBracket(["solo"]), /at least 2 models/);
    assert.throws(() => buildBracket(["a", ""]), /non-empty strings/);
    assert.throws(() => buildBracket(["a", "b", "a"]), /duplicate bracket model: a/);
  });

  it("pairs two models into exactly one ready match", () => {
    const bracket = buildBracket(["a", "b"]);
    assert.equal(bracket.rounds.length, 1);
    const match = bracket.rounds[0]?.[0];
    assert.ok(match, "round 0 exists");
    assert.equal(match.matchId, "r0m0");
    assert.deepEqual(match.players, ["a", "b"]);
    assert.equal(match.status, "ready");
    assert.equal(match.winner, null);
    assert.deepEqual(readyMatches(bracket).map((m) => m.matchId), ["r0m0"]);
  });

  it("pairs by classic seeding: seed 1 meets seed N, seed 2 meets seed N-1", () => {
    const bracket = buildBracket(["s1", "s2", "s3", "s4"]);
    assert.deepEqual(
      (bracket.rounds[0] ?? []).map((m) => m.players),
      [["s1", "s4"], ["s2", "s3"]],
    );
  });

  it("gives byes only to the best seeds when N is not a power of two", () => {
    const bracket = buildBracket(["s1", "s2", "s3", "s4", "s5"]);
    const round0 = bracket.rounds[0] ?? [];
    assert.equal(round0.length, 4);
    const byes = round0.filter((m) => m.status === "bye");
    // The three byes all go to the top seeds s1..s3 against phantom opponents.
    assert.deepEqual(
      byes.map((m) => m.players),
      [["s1", null], ["s2", null], ["s3", null]],
    );
    assert.deepEqual(
      byes.map((m) => m.winner),
      ["s1", "s2", "s3"],
    );
    // The one real match of round 0 is s4 vs s5.
    const real = round0.filter((m) => m.status === "ready");
    assert.deepEqual(real.map((m) => m.players), [["s4", "s5"]]);
  });

  it("never pairs a bye against a bye for any N from 2 to 33", () => {
    for (let n = 2; n <= 33; n += 1) {
      const bracket = buildBracket(models(n));
      for (const match of bracket.rounds[0] ?? []) {
        assert.ok(
          match.players[0] !== null || match.players[1] !== null,
          `N=${n} pair ${match.matchId} is bye vs bye`,
        );
      }
      const expectedRounds = Math.ceil(Math.log2(n));
      assert.equal(bracket.rounds.length, expectedRounds, `N=${n} round count`);
    }
  });

  it("cascades round-0 byes into resolved round-1 players", () => {
    const bracket = buildBracket(["s1", "s2", "s3"]);
    const semi = bracket.rounds[1]?.[0];
    assert.ok(semi, "round 1 exists");
    assert.equal(semi.matchId, "r1m0");
    // s1 had a bye and waits for the s2 vs s3 winner.
    assert.deepEqual(semi.players, ["s1", null]);
    assert.deepEqual(semi.feeders, ["r0m0", "r0m1"]);
    assert.equal(semi.status, "pending");
    assert.deepEqual(readyMatches(bracket).map((m) => m.matchId), ["r0m1"]);
  });

  it("is deterministic: equal inputs produce deep-equal brackets", () => {
    const left = buildBracket(["m-a", "m-b", "m-c", "m-d", "m-e", "m-e2"]);
    const right = buildBracket(["m-a", "m-b", "m-c", "m-d", "m-e", "m-e2"]);
    assert.deepEqual(left, right);
  });
});

describe("recordResult (H09.01)", () => {
  it("advances the winner into the feeding slot of the next round", () => {
    let bracket = buildBracket(["a", "b", "c", "d"]);
    bracket = recordResult(bracket, "r0m0", "a");
    const semi1 = findMatch(bracket, "r1m0");
    assert.equal(semi1?.players[0], "a");
    assert.equal(semi1?.status, "pending");
    bracket = recordResult(bracket, "r0m1", "c");
    assert.deepEqual(findMatch(bracket, "r1m0")?.players, ["a", "c"]);
    assert.equal(findMatch(bracket, "r1m0")?.status, "ready");
    bracket = recordResult(bracket, "r1m0", "c");
    assert.equal(bracketChampion(bracket), "c");
    assert.equal(bracketComplete(bracket), true);
  });

  it("never mutates the input bracket", () => {
    const bracket = buildBracket(["a", "b", "c", "d"]);
    const before = JSON.stringify(bracket);
    const next = recordResult(bracket, "r0m0", "d");
    assert.equal(JSON.stringify(bracket), before);
    assert.notEqual(JSON.stringify(next), before);
    assert.equal(findMatch(next, "r0m0")?.winner, "d");
    assert.equal(findMatch(bracket, "r0m0")?.winner, null);
  });

  it("replaying the same results in the same order reproduces the bracket", () => {
    // Size-8 layout: m0=(a,h) m1=(d,e) m2=(b,g) m3=(c,f).
    const play = (): Bracket => {
      let bracket = buildBracket(["a", "b", "c", "d", "e", "f", "g", "h"]);
      bracket = recordResult(bracket, "r0m0", "a");
      bracket = recordResult(bracket, "r0m1", "e");
      bracket = recordResult(bracket, "r0m2", "g");
      bracket = recordResult(bracket, "r0m3", "c");
      bracket = recordResult(bracket, "r1m0", "a");
      bracket = recordResult(bracket, "r1m1", "c");
      bracket = recordResult(bracket, "r2m0", "c");
      return bracket;
    };
    assert.deepEqual(play(), play());
    assert.equal(bracketChampion(play()), "c");
  });

  it("rejects unknown matches, non-players, and non-ready matches", () => {
    const bracket = buildBracket(["a", "b", "c", "d"]);
    assert.throws(() => recordResult(bracket, "r9m9", "a"), /unknown match: r9m9/);
    assert.throws(() => recordResult(bracket, "r0m0", "z"), /not a player of r0m0/);
    assert.throws(() => recordResult(bracket, "r1m0", "a"), /not ready/);
    const played = recordResult(bracket, "r0m0", "a");
    assert.throws(() => recordResult(played, "r0m0", "b"), /not ready/);
  });

  it("bracketRanking orders by deepest round reached, then seed", () => {
    let bracket = buildBracket(["a", "b", "c", "d", "e"]);
    // Layout: m0=(a,bye) m1=(d,e) m2=(b,bye) m3=(c,bye).
    bracket = recordResult(bracket, "r0m1", "e"); // e eliminates d in round 0
    bracket = recordResult(bracket, "r1m0", "a"); // a beats e in the semis
    bracket = recordResult(bracket, "r1m1", "b"); // b beats c in the semis
    bracket = recordResult(bracket, "r2m0", "a"); // final
    // Depths: a,b reached round 2; c (seed 2) and e (seed 4) round 1; d round 0.
    assert.deepEqual(bracketRanking(bracket), ["a", "b", "c", "e", "d"]);
    assert.equal(bracketComplete(bracket), true);
  });

  it("bracketRanking puts the champion first even when it is the worse seed", () => {
    // Seed 4 (d) beats seed 1 (a) in the opening round, then wins the final:
    // both finalists reach round 1, so the seed tie-break must not outrank the title.
    let bracket = buildBracket(["a", "b", "c", "d"]);
    bracket = recordResult(bracket, "r0m0", "d");
    bracket = recordResult(bracket, "r0m1", "b");
    bracket = recordResult(bracket, "r1m0", "d");
    assert.equal(bracketChampion(bracket), "d");
    assert.deepEqual(bracketRanking(bracket), ["d", "b", "a", "c"]);
  });

  it("bracketComplete is false until the final is decided", () => {
    let bracket = buildBracket(["a", "b", "c", "d"]);
    assert.equal(bracketComplete(bracket), false);
    bracket = recordResult(bracket, "r0m0", "a");
    assert.equal(bracketComplete(bracket), false);
    bracket = recordResult(bracket, "r0m1", "b");
    bracket = recordResult(bracket, "r1m0", "b");
    assert.equal(bracketComplete(bracket), true);
    assert.equal(bracketChampion(bracket), "b");
  });
});
