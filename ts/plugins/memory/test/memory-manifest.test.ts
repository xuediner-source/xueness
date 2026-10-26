import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/** F09.01 — the memory manifest/index: traceable entries, caps, provenance-only manifest, staleness. */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildMemoryIndex, entryBodies, fileVersion, INDEX_ENTRY_MAX_CHARS, INDEX_TRACK_MAX_ENTRIES, indexStale, indexVersion,
  manifestOf, projectHash, safeRead, selectCandidates, SELECT_MAX_CHARS, SELECT_MAX_ENTRIES, TRACK_NAMES,
} from "../src/index.ts";
import type { IndexedMemoryEntry } from "../src/index.ts";
import { ENTRIES, memoryFixture } from "./fixture.ts";

/** A root whose KEY track exceeds the per-track entry cap. */
function bigFixture(entryCount: number): { base: string; memoryRoot: string; workspace: string } {
  const base = mkdtempSync(join(tmpdir(), "xueness-manifest-"));
  const memoryRoot = join(base, "memory");
  const workspace = join(base, "ws");
  mkdirSync(join(memoryRoot, "projects", projectHash(workspace)), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(memoryRoot, "MEMORY.md"), "global fact");
  writeFileSync(join(memoryRoot, "projects", projectHash(workspace), "KEY.md"),
    Array.from({ length: entryCount }, (_, i) => `key fact ${i}`).join("\n§\n"));
  return { base, memoryRoot, workspace };
}

const HEX16 = /^[0-9a-f]{16}$/u;

