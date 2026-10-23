/** Usage window and the single GET route. POST stays unowned. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUsage, createUsageHttp, normalizeRange, type UsageStore } from "../src/index.ts";

const NOW = 1_700_000_000;

function store(rows: Record<string, Record<string, unknown>>): UsageStore {
  return {
    async list() { return Object.keys(rows).map((id) => ({ id })); },
    async load(id: string) { return rows[id]; },
  };
}

describe("usage", () => {
  it("falls unknown ranges back to 7d", () => {
    assert.equal(normalizeRange("nope"), "7d");
    assert.equal(normalizeRange(" 30D "), "30d");
    assert.equal(normalizeRange("all"), "all");
  });

  it("keeps an old session out of totals while a dict record still publishes token keys", async () => {
    const old = NOW - 40 * 86400;
    const recent = NOW - 86400;
    const body = await buildUsage({ store: store({
      old: { id: "old", status: "completed", steps: 4, mtime: old, provider_usage: [{ at: old, usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }, model: "m", protocol: "openai" }] },
      recent: { id: "recent", status: "completed", steps: true, mtime: recent, provider_usage: [] },
    }) }, "7d", NOW);
    assert.equal(body.range, "7d");
    assert.deepEqual(body.totals, { sessions: 1, steps: 0, completed: 1 });
    assert.deepEqual(body.tokens, { input: 0, output: 0, total: 0, reportedRequests: 0, unknownRequests: 0 });
  });

  it("counts an in-window report and rejects a bool token", async () => {
    const recent = NOW - 3600;
    const body = await buildUsage({ store: store({
      a: { id: "a", status: "completed", steps: 2, mtime: recent, provider_usage: [
        { at: recent, usage: { prompt_tokens: true, completion_tokens: 4, total_tokens: 4 }, model: "m", protocol: "openai", cost: { currency: "USD", amount: 1.5 } },
      ] },
    }) }, "nope", NOW);
    const tokens = body.tokens as { input: number; output: number; total: number };
    assert.equal(tokens.input, 0);
    assert.equal(tokens.output, 4);
    assert.equal(tokens.total, 4);
    assert.equal(body.updatedAt, new Date(NOW * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  });

  it("owns only GET /api/usage", async () => {
    const http = createUsageHttp({ enabled: true, store: store({}), now: () => NOW });
    assert.equal(http.owns("GET", ["api", "usage"]), true);
    assert.equal(http.owns("POST", ["api", "usage"]), false);
    assert.equal(http.owns("GET", ["api", "usage", "extra"]), false);
    assert.equal(await http.dispatch("POST", ["api", "usage"], {}), null);
    const denied = await createUsageHttp({ enabled: false, store: store({}) }).dispatch("GET", ["api", "usage"], {});
    assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: usage", plugin: "usage" }]);
    assert.equal(Object.hasOwn(denied?.[1] as object, "code"), false);
    const ok = await http.dispatch("GET", ["api", "usage"], { range: ["all"] });
    assert.equal(ok?.[0], 200);
    assert.equal((ok?.[1] as { range: string }).range, "all");
  });
});
