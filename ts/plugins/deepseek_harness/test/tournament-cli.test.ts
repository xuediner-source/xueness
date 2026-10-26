/** H09.04: `deepseek_harness/tournament` RPC method and `xueness harness tournament` CLI, end-to-end offline. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessApi, HARNESS_METHODS, harnessCommand } from "../src/index.ts";
import type { Scoreboard } from "../src/tournament/scoring.ts";

interface TournamentRow {
  ok: boolean;
  champion: string | null;
  complete: boolean;
  playedMatches: number;
  matches: { matchId: string; outcome: string; winner: string | null }[];
  standings: Scoreboard["standings"];
  matchesCounted: number;
  matchesSkipped: number;
  cacheMetrics: Record<string, unknown>;
}

const api = (): ReturnType<typeof createHarnessApi> => createHarnessApi();

describe("deepseek_harness/tournament RPC (H09.04)", () => {
  it("registers the method alongside the existing surface", () => {
    assert.ok(HARNESS_METHODS.includes("deepseek_harness/tournament" as (typeof HARNESS_METHODS)[number]));
    const surface = api();
    assert.equal(surface.owns("deepseek_harness/tournament"), true);
    assert.equal(surface.owns("deepseek_harness/nope"), false);
    assert.equal(surface.methods.length, HARNESS_METHODS.length);
    assert.ok(HARNESS_METHODS.includes("deepseek_harness/optimize" as (typeof HARNESS_METHODS)[number]));
    assert.ok(HARNESS_METHODS.includes("deepseek_harness/chaos" as (typeof HARNESS_METHODS)[number]));
  });

  it("runs a 4-model tournament end-to-end offline and reports the scoreboard", async () => {
    const result = (await api().dispatch("deepseek_harness/tournament", { models: ["alpha", "beta", "gamma", "delta"] })) as unknown as TournamentRow;
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(typeof result.champion, "string");
    assert.equal(result.playedMatches, 3); // 2 semifinals + 1 final, no byes
    assert.equal(result.matches.length, 3);
    assert.equal(result.matchesCounted, 3);
    assert.equal(result.matchesSkipped, 0);
    assert.equal(result.standings.length, 4);
    assert.equal(result.standings[0]?.model, result.champion);
    assert.equal(result.standings[0]?.rank, 1);
    // Offline proof: every match ran the pure stable-append task and left
    // shared-cache metrics behind.
    assert.ok(result.matches.every((match) => match.outcome === "scored"));
    assert.ok(result.cacheMetrics && typeof result.cacheMetrics === "object");
  });

  it("is byte-stable: identical payloads return byte-identical rows", async () => {
    const surface = api();
    const first = await surface.dispatch("deepseek_harness/tournament", { models: ["m1", "m2", "m3"], turns: 3 });
    const second = await surface.dispatch("deepseek_harness/tournament", { models: ["m1", "m2", "m3"], turns: 3 });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });

  it("honors scoring options and handles byes with non-power-of-two fields", async () => {
    const result = (await api().dispatch("deepseek_harness/tournament", { models: ["a", "b", "c"], kFactor: 10, initialRating: 2000 })) as unknown as TournamentRow & { standings: { rating: number }[] };
    assert.equal(result.ok, true);
    // kFactor 10, initial 2000: `a` gets a round-0 bye (+0), then +5.07 for
    // beating the semifinal winner (already above 2000) — deterministic.
    assert.equal(result.standings[0]?.rating, 2005.07);
    assert.ok(result.playedMatches >= 2);
  });

  it("rejects malformed payloads with invalid_input", async () => {
    const surface = api();
    for (const payload of [
      {},
      { models: [] },
      { models: ["only-one"] },
      { models: "alpha,beta" },
      { models: ["alpha", ""] },
      { models: ["alpha", "alpha"] },
      { models: ["alpha", "beta"], turns: 0 },
      { models: ["alpha", "beta"], turns: 1.5 },
      { models: ["alpha", "beta"], turns: "4" },
      { models: ["alpha", "beta"], kFactor: -1 },
      { models: ["alpha", "beta"], initialRating: "high" },
    ]) {
      const result = (await surface.dispatch("deepseek_harness/tournament", payload)) as { ok: boolean; error?: { code: string; message: string } };
      assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} must fail`);
      assert.equal(result.error?.code, "invalid_input", `payload ${JSON.stringify(payload)} must be invalid_input`);
    }
  });

  it("stays disabled under a false feature gate like every other method", async () => {
    const surface = createHarnessApi({ enabled: () => false });
    const result = (await surface.dispatch("deepseek_harness/tournament", { models: ["a", "b"] })) as { ok: boolean; error: { code: string } };
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "disabled");
  });
});

describe("xueness harness tournament CLI (H09.04)", () => {
  it("exits 0 and prints a parseable tournament row", async () => {
    const run = await harnessCommand(["tournament", "alpha,beta,gamma,delta"]);
    assert.equal(run.code, 0);
    const parsed = JSON.parse(run.output) as TournamentRow;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.standings.length, 4);
    assert.equal(parsed.standings[0]?.model, parsed.champion);
  });

  it("accepts an explicit turns count and stays byte-stable across runs", async () => {
    const first = await harnessCommand(["tournament", "alpha,beta,gamma", "2"]);
    const second = await harnessCommand(["tournament", "alpha,beta,gamma", "2"]);
    assert.equal(first.code, 0);
    assert.equal(first.output, second.output);
    const parsed = JSON.parse(first.output) as TournamentRow;
    assert.equal(parsed.ok, true);
  });

  it("exits 2 for usage errors and invalid payloads", async () => {
    assert.equal((await harnessCommand(["tournament"])).code, 2);
    assert.equal((await harnessCommand(["tournament", "solo"])).code, 2);
    const dupes = await harnessCommand(["tournament", "alpha,alpha"]);
    assert.equal(dupes.code, 2);
    assert.match(dupes.output, /invalid_input/);
    const badTurns = await harnessCommand(["tournament", "alpha,beta", "zero"]);
    assert.equal(badTurns.code, 2);
    assert.equal((await harnessCommand(["tournament", "alpha,beta", "0"])).code, 2);
  });

  it("keeps the existing CLI surface intact", async () => {
    assert.equal((await harnessCommand(["list"])).code, 0);
    assert.equal((await harnessCommand(["load"])).code, 2);
    assert.equal((await harnessCommand(["nope"])).code, 2);
  });
});
