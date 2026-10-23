import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUNDLED_PLUGIN_IDS, HttpFamilyIndex, pathParts, type HttpFamilyManifest } from "../src/index.ts";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

function bundledManifests(): HttpFamilyManifest[] {
  return BUNDLED_PLUGIN_IDS.map((id) =>
    JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "catalog", `${id}.json`), "utf8")));
}

const SAMPLE_PATHS = [
  "/", "/api", "/api/sessions", "/api/sessions/abc", "/api/sessions/abc/files", "/api/sessions/abc/file",
  "/api/sessions/abc/git", "/api/sessions/abc/git/diff", "/api/directory", "/api/directory/list", "/api/home",
  "/api/plugins", "/api/plugins/files", "/api/settings", "/api/providers/x", "/api/usage", "/api/memory/a/b",
  "/api/terminals", "/api/workflows/1", "/api/mcp/servers", "/api/csrf", "/api/health", "/api/unknown/thing",
  "/api//sessions//abc//files", "/assets/app.js", "/api/composer/prepare", "/api/resources/kind",
];

describe("route catalog", () => {
  it("indexes manifest families with longest-pattern-wins matching", () => {
    const index = new HttpFamilyIndex([
      { id: "sessions", httpFamilies: ["sessions"] },
      { id: "git", httpFamilies: ["sessions/*/git"] },
    ]);
    assert.equal(index.owner(pathParts("/api/sessions/1")), "sessions");
    assert.equal(index.owner(pathParts("/api/sessions/1/git/log")), "git");
    assert.equal(index.owner(pathParts("/api/other")), null);
    assert.equal(index.owner(pathParts("/sessions")), null);
  });

  it("refuses one family claimed by two plugins", () => {
    assert.throws(() => new HttpFamilyIndex([{ id: "a", httpFamilies: ["x"] }, { id: "b", httpFamilies: ["x"] }]), /owned by a and b/);
  });

  it("matches Python's route_owner on the real bundled manifests", { skip: pythonUnavailableReason() ?? false }, () => {
    const output = runPython(`
import json, sys
from xueness import plugin_runtime
paths = json.loads(sys.stdin.read())
print(json.dumps({"ids": list(plugin_runtime.PLUGIN_IDS),
  "owners": [plugin_runtime.route_owner([p for p in path.split("/") if p]) for path in paths]}))
`, JSON.stringify(SAMPLE_PATHS));
    const expected = JSON.parse(output);
    assert.deepEqual([...BUNDLED_PLUGIN_IDS], expected.ids);
    const index = new HttpFamilyIndex(bundledManifests());
    assert.deepEqual(SAMPLE_PATHS.map((path) => index.owner(pathParts(path))), expected.owners);
  });
});
