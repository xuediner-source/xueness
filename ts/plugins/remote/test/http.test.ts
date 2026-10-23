/** `/api/remote` parity with `bundled_plugins/remote/plugin.py` `dispatch` and `connection_api.py`, step by step on twin state directories. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import { createRemoteHttp, resetManagerForTests } from "../src/index.ts";

type Step = [method: string, path: string, data?: unknown];
const node = { id: "node", host: "host.example", user: "operator" };
const STEPS: Step[] = [
  ["GET", "/api/remote"],
  ["POST", "/api/remote", node],
  ["POST", "/api/remote", { ...node, id: "bad id!" }],
  ["POST", "/api/remote", { ...node, port: 70000 }],
  ["POST", "/api/remote", { ...node, extra: true }],
  ["POST", "/api/remote", { ...node, system: "windows", directory: "C:/work" }],
  // A save that does not mention `system` keeps the saved one.
  ["POST", "/api/remote", { ...node, directory: "srv" }],
  ["POST", "/api/remote", { id: "second", host: "10.0.0.2", user: "ops", port: 2222, system: "posix" }],
  ["GET", "/api/remote"],
  ["GET", "/api/remote/active"],
  ["GET", "/api/remote/operations/missing"],
  ["POST", "/api/remote/operations/missing/cancel", {}],
  ["POST", "/api/remote/second/connect", {}],
  ["POST", "/api/remote/second/connect", { requestId: "r-1", expectedDigest: "0".repeat(64) }],
  ["POST", "/api/remote/second/reconnect", { requestId: "r-2", expectedDigest: "0".repeat(64) }],
  ["POST", "/api/remote/second/disconnect", {}],
  ["POST", "/api/remote/second/disconnect", { expectedGeneration: "g-1" }],
  ["POST", "/api/remote/second/request", { method: "x" }],
  ["POST", "/api/remote/second/request", { expectedGeneration: 1, expectedDigest: "d", method: "x", params: {} }],
  ["GET", "/api/remote/second/sessions?offset=-1"],
  ["GET", "/api/remote/second/sessions?limit=101"],
  ["GET", "/api/remote/second/sessions?offset=1&offset=2"],
  ["PUT", "/api/remote", {}],
  ["PUT", "/api/remote/second/unknown", {}],
  ["DELETE", "/api/remote/node"],
  ["DELETE", "/api/remote/never-saved"],
  ["GET", "/api/remote"],
];

const split = (path: string): [string[], Record<string, string[]>] => {
  const [route, search = ""] = path.split("?");
  const query: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) (query[key] ??= []).push(value);
  return [route!.split("/").filter(Boolean), query];
};

it("answers every saved-connection and lifecycle step with the status and body Python's dispatch returns", { skip: pythonUnavailableReason() ?? false }, async () => {
  const base = mkdtempSync(join(tmpdir(), "remote-http-")), py = join(base, "py"), ts = join(base, "ts");
  const expected = JSON.parse(await runPythonAsync(`
import json,os,sys
from pathlib import Path
from xueness import plugin_runtime
from xueness.bundled_plugins.remote import plugin
d=json.load(sys.stdin); out=[]
for raw in (d['py'],d['ts']): Path(raw).mkdir(parents=True); plugin_runtime.set_enabled(raw,'remote',True)
ctx={'state_dir':d['py']}
for method,parts,query,data in d['steps']: out.append(list(plugin.dispatch(method,parts,query,data,ctx) or [None,None]))
sys.stdout.write(json.dumps(out)); sys.stdout.flush(); os._exit(0)
`, JSON.stringify({ py, ts, steps: STEPS.map(([method, path, data]) => [method, ...split(path), data ?? {}]) }))) as unknown[];
  const http = createRemoteHttp({ stateDir: ts, enabled: () => true });
  try {
    for (const [index, [method, path, data]] of STEPS.entries()) {
      const [parts, query] = split(path);
      const reply = await http.dispatch(method, parts, query, data ?? {});
      assert.deepEqual(JSON.parse(JSON.stringify(reply)), expected[index], `${method} ${path}`);
    }
  } finally { http.close(); resetManagerForTests(); rmSync(base, { recursive: true, force: true }); }
});

it("refuses every route while the plugin is off, as the web route gate does", async () => {
  const base = mkdtempSync(join(tmpdir(), "remote-http-off-"));
  const http = createRemoteHttp({ stateDir: base, enabled: () => false });
  try {
    assert.equal(http.owns("GET", ["api", "remote"]), true);
    assert.equal(await http.dispatch("GET", ["api", "sessions"], {}, {}), null);
    assert.deepEqual(await http.dispatch("GET", ["api", "remote"], {}, {}), [403, { error: "plugin disabled or dependency unavailable: remote", plugin: "remote", code: "plugin_disabled" }]);
  } finally { http.close(); rmSync(base, { recursive: true, force: true }); }
});
