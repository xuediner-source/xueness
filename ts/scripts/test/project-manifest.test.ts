/** Round 11: the Node project-manifest generator. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compare, excluded, scan } from "../project-manifest.ts";

const EXCLUSIONS = ["*.pyc", "node_modules", "ts/dist", "complete-project-manifest.json"];
describe("project manifest", () => {
  it("excludes bare names on any segment, paths by prefix, and itself only at the root", () => {
    assert.equal(excluded("a/node_modules/x.js", EXCLUSIONS), true);
    assert.equal(excluded("x/y.pyc", EXCLUSIONS), true);
    assert.equal(excluded("ts/dist/main.js", EXCLUSIONS), true);
    assert.equal(excluded("ts/distro.ts", EXCLUSIONS), false);
    assert.equal(excluded("complete-project-manifest.json", EXCLUSIONS), true);
    assert.equal(excluded("docs/complete-project-manifest.json", EXCLUSIONS), false);
  });
  it("hashes files, keeps the previous order and reports changes", () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-manifest-"));
    try {
      mkdirSync(join(root, "b")); mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "b", "z.txt"), "z"); writeFileSync(join(root, "a.txt"), "a"); writeFileSync(join(root, "node_modules", "n.js"), "n");
      const files = scan(root, EXCLUSIONS);
      assert.deepEqual(files.map((file) => file.path), ["a.txt", "b/z.txt"]);
      assert.equal(files[0]!.sha256, "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
      const result = compare([{ path: "b/z.txt", sizeBytes: 1, sha256: "0" }, { path: "gone.txt", sizeBytes: 1, sha256: "0" }], files);
      assert.deepEqual([result.changed, result.added, result.removed], [["b/z.txt"], ["a.txt"], ["gone.txt"]]);
      assert.deepEqual(result.files.map((file) => file.path), ["b/z.txt", "a.txt"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
