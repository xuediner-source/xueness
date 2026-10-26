import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseHarnessTelemetryLine,
  REDACTED,
  redactHarnessTelemetryEvent,
  redactText,
  validateHarnessTelemetryEvent,
  type HarnessTelemetryEvent,
} from "../src/harness-telemetry.ts";

const sessionEvent: HarnessTelemetryEvent = {
  type: "session",
  at: "2026-10-26T10:00:00.000Z",
  session: "sess-1",
  task: "fix the login bug",
  solverModel: "deepseek-solver",
  criticModel: "deepseek-critic",
};

const exchangeEvent: HarnessTelemetryEvent = {
  type: "exchange",
  at: "2026-10-26T10:00:01.000Z",
  session: "sess-1",
  round: 1,
  role: "solver",
  modelId: "deepseek-solver",
  callIndex: 0,
  durationMs: 1200,
  usage: { promptTokens: 1000, completionTokens: 40, cachedTokens: 0 },
};

describe("H12.01 schema validation", () => {
  it("accepts a well-formed event of every kind", () => {
    const events: HarnessTelemetryEvent[] = [
      sessionEvent,
      exchangeEvent,
      { type: "verdict", at: "2026-10-26T10:00:02Z", session: "sess-1", round: 1, verdict: "accept", path: "src/app.ts" },
      { type: "verdict", at: "2026-10-26T10:00:03Z", session: "sess-1", round: 2, verdict: "reject", path: null },
      { type: "error", at: "2026-10-26T10:00:04Z", session: "sess-1", stage: "solver", message: "model reply malformed" },
      { type: "metric", at: "2026-10-26T10:00:05Z", session: "sess-1", name: "kv_hit_rate", value: 0.75 },
    ];
    for (const event of events) {
      const result = validateHarnessTelemetryEvent(event);
      assert.equal(result.valid, true, JSON.stringify(event));
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.event, event);
    }
  });

  it("rejects non-objects and unknown event kinds", () => {
    for (const raw of [null, 42, "exchange", [], true]) {
      const result = validateHarnessTelemetryEvent(raw);
      assert.equal(result.valid, false);
      assert.equal(result.event, null);
      assert.ok(result.errors.length > 0);
    }
    assert.equal(validateHarnessTelemetryEvent({ ...exchangeEvent, type: "unknown" }).errors[0], "type must be one of session|exchange|verdict|error|metric");
  });

  it("rejects bad timestamps, sessions and per-kind fields", () => {
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, at: "yesterday" }).errors.some((e) => e.startsWith("at must be")));
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, at: "2026-13-40T10:00:00Z" }).errors.some((e) => e.startsWith("at must be")));
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, session: "  " }).errors.some((e) => e.includes("session")));
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, task: "" }).errors.some((e) => e.includes("task")));
    assert.ok(validateHarnessTelemetryEvent({ ...exchangeEvent, round: 0 }).errors.some((e) => e.includes("round")));
    assert.ok(validateHarnessTelemetryEvent({ ...exchangeEvent, callIndex: -1 }).errors.some((e) => e.includes("callIndex")));
    assert.ok(validateHarnessTelemetryEvent({ ...exchangeEvent, durationMs: -5 }).errors.some((e) => e.includes("durationMs")));
    assert.ok(validateHarnessTelemetryEvent({ ...exchangeEvent, usage: null }).errors.some((e) => e.includes("usage")));
    assert.ok(
      validateHarnessTelemetryEvent({ ...exchangeEvent, usage: { promptTokens: -1, completionTokens: 0, cachedTokens: 0 } }).errors.some((e) =>
        e.includes("usage.promptTokens"),
      ),
    );
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, type: "verdict", round: 1, verdict: "maybe", path: null }).errors.some((e) => e.includes("verdict")));
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, type: "error", stage: " ", message: "boom" }).errors.some((e) => e.includes("stage")));
    assert.ok(validateHarnessTelemetryEvent({ ...sessionEvent, type: "metric", name: "x", value: Number.NaN }).errors.some((e) => e.includes("value")));
  });

  it("collects every violation at once instead of throwing", () => {
    const result = validateHarnessTelemetryEvent({ type: "session" });
    assert.equal(result.valid, false);
    assert.equal(result.event, null);
    assert.equal(result.errors.length, 5);
  });

  it("preserves unknown extra fields for forward compatibility", () => {
    const result = validateHarnessTelemetryEvent({ ...sessionEvent, futureField: { nested: true } });
    assert.equal(result.valid, true);
    assert.deepEqual((result.event as unknown as Record<string, unknown>).futureField, { nested: true });
  });
});

