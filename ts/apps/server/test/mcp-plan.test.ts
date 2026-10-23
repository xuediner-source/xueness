/** `planPlugins` against Python `plugin_sdk.plan`. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { planPlugins } from "../src/mcp-plan.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
const valid = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  id: "mcp-ops", version: "1.0.0", apiVersion: 1, enabled: true, builtin: "mcp", capabilities: [], ...extra,
});

function writeState(files: Record<string, string>): string {
  const state = mkdtempSync(join(tmpdir(), "xueness-plan-"));
  const dir = join(state, "resources", "plugins");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return state;
}

const PY = `
import json, sys
from xueness import plugin_sdk
spec = json.loads(sys.stdin.read())
out = []
for case in spec:
    plan = plugin_sdk.plan(case["state"], case["requested"], grants=case.get("grants") or ())
    out.append({"load": plan.load, "refused": plan.refused, "manifests": plan.manifests})
print(json.dumps(out, ensure_ascii=False))
`;

describe("plugin plan matches Python", { skip }, () => {
  const cases: { files: Record<string, string>; requested: unknown[]; grants?: unknown[] }[] = [
    { files: {}, requested: ["mcp"] },
    { files: { "a.json": valid() }, requested: ["mcp"] },
    { files: { "a.json": valid({ enabled: false }) }, requested: ["mcp"] },
    { files: { "a.json": valid({ apiVersion: 2 }) }, requested: ["mcp"] },
    { files: { "a.json": valid({ entrypoint: "evil.py" }) }, requested: ["mcp"] },
    { files: { "a.json": valid({ capabilities: ["network", "command"] }) }, requested: ["mcp"] },
    { files: { "a.json": valid({ capabilities: ["network"] }) }, requested: ["mcp"], grants: ["network"] },
    { files: { "b.json": valid({ id: "b" }), "a.json": valid({ id: "a" }) }, requested: ["mcp"] },
    { files: { "a.json": valid() }, requested: ["mcp", "mcp", "", "nope", 1] },
    { files: { "a.json": valid({ builtin: "not-a-plugin" }) }, requested: ["mcp"] },
    { files: { "a.json": "{\"id\":\"mcp-ops\",\"builtin\":\"mcp\"}" }, requested: ["mcp"] },
    { files: { "a.json": valid({ capabilities: ["nope"] }) }, requested: ["mcp"] },
    { files: { "notes.txt": valid(), "a.json": "[1]" }, requested: ["skills", "hooks"] },
  ];

  it("agrees on load, refused, and manifests", () => {
    const states: string[] = [];
    try {
      const payload = cases.map((item) => {
        const state = writeState(item.files);
        states.push(state);
        return { state, requested: item.requested, grants: item.grants ?? [] };
      });
      const python = runPython(PY, JSON.stringify(payload)).trim();
      const ours = payload.map((item, index) => planPlugins(item.state, cases[index]!.requested, cases[index]!.grants ?? []));
      assert.equal(pyJsonDumps(ours), python);
    } finally {
      for (const state of states) rmSync(state, { recursive: true, force: true });
    }
  });
});
