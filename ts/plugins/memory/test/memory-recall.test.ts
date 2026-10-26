/** F09.02 — selective pre-turn recall: hits, caps, incremental refresh and the fallback contract. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createMemoryRecall, projectHash, RECALL_HEADER, relevanceScorer, renderRecall, tokenize, UNTRUSTED_PREAMBLE,
} from "../src/index.ts";
import type { IndexedMemoryEntry } from "../src/index.ts";

interface Store { base: string; memoryRoot: string; workspace: string }

/** Small deterministic store: three tracks, one clearly relevant cluster each. */
function recallFixture(): Store {
  const base = mkdtempSync(join(tmpdir(), "xueness-recall-"));
  const memoryRoot = join(base, "memory");
  const workspace = join(base, "ws");
  mkdirSync(join(memoryRoot, "projects", projectHash(workspace)), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(memoryRoot, "MEMORY.md"), [
    "deploy runbook: docker compose up on the prod host",
    "favorite editor is helix, never vscode",
    "docker image pruning happens weekly",
  ].join("\n§\n"));
  writeFileSync(join(memoryRoot, "USER.md"), "prefers 中文 replies");
  writeFileSync(join(memoryRoot, "projects", projectHash(workspace), "KEY.md"), "project alpha uses postgres on port 5432");
  return { base, memoryRoot, workspace };
}

const entry = (body: string, track: "memory" | "user" | "key" = "memory", at = 0): IndexedMemoryEntry =>
  ({ id: `${track}:fixed-${at}`, track, body, chars: body.length, source: { file: `/m/${track}.md`, entry: at }, version: `v${at}` });

