/** Differential: hooks resource CRUD and `GET /api/resources/hooks/trust` against Python. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createHooksHttp, statusDocument } from "../src/index.ts";

const skip = pythonUnavailableReason();
const TRUST = ["api", "resources", "hooks", "trust"];
const timeless = (text: string): string => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00/g, "<time>");
const CRUD: [string, string[], unknown][] = [
  ["GET", [], {}], ["POST", [], { id: "a", command: "true", createOnly: true, n: 1 }], ["POST", [], { id: "a", createOnly: true }], ["POST", [], { id: "a", command: "y", createdAt: "spoof" }],
  ["POST", [], { id: "bad/id" }], ["POST", [], { id: "b", createOnly: "yes" }], ["POST", [], { id: "..x" }], ["PATCH", ["a"], { command: "z", id: "a", updatedAt: "spoof" }], ["PATCH", ["a"], { id: "b" }],
  ["PATCH", ["missing"], { command: "m" }], ["PATCH", ["bad%20id"], {}], ["PUT", [], { items: [{ id: "c", command: "c", createdAt: "x" }, { id: "a", command: "a2" }] }], ["PUT", [], { items: [{ id: "x" }, { id: "x" }] }],
  ["PUT", [], { items: [{ command: "no id" }] }], ["PUT", [], { items: [{ id: 5 }] }], ["PUT", [], { items: "no" }], ["PUT", [], { items: [7] }], ["DELETE", ["c"], {}], ["DELETE", ["c"], {}], ["DELETE", [".."], {}], ["GET", [], {}],
];
const PY = `
import json, sys
from pathlib import Path
from xueness import plugin_runtime, resources
from xueness.bundled_plugins.hooks import trust_api
a = json.loads(sys.stdin.read())
plugin_runtime.set_enabled(Path(a["offState"]), "hooks", False)
base = {"web_runs": Path(a["runs"]), "project_dir": Path(a["project"]), "workspace_roots": [a["root"]]}
ctx = {**base, "state_dir": Path(a["state"])}
out = []
for mode, method, parts, query, body in a["calls"]:
    if mode == "nostate":
        result = trust_api.dispatch(method, parts, query, None, base)
    elif mode == "off":
        result = plugin_runtime.dispatch_http(method, parts, query, None, {**base, "state_dir": Path(a["offState"])})
    elif mode == "crud":
        result = resources.dispatch(method, ["api", "resources", "hooks", *parts], {}, json.loads(body), {"state_dir": Path(a["crudState"])})
    else:
        result = plugin_runtime.dispatch_http(method, parts, query, None, ctx)
    out.append(None if result is None else [result[0], result[1]])
print(json.dumps(out, ensure_ascii=False))
`;

describe("hooks http matches Python", { skip: skip ?? false }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-hooks-http-")));
  const root = join(base, "ws"), runs = join(base, "runs"), project = join(base, "project"), outside = join(base, "outside");
  const state = join(base, "state"), offState = join(base, "off"), crudState = join(base, "py-crud"), tsCrud = join(base, "ts-crud");
  for (const dir of [root, runs, project, outside, state, offState, crudState, tsCrud]) mkdirSync(dir, { recursive: true });
  const api = createHooksHttp({ stateDir: state, webRuns: runs, projectDir: project, enabled: () => true, allowedRoots: () => [root] });
  const offApi = createHooksHttp({ stateDir: offState, webRuns: runs, projectDir: project, enabled: () => false, allowedRoots: () => [root] });
  const nullApi = createHooksHttp({ stateDir: null, webRuns: runs, projectDir: project, enabled: () => true, allowedRoots: () => [root] });
  const crudApi = createHooksHttp({ stateDir: tsCrud, webRuns: runs, projectDir: project, enabled: () => true, allowedRoots: () => [root] });
  after(() => rmSync(base, { recursive: true, force: true }));

  const replay = (calls: [string, string, string[], Record<string, string[]>, unknown][]): unknown[] => {
    const python = runPython(PY, JSON.stringify({ state, runs, project, root, outside, offState, crudState, calls }));
    const ours = calls.map(([mode, method, parts, query, body]) => {
      const target = mode === "off" ? offApi : mode === "nostate" ? nullApi : mode === "crud" ? crudApi : api;
      const path = mode === "crud" ? ["api", "resources", "hooks", ...(parts as string[])] : parts;
      const data = mode === "crud" ? pyJsonLoads(String(body), { lossless: true }) : body;
      return target.dispatch(method, path, query, data);
    });
    assert.equal(timeless(pyJsonDumps(ours)), timeless(python.trim()));
    return ours;
  };

  it("fences trust, refuses a missing root, and does not treat trust as an id", () => {
    assert.equal(api.owns("GET", TRUST), true);
    assert.equal(api.owns("POST", TRUST), false);
    assert.equal(api.owns("GET", ["api", "mcp"]), false);
    assert.equal(api.lossless?.("GET", TRUST), false);
    assert.equal(api.lossless?.("POST", ["api", "resources", "hooks"]), true);
    assert.equal(api.dispatch("GET", ["api", "nope"], {}, null), null);
    const calls: [string, string, string[], Record<string, string[]>, unknown][] = [
      ["http", "GET", TRUST, {}, null], ["http", "GET", TRUST, { root: [""] }, null], ["http", "GET", TRUST, { root: [outside] }, null],
      ["http", "GET", TRUST, { root: ["\0"] }, null], ["http", "GET", TRUST, { root: ["../outside"] }, null], ["http", "GET", TRUST, { root: [root] }, null],
      ["http", "GET", TRUST, { root: ["../ws"] }, null], ["http", "POST", TRUST, {}, null], ["http", "GET", ["api", "resources", "hooks", "some-id"], {}, null],
      ["http", "GET", ["api", "nope"], {}, null], ["http", "GET", ["api", "resources", "hooks"], {}, null], ["nostate", "GET", TRUST, { root: [root] }, null],
    ];
    const replies = replay(calls);
    assert.equal((replies[0] as [number, { error: string }])[1].error, "root query parameter is required");
    assert.equal((replies[2] as [number, { error: string }])[1].error, "workspace root not permitted");
    assert.equal((replies[5] as [number, { reason: string }])[1].reason, "feature_disabled");
    assert.equal((replies[11] as [number, { error: string }])[1].error, "state_dir missing from context");
  });

  it("reports the trust document for a permitted root", () => {
    mkdirSync(join(root, ".xueness"), { recursive: true });
    writeFileSync(join(root, ".xueness", "hooks.json"), JSON.stringify([{ id: "h1", event: "Stop", command: "true" }]));
    writeFileSync(join(state, "workspace-hooks.json"), JSON.stringify({ enabled: true }));
    const [enabled] = replay([["http", "GET", TRUST, { root: [root] }, null]]);
    assert.equal((enabled as [number, { reason: string; items: { trustState: string }[] }])[1].reason, "pending_trust");
    writeFileSync(join(state, "hook-trust.json"), "{");
    const [corrupt] = replay([["http", "GET", TRUST, { root: [root] }, null]]);
    assert.equal((corrupt as [number, { reason: string }])[1].reason, "trust_store_corrupt");
    assert.equal(pyJsonDumps(statusDocument(state, root)).includes("trust_store_corrupt"), true);
  });

  it("disables with the plugin and round-trips the resource store", () => {
    const replies = replay([
      ["off", "GET", TRUST, { root: [root] }, null], ["off", "GET", ["api", "resources", "hooks"], {}, null], ["off", "POST", ["api", "resources", "hooks"], {}, null],
      ...CRUD.map(([method, extra, body]): [string, string, string[], Record<string, string[]>, unknown] => ["crud", method, extra, {}, JSON.stringify(body).replace('"n":1', '"n":1.0')]),
    ]);
    assert.match(pyJsonDumps(replies), /"n": 1\.0/);
  });
});
