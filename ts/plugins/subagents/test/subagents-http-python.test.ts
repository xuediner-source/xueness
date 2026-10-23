/** Differential: subagent resource CRUD only. `/api/sessions/<id>/tasks` stays on Python. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createSubagentsResourcesHttp } from "../src/index.ts";

const skip = pythonUnavailableReason();
const timeless = (text: string): string => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00/g, "<time>");
const SID = "ab".repeat(16);
const CRUD: [string, string[], unknown][] = [
  ["GET", [], {}], ["POST", [], { id: "a", name: "review", createOnly: true, n: 1 }], ["POST", [], { id: "a", createOnly: true }], ["POST", [], { id: "a", name: "y", createdAt: "spoof" }],
  ["POST", [], { id: "bad/id" }], ["PATCH", ["a"], { name: "z", id: "a" }], ["PATCH", ["missing"], {}], ["PUT", [], { items: [{ id: "c", name: "c" }, { id: "a", name: "a2" }] }],
  ["PUT", [], { items: [{ id: "x" }, { id: "x" }] }], ["DELETE", ["c"], {}], ["DELETE", ["c"], {}], ["GET", [], {}],
];
const PY = `
import json, sys
from pathlib import Path
from xueness import plugin_runtime, resources
a = json.loads(sys.stdin.read())
plugin_runtime.set_enabled(Path(a["offState"]), "subagents", False)
out = []
for mode, method, parts, body in a["calls"]:
    if mode == "off":
        result = plugin_runtime.dispatch_http(method, parts, {}, None, {"state_dir": Path(a["offState"]), "web_runs": Path(a["offState"]), "project_dir": Path(a["offState"])})
    elif mode == "nostate":
        result = resources.dispatch(method, parts, {}, {}, {})
    else:
        result = resources.dispatch(method, ["api", "resources", "subagents", *parts], {}, json.loads(body), {"state_dir": Path(a["crudState"])})
    out.append(None if result is None else [result[0], result[1]])
print(json.dumps(out, ensure_ascii=False))
`;

describe("subagents resources http matches Python", { skip: skip ?? false }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-subagents-http-")));
  const offState = join(base, "off"), crudState = join(base, "py-crud"), tsCrud = join(base, "ts-crud");
  for (const dir of [offState, crudState, tsCrud]) mkdirSync(dir, { recursive: true });
  const api = createSubagentsResourcesHttp({ stateDir: tsCrud, enabled: () => true });
  const offApi = createSubagentsResourcesHttp({ stateDir: offState, enabled: () => false });
  const nullApi = createSubagentsResourcesHttp({ stateDir: null, enabled: () => true });
  after(() => rmSync(base, { recursive: true, force: true }));

  it("owns only /api/resources/subagents and matches Python CRUD", () => {
    assert.equal(api.owns("GET", ["api", "resources", "subagents"]), true);
    assert.equal(api.owns("GET", ["api", "sessions", SID, "tasks"]), false);
    assert.equal(api.owns("POST", ["api", "sessions", SID, "tasks", "t1", "cancel"]), false);
    assert.equal(api.dispatch("GET", ["api", "sessions", SID, "tasks"], {}, null), null);
    assert.equal(api.dispatch("POST", ["api", "sessions", SID, "tasks", "t1", "message"], {}, {}), null);
    assert.equal(api.dispatch("GET", ["api", "resources", "subagents", "some-id"], {}, null), null);
    assert.equal(api.lossless?.("PUT", ["api", "resources", "subagents"]), true);
    const calls = [
      ["off", "GET", ["api", "resources", "subagents"], null], ["off", "DELETE", ["api", "resources", "subagents", "a"], null],
      ["nostate", "GET", ["api", "resources", "subagents"], null],
      ...CRUD.map(([method, extra, body]) => ["crud", method, extra, JSON.stringify(body).replace('"n":1', '"n":1.0')]),
    ];
    const python = runPython(PY, JSON.stringify({ offState, crudState, calls }));
    const ours = calls.map(([mode, method, parts, body]) => {
      const target = mode === "off" ? offApi : mode === "nostate" ? nullApi : api;
      const path = mode === "crud" ? ["api", "resources", "subagents", ...(parts as string[])] : parts as string[];
      return target.dispatch(method as string, path, {}, mode === "crud" ? pyJsonLoads(String(body), { lossless: true }) : null);
    });
    assert.equal(timeless(pyJsonDumps(ours)), timeless(python.trim()));
    assert.match(pyJsonDumps(ours), /"n": 1\.0/);
    assert.deepEqual(offApi.dispatch("GET", ["api", "sessions", SID, "tasks"], {}, null), null);
  });
});
