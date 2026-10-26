import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import {
  ARTIFACT_INLINE_MAX_CHARS, ARTIFACT_MAX_CHARS, DynamicArtifactStore, isArtifactRef,
} from "../src/dynamic-artifacts.ts";

const RUN = "c".repeat(32);

function store(): { artifacts: DynamicArtifactStore; state: string; cleanup(): void } {
  const state = mkdtempSync(join(tmpdir(), "xue-dynamic-artifacts-"));
  return { artifacts: new DynamicArtifactStore(state), state, cleanup: () => rmSync(state, { recursive: true, force: true }) };
}

describe("dynamic artifact store", () => {
  it("keeps small values inline and saves large bodies by content-addressed reference", () => {
    const f = store();
    try {
      const small = f.artifacts.save(RUN, "node@1", { text: "tiny" });
      assert.deepEqual(small, { stored: false, value: { text: "tiny" } });

      const body = "x".repeat(ARTIFACT_INLINE_MAX_CHARS + 1);
      const large = f.artifacts.save(RUN, "node@2", { body });
      assert.equal(large.stored, true);
      if (!large.stored) throw new Error("unreachable");
      assert.match(large.ref.$artifact, /^[a-f0-9]{64}$/);
      assert.equal(large.ref.runId, RUN);
      assert.equal(large.ref.nodeId, "node@2");
      assert.equal(large.ref.chars, JSON.stringify({ body }).length);
      assert.ok(isArtifactRef(large.ref));
      assert.equal(isArtifactRef({ body }), false);
      assert.equal(isArtifactRef(null), false);

      const resolved = f.artifacts.resolve(RUN, large.ref);
      assert.deepEqual(resolved, { body });
    } finally { f.cleanup(); }
  });

  it("is idempotent for one value: the second save reuses the identical file", () => {
    const f = store();
    try {
      const value = { rows: Array.from({ length: 900 }, (_, index) => index) };
      const first = f.artifacts.save(RUN, "node@1", value);
      const second = f.artifacts.save(RUN, "node@1", value);
      assert.equal(first.stored, true);
      assert.equal(second.stored, true);
      if (!first.stored || !second.stored) throw new Error("unreachable");
      assert.equal(first.write, "created");
      assert.equal(second.write, "already-present");
      assert.equal(first.ref.$artifact, second.ref.$artifact);
      const files = readdirSync(join(f.state, "dynamic-workflows", "artifacts", RUN));
      assert.deepEqual(files, [`${first.ref.$artifact}.json`]);
    } finally { f.cleanup(); }
  });

  it("exposes a provenance-only manifest without artifact bodies", () => {
    const f = store();
    try {
      const secret = "s".repeat(5000);
      const saved = f.artifacts.save(RUN, "node@7", { secret });
      assert.equal(saved.stored, true);
      const manifest = f.artifacts.manifest(RUN);
      assert.equal(manifest.length, 1);
      assert.equal(manifest[0]!.nodeId, "node@7");
      assert.equal(manifest[0]!.chars, JSON.stringify({ secret }).length);
      assert.equal(JSON.stringify(manifest).includes(secret), false);
      assert.deepEqual(f.artifacts.manifest("d".repeat(32)), []);
    } finally { f.cleanup(); }
  });

  it("refuses tampered bodies, foreign runs, and non-references at resolve time", () => {
    const f = store();
    try {
      const saved = f.artifacts.save(RUN, "node@1", { body: "y".repeat(3000) });
      if (!saved.stored) throw new Error("unreachable");
      const path = join(f.state, "dynamic-workflows", "artifacts", RUN, `${saved.ref.$artifact}.json`);
      const record = JSON.parse(readFileSync(path, "utf8")) as { value: { body: string } };
      record.value.body = "tampered".repeat(500);
      writeFileSync(path, JSON.stringify(record), "utf8");
      assert.throws(() => f.artifacts.resolve(RUN, saved.ref), PyValueError);

      assert.throws(() => f.artifacts.resolve("d".repeat(32), { ...saved.ref, runId: RUN }), PyValueError);
      assert.throws(() => f.artifacts.resolve(RUN, { no: "ref" }), PyValueError);
      assert.throws(() => f.artifacts.save(RUN, "n@1", "z".repeat(ARTIFACT_MAX_CHARS + 1)), PyValueError);
      assert.throws(() => f.artifacts.save(RUN, " ", "x"), PyValueError);
      assert.throws(() => f.artifacts.save("short", "n@1", "w".repeat(ARTIFACT_INLINE_MAX_CHARS + 1)), PyValueError);
    } finally { f.cleanup(); }
  });

  it("supports a zero threshold so callers can force by-reference storage", () => {
    const f = store();
    try {
      const forced = f.artifacts.save(RUN, "node@1", { force: true }, { inlineMaxChars: 0 });
      assert.equal(forced.stored, true);
      assert.throws(() => f.artifacts.save(RUN, "node@1", "x", { inlineMaxChars: -1 }), PyValueError);
    } finally { f.cleanup(); }
  });
});
