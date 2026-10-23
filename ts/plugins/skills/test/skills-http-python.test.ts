/** Differential: skills resource CRUD and `GET /api/resources/skills/files` against Python. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createSkillsHttp, READ_TOTAL_BUDGET, TOTAL_MAX_CHARS } from "../src/index.ts";

const skip = pythonUnavailableReason();
const FILES = ["api", "resources", "skills", "files"];
const timeless = (text: string): string => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00/g, "<time>");
const CRUD: [string, string[], unknown][] = [
  ["GET", [], {}], ["POST", [], { id: "a", name: "alpha", createOnly: true, n: 1 }], ["POST", [], { id: "a", createOnly: true }], ["POST", [], { id: "a", name: "y", createdAt: "spoof" }],
  ["POST", [], { id: "bad/id" }], ["POST", [], { id: "b", createOnly: "yes" }], ["PATCH", ["a"], { name: "z", id: "a" }], ["PATCH", ["missing"], {}],
  ["PUT", [], { items: [{ id: "c", name: "c" }, { id: "a", name: "a2" }] }], ["PUT", [], { items: [{ id: "x" }, { id: "x" }] }], ["DELETE", ["c"], {}], ["DELETE", ["c"], {}], ["GET", [], {}],
];
const PY = `
import json, sys
from pathlib import Path
from xueness import plugin_runtime, resources
from xueness.bundled_plugins.skills import files_api
a = json.loads(sys.stdin.read())
plugin_runtime.set_enabled(Path(a["offState"]), "skills", False)
base = {"web_runs": Path(a["runs"]), "project_dir": Path(a["project"]), "workspace_roots": [a["root"]]}
ctx = {**base, "state_dir": Path(a["state"])}
out = []
for mode, method, parts, query, body in a["calls"]:
    if mode == "nostate":
        result = files_api.dispatch(method, parts, query, None, base)
    elif mode == "off":
        result = plugin_runtime.dispatch_http(method, parts, query, None, {**base, "state_dir": Path(a["offState"])})
    elif mode == "crud":
        result = resources.dispatch(method, ["api", "resources", "skills", *parts], {}, json.loads(body), {"state_dir": Path(a["crudState"])})
    else:
        result = plugin_runtime.dispatch_http(method, parts, query, None, ctx)
    out.append(None if result is None else [result[0], result[1]])
print(json.dumps(out, ensure_ascii=False))
`;

describe("skills http matches Python", { skip: skip ?? false }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-skills-http-")));
  const root = join(base, "ws"), runs = join(base, "runs"), project = join(base, "project"), outside = join(base, "outside");
  const state = join(base, "state"), offState = join(base, "off"), crudState = join(base, "py-crud"), tsCrud = join(base, "ts-crud");
  for (const dir of [root, runs, project, outside, state, offState, crudState, tsCrud]) mkdirSync(dir, { recursive: true });
  const api = createSkillsHttp({ stateDir: state, webRuns: runs, projectDir: project, enabled: () => true, allowedRoots: () => [root] });
  const offApi = createSkillsHttp({ stateDir: offState, webRuns: runs, projectDir: project, enabled: () => false, allowedRoots: () => [root] });
  const nullApi = createSkillsHttp({ stateDir: null, webRuns: runs, projectDir: project, enabled: () => true, allowedRoots: () => [root] });
  const crudApi = createSkillsHttp({ stateDir: tsCrud, webRuns: runs, projectDir: project, enabled: () => true, allowedRoots: () => [root] });
  after(() => rmSync(base, { recursive: true, force: true }));
  type Call = [string, string, string[], Record<string, string[]>, unknown];

  const replay = (calls: Call[]): unknown[] => {
    const python = runPython(PY, JSON.stringify({ state, runs, project, root, offState, crudState, calls }));
    const ours = calls.map(([mode, method, parts, query, body]) => {
      const target = mode === "off" ? offApi : mode === "nostate" ? nullApi : mode === "crud" ? crudApi : api;
      const path = mode === "crud" ? ["api", "resources", "skills", ...parts] : parts;
      return target.dispatch(method, path, query, mode === "crud" ? pyJsonLoads(String(body), { lossless: true }) : body);
    });
    assert.equal(timeless(pyJsonDumps(ours)), timeless(python.trim()));
    return ours;
  };

  it("lists an empty root and refuses a root outside the fence", () => {
    assert.equal(api.owns("GET", FILES), true);
    assert.equal(api.owns("POST", FILES), true);
    assert.equal(api.owns("GET", ["api", "skills"]), false);
    assert.equal(api.lossless?.("GET", FILES), false);
    assert.equal(api.dispatch("GET", ["api", "nope"], {}, null), null);
    const replies = replay([
      ["http", "GET", FILES, {}, null], ["http", "GET", FILES, { root: [root] }, null], ["http", "GET", FILES, { root: [outside] }, null],
      ["http", "GET", FILES, { root: ["../outside"] }, null], ["http", "POST", FILES, {}, null], ["http", "PUT", FILES, {}, null],
      ["nostate", "GET", FILES, {}, null], ["nostate", "POST", FILES, {}, null], ["http", "GET", ["api", "resources", "skills", "some-id"], {}, null],
    ]);
    const listed = (replies[0] as [number, { root: null; skills: unknown[]; limits: { catalogChars: number; bodyChars: number } }])[1];
    assert.equal(listed.root, null);
    assert.deepEqual(listed.skills, []);
    assert.equal(listed.limits.catalogChars, TOTAL_MAX_CHARS);
    assert.equal(listed.limits.bodyChars, READ_TOTAL_BUDGET);
    assert.equal((replies[2] as [number, { error: string }])[1].error, "workspace root not permitted");
    assert.equal((replies[4] as [number, { error: string }])[1].error, "method not allowed");
    assert.equal((replies[6] as [number, { error: string }])[1].error, "state_dir missing from context");
  });

  it("disables with the plugin and round-trips the resource store", () => {
    const replies = replay([
      ["off", "GET", FILES, {}, null], ["off", "GET", ["api", "resources", "skills"], {}, null],
      ...CRUD.map(([method, extra, body]): Call => ["crud", method, extra, {}, JSON.stringify(body).replace('"n":1', '"n":1.0')]),
    ]);
    assert.match(pyJsonDumps(replies), /"n": 1\.0/);
  });
});
