/** H09.05-06 live adapter + tournament report. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiveAdapter } from "../src/tournament/live-adapter.ts";
import { buildTournamentReport, parseTournamentReport, renderTournamentMarkdown, serializeTournamentReport } from "../src/tournament/report.ts";
import { buildBracket } from "../src/tournament/bracket.ts";
import { scoreTournament } from "../src/tournament/scoring.ts";

describe("live adapter (H09.05)", () => {
  it("dry-run fallback resolves echo models", async () => {
    const adapter = createLiveAdapter();
    assert.equal(adapter.mode, "dry-run");
    const model = await adapter.resolve("alpha");
    const reply = await model.complete({ role: "solver", prompt: "ping", callIndex: 1 });
    assert.match(reply.text, /^dry-run:alpha:/);
  });

  it("uses a live factory when provided", async () => {
    const adapter = createLiveAdapter({
      factory: async (id) => ({ id, async complete() { return { text: `live:${id}` }; } }),
    });
    assert.equal(adapter.mode, "live");
    const model = await adapter.resolve("beta");
    assert.equal((await model.complete({ role: "solver", prompt: "x", callIndex: 1 })).text, "live:beta");
  });
});

describe("tournament report (H09.06)", () => {
  it("round-trips JSON and renders markdown", () => {
    const models = ["a", "b"];
    const bracket = buildBracket(models);
    const scoreboard = scoreTournament(models, []);
    const report = buildTournamentReport({
      label: "demo",
      createdAt: "2026-10-26T00:00:00.000Z",
      scoreboard,
      bracket,
      champion: null,
    });
    const json = serializeTournamentReport(report);
    assert.deepEqual(parseTournamentReport(json), JSON.parse(json));
    const md = renderTournamentMarkdown(report);
    assert.match(md, /# Tournament: demo/);
    assert.match(md, /\| Rank \|/);
  });
});