describe("F09.01 memory manifest/index", () => {
  it("indexes every track entry with a stable id, version and traceable source", () => {
    const fixture = memoryFixture();
    try {
      const index = buildMemoryIndex(fixture.memoryRoot, fixture.workspace);
      assert.equal(index.ok, true);
      assert.equal(index.failure, null);
      assert.deepEqual(Object.keys(index.tracks), TRACK_NAMES);
      const order = index.entries.map((one) => TRACK_NAMES.indexOf(one.track));
      assert.deepEqual([...order].sort((a, b) => a - b), order, "entries are grouped in track order");
      assert.equal(order[0], 0, "the memory track comes first");
      assert.ok(index.entries.length >= 8, "all fixture entries survive indexing");
      for (const one of index.entries) {
        assert.match(one.id, new RegExp(`^(${TRACK_NAMES.join("|")}):[0-9a-f]{16}$`, "u"));
        assert.match(one.version, HEX16);
        assert.equal(one.id, `${one.track}:${one.version}`);
        assert.ok(one.source.file.startsWith(fixture.memoryRoot), "source points under the memory root");
        assert.ok(Number.isInteger(one.source.entry) && one.source.entry >= 0);
        assert.ok(one.chars > 0);
      }
      const first = index.tracks.memory!.entries[0]!;
      assert.equal(first.source.entry, 0);
      assert.equal(first.body, entryBodies(safeRead(join(fixture.memoryRoot, "MEMORY.md"), fixture.memoryRoot))[0],
        "entry heads are stripped exactly as the loader strips them (Python parity: a leading BOM survives)");
      assert.deepEqual(index.tracks.memory!.entries.map((one) => one.source.entry),
        index.tracks.memory!.entries.map((_, position) => position), "positions are dense and 0-based");
    } finally { rmSync(fixture.base, { recursive: true, force: true }); }
  });

  it("keeps ids stable across rebuilds and moves them only when a body changes", () => {
    const fixture = memoryFixture();
    try {
      const before = buildMemoryIndex(fixture.memoryRoot, fixture.workspace);
      const rebuilt = buildMemoryIndex(fixture.memoryRoot, fixture.workspace);
      assert.deepEqual(rebuilt.entries.map((one) => one.id), before.entries.map((one) => one.id));
      assert.equal(indexStale(before, fixture.memoryRoot), false);
      assert.equal(rebuilt.version, before.version);
      const track = join(fixture.memoryRoot, "MEMORY.md");
      writeFileSync(track, "\ufeff" + ENTRIES[0] + "\r\n§\r\nbrand new fact");
      assert.equal(indexStale(before, fixture.memoryRoot), true, "the cheap stat probe sees the edit");
      const after = buildMemoryIndex(fixture.memoryRoot, fixture.workspace);
      assert.notEqual(after.version, before.version);
      assert.equal(after.tracks.memory!.entries[0]!.id, before.tracks.memory!.entries[0]!.id, "unchanged body keeps its id");
      assert.ok(after.entries.some((one) => one.body === "brand new fact"));
      assert.equal(indexStale(after, fixture.memoryRoot), false);
    } finally { rmSync(fixture.base, { recursive: true, force: true }); }
  });

  it("caps bodies per entry and entries per track", () => {
    const fixture = memoryFixture();
    const big = bigFixture(INDEX_TRACK_MAX_ENTRIES + 50);
    try {
      const index = buildMemoryIndex(fixture.memoryRoot, fixture.workspace);
      assert.ok(index.entries.every((one) => one.chars <= INDEX_ENTRY_MAX_CHARS), "per-entry body clip");
      assert.ok(index.entries.some((one) => one.body.includes("…(truncated)")), "long emoji entry is visibly clipped");
      const capped = buildMemoryIndex(big.memoryRoot, big.workspace);
      assert.equal(capped.tracks.key!.entries.length, INDEX_TRACK_MAX_ENTRIES, "the long tail is not indexed");
      assert.equal(capped.tracks.key!.entries[0]!.body, "key fact 0");
      assert.equal(capped.tracks.key!.entries.at(-1)!.body, `key fact ${INDEX_TRACK_MAX_ENTRIES - 1}`);
    } finally { rmSync(fixture.base, { recursive: true, force: true }); rmSync(big.base, { recursive: true, force: true }); }
  });

  it("selects a bounded, ranked candidate set that keeps source and version", () => {
    const big = bigFixture(20);
    try {
      const index = buildMemoryIndex(big.memoryRoot, big.workspace);
      const everything = selectCandidates(index, () => 1);
      assert.equal(everything.length, SELECT_MAX_ENTRIES, "default entry cap");
      const score = (one: IndexedMemoryEntry) => Number(/key fact 7$/.test(one.body)) * 2 + 1;
      const ranked = selectCandidates(index, score);
      assert.equal(ranked[0]!.entry.body, "key fact 7", "highest score first");
      assert.ok(ranked.every((one) => one.score > 0), "zero-score entries are irrelevant and dropped");
      assert.ok(selectCandidates(index, () => 0).length === 0, "an all-zero scorer selects nothing");
      const tiny = selectCandidates(index, () => 1, { maxEntries: 3, maxChars: 20 });
      assert.ok(tiny.length <= 3 && tiny.reduce((sum, one) => sum + one.entry.chars, 0) <= 20 + INDEX_ENTRY_MAX_CHARS,
        "explicit caps override the defaults");
      const deterministic = selectCandidates(index, () => 1, { maxEntries: 5 });
      assert.deepEqual(deterministic.map((one) => one.entry.id), selectCandidates(index, () => 1, { maxEntries: 5 }).map((one) => one.entry.id),
        "ties break by id, deterministically");
      assert.ok(ranked.every((one) => one.entry.source.file && HEX16.test(one.entry.version)), "candidates stay traceable");
    } finally { rmSync(big.base, { recursive: true, force: true }); }
  });

  it("projects a provenance-only manifest: sources, versions and sizes, never bodies", () => {
    const fixture = memoryFixture();
    try {
      const manifest = manifestOf(buildMemoryIndex(fixture.memoryRoot, fixture.workspace));
      assert.equal(manifest.ok, true);
      assert.equal(manifest.root, buildMemoryIndex(fixture.memoryRoot, fixture.workspace).root);
      assert.equal(manifest.cwd, fixture.workspace);
      assert.equal(manifest.totalEntries, buildMemoryIndex(fixture.memoryRoot, fixture.workspace).entries.length);
      assert.deepEqual(manifest.tracks.map((one) => one.track), [...TRACK_NAMES]);
      for (const track of manifest.tracks) {
        assert.ok(track.file.startsWith(fixture.memoryRoot));
        assert.ok(typeof track.entries === "number" && track.entries >= 0);
        assert.ok(track.chars >= 0);
      }
      assert.ok(manifest.tracks.some((one) => one.entries > 0), "fixture tracks are non-empty");
      const serialized = JSON.stringify(manifest);
      assert.ok(!serialized.includes("durable fact"), "no memory bodies in the manifest");
      assert.ok(!serialized.includes("prefers"), "no user-track bodies either");
    } finally { rmSync(fixture.base, { recursive: true, force: true }); }
  });

  it("reports an unresolvable root as an explicit failure, and a missing track as empty (not failed)", () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-manifest-missing-"));
    try {
      const failed = buildMemoryIndex(join(base, "gone"), join(base, "ws"));
      assert.equal(failed.ok, false);
      assert.ok(failed.failure!.includes("memory root is unavailable"), `index failure: ${failed.failure}`);
      assert.deepEqual(failed.entries, []);
      assert.equal(failed.tracks.memory!.entries.length, 0);
      assert.ok(["memory", "user", "key"].every((track) => typeof failed.tracks[track as "memory"]!.version === "string"));
      const empty = buildMemoryIndex(base, join(base, "ws"));
      assert.equal(empty.ok, true, "a valid root with no tracks is empty, not a failure");
      assert.equal(empty.failure, null);
      assert.deepEqual(empty.entries, []);
      assert.ok(manifestOf(empty).tracks.every((one) => one.entries === 0));
      assert.equal(fileVersion(join(base, "nope.md")), "missing");
      const version = indexVersion(base, join(base, "ws"));
      assert.match(version, /^memory=(missing|\d+:\d+:\d+)\|user=\1\|key=\1$/u);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
