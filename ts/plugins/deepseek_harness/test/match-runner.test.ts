/** H09.02: match runner on the shared H01 prefix-cache, with failure isolation. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPrefixCache, type StableRequest } from "../src/prefix-cache.ts";
import { buildBracket, findMatch, readyMatches, type BracketMatch } from "../src/tournament/bracket.ts";
import {
  runMatch,
  runTournament,
  stableAppendTask,
  type MatchResult,
  type MatchTask,
} from "../src/tournament/match-runner.ts";

const openingMatch = (models: string[]): BracketMatch => {
  const match = readyMatches(buildBracket(models))[0];
  assert.ok(match, "opening match exists");
  return match;
};

const oneTurnTask =
  (scores: Record<string, number>): MatchTask =>
  (ctx) => {
    const request: StableRequest = { messages: [{ role: "user", content: `play ${ctx.matchId}` }] };
    ctx.record(request);
    return scores[ctx.model] ?? 0;
  };

describe("runMatch (H09.02)", () => {
  it("decides the match by score and reports per-side cache numbers", () => {
    const result = runMatch(openingMatch(["a", "b"]), oneTurnTask({ a: 3, b: 7 }));
    assert.equal(result.winner, "b");
    assert.equal(result.outcome, "scored");
    assert.deepEqual(result.sides.map((side) => side.model), ["a", "b"]);
    for (const side of result.sides) {
      assert.equal(side.ok, true);
      assert.equal(side.requests, 1);
      // First request of a session is always a cache miss.
      assert.equal(side.cacheMisses, 1);
      assert.equal(side.cacheHits, 0);
    }
  });

  it("breaks score ties deterministically for the better seed (slot 0)", () => {
    const even = oneTurnTask({ a: 5, b: 5 });
    assert.equal(runMatch(openingMatch(["a", "b"]), even).winner, "a");
    assert.equal(runMatch(openingMatch(["a", "b"]), even).winner, "a");
  });

  it("forfeits only the failing side; the opponent advances", () => {
    const task: MatchTask = (ctx) => {
      if (ctx.model === "b") throw new Error("provider 500");
      return 1;
    };
    const result = runMatch(openingMatch(["a", "b"]), task);
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.winner, "a");
    const failed = result.sides[1];
    assert.ok(failed, "second side exists");
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "provider 500");
    assert.equal(failed.score, 0);
    assert.equal(result.sides[0]?.ok, true);
  });

  it("double forfeit leaves the match undecided", () => {
    const task: MatchTask = () => {
      throw new Error("no route");
    };
    const result = runMatch(openingMatch(["a", "b"]), task);
    assert.equal(result.outcome, "double_forfeit");
    assert.equal(result.winner, null);
    assert.ok(result.sides.every((side) => side.ok === false));
  });

  it("rejects non-finite scores as a failed side, not a crash", () => {
    const result = runMatch(openingMatch(["a", "b"]), oneTurnTask({ a: Number.NaN, b: 2 }));
    assert.equal(result.sides[0]?.ok, false);
    assert.match(result.sides[0]?.error as string, /non-finite score/);
    assert.equal(result.winner, "b");
    assert.equal(result.outcome, "forfeit");
  });

  it("accepts { score } objects as well as plain numbers", () => {
    const result = runMatch(openingMatch(["a", "b"]), (ctx) => (ctx.model === "a" ? { score: 9 } : { score: 4 }));
    assert.equal(result.winner, "a");
  });
});

describe("shared prefix-cache reuse (H09.02, H01.03)", () => {
  it("records every side of every match on the one shared cache", () => {
    const cache = createPrefixCache();
    const task = oneTurnTask({ a: 1, b: 2, c: 3, d: 4 });
    const result = runTournament({ models: ["a", "b", "c", "d"], task, cache });
    assert.equal(result.complete, true);
    // 3 decided matches x 2 sides = 6 recorded requests, 2 sessions per match.
    assert.equal(result.results.length, 3);
    assert.equal(
      result.cacheMetrics.models.reduce((sum, entry) => sum + entry.requests, 0),
      6,
    );
    // m0=(a,d) m1=(b,c), final d vs c won by c: finalists play twice.
    const finalists = result.cacheMetrics.models.filter((entry) => entry.requests === 2).map((entry) => entry.model);
    assert.deepEqual(finalists, ["c", "d"]);
    const b = result.cacheMetrics.models.find((entry) => entry.model === "b");
    assert.equal(b?.requests, 1);
  });

  it("stable-append turns hit the shared cache on every turn after the first", () => {
    const cache = createPrefixCache();
    const match = openingMatch(["a", "b"]);
    const result = runMatch(match, stableAppendTask(6), { cache });
    for (const side of result.sides) {
      assert.equal(side.requests, 6);
      assert.equal(side.cacheMisses, 1, "only the first turn can miss");
      assert.equal(side.cacheHits, 5);
      assert.ok(side.score > 0, "score accumulates hit length");
    }
    assert.equal(result.outcome, "scored");
  });

  it("session keys are scoped per match and model", () => {
    const cache = createPrefixCache();
    const seen: string[] = [];
    const task: MatchTask = (ctx) => {
      seen.push(`${ctx.matchId}/${ctx.model}`);
      ctx.record({ messages: [{ role: "user", content: "ping" }] });
      return 1;
    };
    runTournament({ models: ["a", "b", "c", "d"], task, cache });
    assert.equal(seen.length, 6);
    assert.ok(seen.every((key) => /^r\d+m\d+\/[abcd]$/.test(key)));
    assert.equal(new Set(seen).size, 6);
  });
});

describe("runTournament (H09.02)", () => {
  it("plays the bracket to a champion and matches manual recordResult", () => {
    const result = runTournament({ models: ["a", "b", "c", "d"], task: oneTurnTask({ a: 10, b: 5, c: 7, d: 3 }) });
    assert.equal(result.complete, true);
    assert.equal(result.playedMatches, 3);
    assert.equal(result.champion, "a");
    assert.deepEqual(
      result.results.map((match) => match.winner),
      ["a", "c", "a"],
    );
    assert.equal(findMatch(result.bracket, "r1m0")?.players[0], "a");
  });

  it("isolates a failing model: forfeits lose, the tournament still completes", () => {
    const task: MatchTask = (ctx) => {
      if (ctx.model === "b") throw new Error("boom");
      return 1;
    };
    const result = runTournament({ models: ["a", "b", "c", "d"], task });
    // Layout m0=(a,d) m1=(b,c): b forfeits to c, then a beats c in the final.
    assert.equal(result.complete, true);
    assert.equal(result.champion, "a");
    const forfeit = result.results.find((match) => match.outcome === "forfeit");
    assert.equal(forfeit?.winner, "c");
    assert.ok(result.results.every((match) => match.outcome !== "double_forfeit"));
  });

  it("stops with complete:false when a match double-forfeits", () => {
    const task: MatchTask = (ctx) => {
      // Every model fails; every match is a double forfeit.
      throw new Error(`down: ${ctx.model}`);
    };
    const result = runTournament({ models: ["a", "b", "c", "d"], task });
    assert.equal(result.complete, false);
    assert.equal(result.champion, null);
    assert.equal(result.playedMatches, 0);
    assert.ok(result.results.length > 0);
    assert.ok(result.results.every((match: MatchResult) => match.outcome === "double_forfeit"));
    assert.ok(result.results.every((match) => match.sides.every((side) => side.ok === false)));
  });

  it("logs a stalled match once instead of replaying it every round", () => {
    // r0m0 double-forfeits (a and d both fail) while the sibling branch still
    // plays, so the bracket stays incomplete with r0m0 permanently `ready`.
    const result = runTournament({
      models: ["a", "b", "c", "d"],
      task: (ctx) => {
        if (ctx.model === "a" || ctx.model === "d") throw new Error("down");
        return 5;
      },
    });
    assert.equal(result.complete, false);
    assert.deepEqual(result.results.map((match) => match.matchId), ["r0m0", "r0m1"]);
    assert.equal(result.playedMatches, 1);
  });

  it("reuses an injected cache across the whole run deterministically", () => {
    const cache = createPrefixCache();
    const runOnce = () => runTournament({ models: ["a", "b", "c", "d", "e"], task: oneTurnTask({ a: 1, b: 2, c: 3, d: 4, e: 5 }), cache });
    const first = runOnce();
    assert.equal(first.champion, "e");
    assert.equal(first.complete, true);
    // Same cache: replaying the identical tournament doubles every model count.
    const second = runOnce();
    assert.equal(second.champion, "e");
    // One run: a=1 b=1 c=2 d=1 e=3 (champion e and runner-up c reach the final).
    const totals = new Map(first.cacheMetrics.models.concat(second.cacheMetrics.models).map((entry) => [entry.model, entry.requests]));
    assert.deepEqual([...totals.entries()].sort(), [
      ["a", 2],
      ["b", 2],
      ["c", 4],
      ["d", 2],
      ["e", 6],
    ]);
  });

  it("respects the maxMatches cap and reports the truncation", () => {
    const result = runTournament({ models: ["a", "b", "c", "d"], task: oneTurnTask({ a: 1, b: 2, c: 3, d: 4 }), maxMatches: 2 });
    assert.equal(result.playedMatches, 2);
    assert.equal(result.complete, false);
    assert.equal(result.champion, null);
    assert.equal(result.results.length, 2, "round 0 ran, the final never did");
  });

  it("stableAppendTask yields a reproducible, seed-ordered champion on equal play", () => {
    const first = runTournament({ models: ["a", "b", "c", "d"], task: stableAppendTask(4) });
    const second = runTournament({ models: ["a", "b", "c", "d"], task: stableAppendTask(4) });
    assert.deepEqual(first.results, second.results);
    assert.deepEqual(first.cacheMetrics, second.cacheMetrics);
    assert.equal(first.champion, "a");
    assert.equal(first.complete, true);
  });
});
