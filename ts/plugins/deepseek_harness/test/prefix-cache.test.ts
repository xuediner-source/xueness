/** H01.03: deterministic KV-cache prefix stabilization and reproducible hit-rate metrics. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalJson,
  commonPrefixLength,
  createPrefixCache,
  prefixHashOf,
  stablePrefix,
  type StableRequest,
} from "../src/prefix-cache.ts";

const turn = (role: string, content: string) => ({ role, content });

function history(messages: readonly { role: string; content: string }[]): StableRequest {
  return { system: "You are a harness.", messages };
}

describe("canonicalJson", () => {
  it("is invariant to object key order", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), canonicalJson({ a: [true, null, "x"], b: 1 }));
  });

  it("serializes scalars and edge numbers deterministically", () => {
    assert.equal(canonicalJson(-0), "0");
    assert.equal(canonicalJson(Number.NaN), "null");
    assert.equal(canonicalJson(undefined), "null");
    assert.equal(canonicalJson({ a: undefined }), "{}");
    assert.equal(canonicalJson("é\n"), JSON.stringify("é\n"));
  });

  it("keeps array order significant", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });
});

describe("stablePrefix", () => {
  it("is byte-identical for one session across turns that only append messages", () => {
    const first = stablePrefix(history([turn("user", "hello")]));
    const second = stablePrefix(history([turn("user", "hello"), turn("assistant", "hi")]));
    assert.ok(second.startsWith(first), "appending a turn must keep the earlier prefix bytes intact");
  });

  it("is invariant to tool declaration order and key order inside declarations", () => {
    const left = stablePrefix({
      system: "s",
      tools: [
        { name: "b", description: "second", parameters: { type: "object", properties: { x: { type: "string" } } } },
        { name: "a", parameters: { properties: { x: { type: "number" } }, type: "object" } },
      ],
      messages: [turn("user", "q")],
    });
    const right = stablePrefix({
      tools: [{ parameters: { type: "object", properties: { x: { type: "number" } } }, name: "a" }, { name: "b", parameters: { type: "object", properties: { x: { type: "string" } } }, description: "second" }],
      messages: [turn("user", "q")],
      system: "s",
    });
    assert.equal(left, right);
  });

  it("ignores volatile request fields by construction", () => {
    const base = stablePrefix({ system: "s", messages: [turn("user", "q")] });
    assert.equal(base, stablePrefix({ system: "s", messages: [turn("user", "q")], temperature: 0.7 } as StableRequest));
  });

  it("hashes the same prefix to the same digest", () => {
    const request = history([turn("user", "hello"), turn("assistant", "hi")]);
    assert.equal(prefixHashOf(request), prefixHashOf({ system: request.system, messages: [...request.messages] }));
    assert.match(prefixHashOf(request), /^[0-9a-f]{64}$/);
  });
});

describe("commonPrefixLength", () => {
  it("measures the shared boundary exactly", () => {
    assert.equal(commonPrefixLength("abcdef", "abcXYZ"), 3);
    assert.equal(commonPrefixLength("", "abc"), 0);
    assert.equal(commonPrefixLength("abc", "abc"), 3);
  });
});

describe("createPrefixCache", () => {
  it("keeps one session's prefix stable and reports full hits for pure appends", () => {
    const cache = createPrefixCache();
    const first = cache.record("sess-1", "deepseek-v4.1", history([turn("user", "hello")]));
    assert.equal(first.sequence, 1);
    assert.equal(first.hitChars, 0);
    assert.equal(first.hitRate, 0);
    assert.equal(first.stable, true);

    const second = cache.record("sess-1", "deepseek-v4.1", history([turn("user", "hello"), turn("assistant", "hi"), turn("user", "again")]));
    assert.ok(second.hitChars > 0);
    assert.equal(second.hitChars, first.totalChars, "an appended turn reuses the whole previous prefix");
    assert.equal(second.stable, true);
    assert.ok(second.hitRate > 0 && second.hitRate < 1);
    assert.equal(second.prefixHash, prefixHashOf(history([turn("user", "hello"), turn("assistant", "hi"), turn("user", "again")])));
  });

  it("detects a rewritten history as an unstable prefix with a partial hit", () => {
    const cache = createPrefixCache();
    cache.record("s", "deepseek-reasoner", history([turn("user", "one"), turn("assistant", "a1")]));
    const rewritten = cache.record("s", "deepseek-reasoner", history([turn("user", "one"), turn("assistant", "a2")]));
    assert.equal(rewritten.stable, false);
    assert.ok(rewritten.hitChars > 0, "the shared leading bytes still hit");
    assert.ok(rewritten.hitChars < rewritten.totalChars);
  });

  it("measures sessions independently", () => {
    const cache = createPrefixCache();
    cache.record("a", "deepseek-v4.1", history([turn("user", "hello")]));
    const other = cache.record("b", "deepseek-v4.1", history([turn("user", "hello")]));
    assert.equal(other.hitChars, 0);
    assert.equal(other.sequence, 1);
    const again = cache.record("a", "deepseek-v4.1", history([turn("user", "hello"), turn("user", "more")]));
    assert.ok(again.hitChars > 0);
    assert.equal(cache.last("a")?.sequence, 2);
    assert.equal(cache.last("missing"), null);
  });

  it("produces reproducible, model-keyed metrics for DeepSeek V4.1 and R1", () => {
    const script = (cache: ReturnType<typeof createPrefixCache>) => {
      cache.record("s1", "deepseek-v4.1", history([turn("user", "u1")]));
      cache.record("s1", "deepseek-v4.1", history([turn("user", "u1"), turn("assistant", "a1")]));
      cache.record("s2", "deepseek-reasoner", history([turn("user", "u1")]));
      cache.record("s2", "deepseek-reasoner", history([turn("user", "u1"), turn("assistant", "a1")]));
      return cache.metrics();
    };
    assert.deepEqual(script(createPrefixCache()), script(createPrefixCache()), "replaying the same sequence yields identical metrics");

    const metrics = script(createPrefixCache());
    assert.equal(metrics.sessions, 2);
    const v41 = metrics.models.find((entry) => entry.model === "deepseek-v4.1");
    const r1 = metrics.models.find((entry) => entry.model === "deepseek-reasoner");
    assert.ok(v41 && r1);
    assert.equal(v41.requests, 2);
    assert.equal(v41.stableRequests, 2);
    assert.deepEqual(v41.hitRate, r1.hitRate, "identical request scripts hit identically on both models");
    assert.ok(v41.hitRate > 0 && v41.hitRate < 1);
    assert.deepEqual(
      metrics.models.map((entry) => entry.model),
      ["deepseek-reasoner", "deepseek-v4.1"],
      "models are reported in sorted order",
    );
  });

  it("evicts the oldest session beyond capacity and resets cleanly", () => {
    const cache = createPrefixCache({ capacity: 2 });
    cache.record("s1", "m", history([turn("user", "1")]));
    cache.record("s2", "m", history([turn("user", "2")]));
    cache.record("s3", "m", history([turn("user", "3")]));
    assert.equal(cache.last("s1"), null);
    assert.notEqual(cache.last("s2"), null);
    const resumed = cache.record("s2", "m", history([turn("user", "2"), turn("user", "next")]));
    assert.ok(resumed.hitChars > 0, "a surviving session keeps its hit context");

    cache.reset();
    assert.deepEqual(cache.metrics(), { sessions: 0, models: [] });
    assert.equal(cache.last("s2"), null);
  });
});