describe("F09.02 selective recall", () => {
  it("tokenizes Unicode-aware and lower-cased", () => {
    assert.deepEqual(tokenize("Docker, compose! ２０２６ 全角"), ["docker", "compose", "２０２６", "全角"]);
    assert.deepEqual(tokenize("   "), []);
  });

  it("scores distinct query-term coverage, so breadth beats repetition", () => {
    const score = relevanceScorer("docker deploy");
    assert.equal(score(entry("deploy runbook: docker compose up")), 2);
    assert.equal(score(entry("docker docker docker")), 1);
    assert.equal(score(entry("favorite editor is helix")), 0);
  });

  it("recalls only relevant entries with traceable provenance", () => {
    const store = recallFixture();
    try {
      const recall = createMemoryRecall(store.memoryRoot, store.workspace);
      const result = recall.recall("docker deploy");
      assert.equal(result.mode, "selective");
      assert.ok(result.text.startsWith(UNTRUSTED_PREAMBLE + "\n\n" + RECALL_HEADER), result.text.slice(0, 120));
      assert.ok(result.text.includes("deploy runbook: docker compose up"));
      assert.ok(result.text.includes("docker image pruning happens weekly"));
      assert.ok(!result.text.includes("helix"), "irrelevant memories stay out of the request");
      assert.ok(!result.text.includes("中文"), "other tracks' irrelevant entries stay out too");
      assert.ok(result.text.includes("[memory #0 @"), "each hit carries its track/entry/version tag");
      assert.ok(result.candidates[0]!.score >= result.candidates.at(-1)!.score, "ranked descending");
      assert.ok(result.candidates.every((one) => one.entry.track === "memory"), "only the matching track was selected");
      assert.equal(result.manifest.totalEntries, 5, "manifest still summarizes the whole store");
      assert.ok(JSON.stringify(result.manifest).includes("postgres") === false, "manifest carries no bodies");
      assert.equal(result.failure, null);
    } finally { rmSync(store.base, { recursive: true, force: true }); }
  });

  it("keeps unrelated memories non-resident when nothing matches", () => {
    const store = recallFixture();
    try {
      const result = createMemoryRecall(store.memoryRoot, store.workspace).recall("kubernetes helm chart");
      assert.equal(result.mode, "none");
      assert.equal(result.text, "");
      assert.deepEqual(result.candidates, []);
      assert.equal(result.failure, null);
    } finally { rmSync(store.base, { recursive: true, force: true }); }
  });

  it("honors selection caps and ranks deterministically", () => {
    const store = recallFixture();
    try {
      const one = createMemoryRecall(store.memoryRoot, store.workspace, { maxEntries: 1 });
      const first = one.recall("docker deploy");
      assert.equal(first.candidates.length, 1);
      assert.equal(first.candidates[0]!.entry.source.entry, 0, "the two-term entry outranks one-term hits");
      const tight = createMemoryRecall(store.memoryRoot, store.workspace, { maxChars: 30 });
      const bounded = tight.recall("docker deploy pruning weekly editor");
      assert.ok(bounded.candidates.every((one) => one.entry.chars <= 30 || bounded.candidates.indexOf(one) === 0));
      assert.ok(bounded.candidates.reduce((sum, one) => sum + one.entry.chars, 0) < 200, "total body stays a summary");
      const ids = (query: string) => createMemoryRecall(store.memoryRoot, store.workspace).recall(query).candidates.map((one) => one.entry.id);
      assert.deepEqual(ids("docker deploy pruning weekly"), ids("docker deploy pruning weekly"), "stable ordering");
    } finally { rmSync(store.base, { recursive: true, force: true }); }
  });

  it("refreshes incrementally: stale probe, rebuild on change, stable when quiet", () => {
    const store = recallFixture();
    try {
      const recall = createMemoryRecall(store.memoryRoot, store.workspace);
      assert.ok(recall.recall("postgres").text.includes("postgres"));
      assert.equal(recall.stale(), false, "fresh after the indexing recall");
      assert.equal(recall.recall("postgres").refreshed, false, "no rebuild when the fingerprint is unchanged");
      const track = join(store.memoryRoot, "projects", projectHash(store.workspace), "KEY.md");
      writeFileSync(track, "project alpha uses postgres on port 5432\n§\nkey rollout notes mention kubernetes");
      assert.equal(recall.stale(), true, "the stat probe sees the edit without reading bodies");
      const hit = recall.recall("kubernetes");
      assert.equal(hit.refreshed, true);
      assert.ok(hit.text.includes("key rollout notes"), "the new entry is recallable in the same session");
      assert.equal(recall.stale(), false, "and the rebuilt index is fresh again");
    } finally { rmSync(store.base, { recursive: true, force: true }); }
  });

  it("falls back explicitly and never throws when the index cannot exist", () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-recall-missing-"));
    try {
      const recall = createMemoryRecall(join(base, "no-such-root"), join(base, "ws"));
      const result = recall.recall("anything");
      assert.equal(result.mode, "none", "nothing loadable, so nothing resident");
      assert.ok(result.failure, "the index failure is reported, not swallowed");
      assert.equal(result.text, "");
      assert.deepEqual(result.candidates, []);
      assert.ok(result.manifest.ok === false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("degrades to the whole-track fallback when the root vanishes mid-session", () => {
    const store = recallFixture();
    try {
      const recall = createMemoryRecall(store.memoryRoot, store.workspace);
      assert.equal(recall.recall("docker").mode, "selective");
      rmSync(store.memoryRoot, { recursive: true, force: true });
      const result = recall.recall("docker");
      assert.equal(result.refreshed, true, "the stale probe forced a rebuild, which failed");
      assert.ok(result.failure, "explicit failure reason");
      assert.deepEqual(result.candidates, []);
      assert.equal(result.mode, "none", "no text survives a vanished root; still no throw");
    } finally { rmSync(store.base, { recursive: true, force: true }); }
  });

  it("renders an empty recall as empty string, else header plus tagged bullets", () => {
    const store = recallFixture();
    try {
      assert.equal(renderRecall([], createMemoryRecall(store.memoryRoot, store.workspace).recall("docker").manifest), "");
      const recall = createMemoryRecall(store.memoryRoot, store.workspace).recall("docker deploy");
      const body = renderRecall(recall.candidates, recall.manifest);
      assert.ok(body.startsWith(RECALL_HEADER));
      assert.ok(body.includes("2 of 5 indexed entries"), body.split("\n")[1]!);
      assert.ok(body.includes("[memory #0 @"));
    } finally { rmSync(store.base, { recursive: true, force: true }); }
  });
});