describe("H12.01 JSONL line parsing", () => {
  it("parses a valid line and reports invalid JSON or schema errors", () => {
    const parsed = parseHarnessTelemetryLine(JSON.stringify(exchangeEvent));
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.event, exchangeEvent);
    assert.equal(parseHarnessTelemetryLine("{not json").errors[0], "line is not valid JSON");
    const bad = parseHarnessTelemetryLine(JSON.stringify({ type: "metric", at: "nope", session: "", name: "", value: "x" }));
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.length >= 4);
  });

  it("treats blank lines as skipped, not failures", () => {
    for (const line of ["", "   ", "\t"]) {
      const result = parseHarnessTelemetryLine(line);
      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, []);
      assert.equal(result.event, null);
    }
  });
});

describe("H12.01 secret redaction", () => {
  it("redacts values under secret-sounding keys at any depth", () => {
    const event = {
      ...sessionEvent,
      headers: { Authorization: "Bearer abc123def456", "X-API-Key": "k-123", contentType: "application/json" },
      nested: { deep: [{ session_token: 12345, note: "harmless" }] },
    } as unknown as HarnessTelemetryEvent;
    const redacted = redactHarnessTelemetryEvent(event) as unknown as Record<string, any>;
    assert.equal(redacted.headers.Authorization, REDACTED);
    assert.equal(redacted.headers["X-API-Key"], REDACTED);
    assert.equal(redacted.headers.contentType, "application/json");
    assert.equal(redacted.nested.deep[0].session_token, REDACTED);
    assert.equal(redacted.nested.deep[0].note, "harmless");
    assert.equal(redacted.task, sessionEvent.task);
  });

  it("masks secret-shaped substrings inside free text", () => {
    assert.equal(redactText("Authorization: Bearer abc123def456ghi"), `Authorization: Bearer ${REDACTED}`);
    assert.equal(redactText("key sk-abc123def456ghi789 passed"), `key ${REDACTED} passed`);
    assert.equal(redactText("api_key=supersecret123"), `api_key=${REDACTED}`);
    assert.equal(redactText("token: hunter2value"), `token: ${REDACTED}`);
    assert.equal(redactText("github_pat_ABCDEFGHIJKLMNOPQRST and xoxb-1234567890abcdef"), `${REDACTED} and ${REDACTED}`);
    assert.equal(redactText("no secrets here, round 3 accepted"), "no secrets here, round 3 accepted");
  });

  it("redacts inside event message fields and never mutates the input", () => {
    const event: HarnessTelemetryEvent = {
      type: "error",
      at: "2026-10-26T10:00:00Z",
      session: "sess-1",
      stage: "transport",
      message: "request failed with api_key=topsecretvalue after retry",
    };
    const snapshot = JSON.stringify(event);
    const redacted = redactHarnessTelemetryEvent(event) as unknown as unknown as Record<string, unknown>;
    assert.equal(redacted.message, `request failed with api_key=${REDACTED} after retry`);
    assert.equal(JSON.stringify(event), snapshot);
  });

  it("redaction keeps schema-valid events valid", () => {
    const result = validateHarnessTelemetryEvent(redactHarnessTelemetryEvent(exchangeEvent));
    assert.equal(result.valid, true);
  });
});
