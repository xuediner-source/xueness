import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHAOS_FAULT_KINDS,
  CHAOS_SCENARIOS,
  ChaosError,
  chaosCatalogCovered,
  chaosScenarioById,
  healthyModel,
  isChaosError,
  truncateJsonPrefix,
  type ChaosScenario,
} from "../src/chaos/scenarios.ts";

const request = { role: "solver", prompt: "do work", callIndex: 1 };

const complete = async (scenario: ChaosScenario, options = {}) =>
  scenario.inject(healthyModel(), options).complete(request);

describe("H11.01 chaos catalog", () => {
  it("exposes at least 6 scenarios with unique ids covering every fault family", () => {
    assert.ok(CHAOS_SCENARIOS.length >= 6, `expected >= 6 scenarios, got ${CHAOS_SCENARIOS.length}`);
    const ids = new Set(CHAOS_SCENARIOS.map((scenario) => scenario.id));
    assert.equal(ids.size, CHAOS_SCENARIOS.length, "scenario ids must be unique");
    assert.ok(chaosCatalogCovered(), "every CHAOS_FAULT_KINDS family must have a scenario");
    for (const kind of CHAOS_FAULT_KINDS) {
      assert.ok(CHAOS_SCENARIOS.some((scenario) => scenario.kind === kind), `missing kind ${kind}`);
    }
    for (const scenario of CHAOS_SCENARIOS) {
      assert.ok(scenario.description.length > 10, `${scenario.id} needs a description`);
    }
  });

  it("looks scenarios up by id and reports unknown ids as undefined", () => {
    assert.equal(chaosScenarioById("net_timeout")?.kind, "timeout");
    assert.equal(chaosScenarioById("nope"), undefined);
  });

  it("net_timeout rejects with a timeout ChaosError before the hang clears", async () => {
    const scenario = chaosScenarioById("net_timeout");
    assert.ok(scenario);
    await assert.rejects(
      complete(scenario, { hangMs: 80, timeoutMs: 5 }),
      (error: unknown) => isChaosError(error) && error.kind === "timeout",
    );
  });

  it("rate_limit_429 rejects with status 429 and retryAfterMs", async () => {
    const scenario = chaosScenarioById("rate_limit_429");
    assert.ok(scenario);
    await assert.rejects(
      complete(scenario, { retryAfterMs: 7 }),
      (error: unknown) =>
        isChaosError(error) && error.kind === "rate_limit" && error.status === 429 && error.retryAfterMs === 7,
    );
  });

  it("partial_json resolves with truncated, unparseable JSON", async () => {
    const scenario = chaosScenarioById("partial_json");
    assert.ok(scenario);
    const response = await complete(scenario);
    assert.ok(response.text.length > 0);
    assert.ok(!response.text.endsWith("}"), "truncated body must not close the JSON object");
    assert.throws(() => JSON.parse(response.text));
  });

  it("malformed_json resolves with non-JSON text; empty_body resolves blank", async () => {
    const malformedScenario = chaosScenarioById("malformed_json");
    assert.ok(malformedScenario);
    const malformed = await complete(malformedScenario);
    assert.throws(() => JSON.parse(malformed.text));
    const emptyScenario = chaosScenarioById("empty_body");
    assert.ok(emptyScenario);
    const empty = await complete(emptyScenario);
    assert.equal(empty.text.trim(), "");
  });

  it("flaky_intermittent throttles only every 3rd call and passes through otherwise", async () => {
    const model = chaosScenarioById("flaky_intermittent")?.inject(healthyModel());
    assert.ok(model);
    const outcomes: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      try {
        await model.complete({ ...request, callIndex: n });
        outcomes.push("ok");
      } catch (error) {
        outcomes.push(isChaosError(error) ? error.kind : "other");
      }
    }
    assert.deepEqual(outcomes, ["ok", "ok", "rate_limit", "ok", "ok", "rate_limit"]);
  });

  it("everyN=2 faults only even calls; everyN < 1 is rejected", async () => {
    const model = chaosScenarioById("rate_limit_429")?.inject(healthyModel(), { everyN: 2 });
    assert.ok(model);
    await model.complete(request);
    await assert.rejects(model.complete(request), isChaosError);
    const bad = chaosScenarioById("rate_limit_429")?.inject(healthyModel(), { everyN: 0 });
    assert.ok(bad);
    await assert.rejects(bad.complete(request), /everyN must be >= 1/);
  });

  it("isChaosError distinguishes ChaosError from ordinary errors", () => {
    assert.ok(isChaosError(new ChaosError("timeout", "boom")));
    assert.ok(!isChaosError(new Error("plain")));
    assert.ok(!isChaosError("string"));
  });

  it("truncateJsonPrefix cuts mid-document and never returns the full JSON", () => {
    const json = '{"verdict": "accept", "score": 0.9}';
    const cut = truncateJsonPrefix(json);
    assert.ok(cut.length > 0 && cut.length < json.length);
    assert.throws(() => JSON.parse(cut));
  });
});
