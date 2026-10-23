/** The kernel plugin manager (`GET /api/plugins`, `POST /api/plugins/<id>`) against Python `dispatch_http`. */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { NativeFileLocks } from "@xueness/sessions";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createRound8, frontendDeclarations } from "../src/round8-http.ts";

const skip = pythonUnavailableReason();
type Step = [string, string[], string | null];
const plugins = (...rest: string[]): string[] => ["api", "plugins", ...rest];
const on = '{"enabled":true}', off = '{"enabled":false}';

// Frontend declarations come from the TS manifests on both sides; everything else is Python's.
const ORACLE = `
import json, sys
from pathlib import Path
import xueness.plugin_runtime as runtime
runtime.sync_services = lambda ctx: None
spec = json.loads(sys.stdin.read())
ui, state = spec["ui"], Path(spec["state"])
def answer(method, parts, body):
    result = runtime.dispatch_http(method, parts, {}, {} if body is None else json.loads(body), {"state_dir": state})
    if result is None:
        return None
    payload = result[1]
    for item in payload.get("plugins", []) if isinstance(payload, dict) else []:
        declared = ui.get(item.get("id"))
        if declared is None:
            continue
        for key in ("panels", "frontendModules", "desktopModules"):
            if key in declared or key in item:
                item[key] = list(declared.get(key, []))
    return [result[0], payload]
replies = [answer(method, parts, body) for method, parts, body in spec["steps"]]
path = state / "plugin-state.json"
print(json.dumps({"replies": replies, "state": path.read_text() if path.exists() else None}, ensure_ascii=False, sort_keys=True))
`;

describe("plugin catalog matches Python dispatch_http", { skip: skip ?? false }, () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-plugin-catalog-"));
  const locks = new NativeFileLocks();
  after(async () => { await locks.close(); rmSync(base, { recursive: true, force: true }); });
  const ui = Object.fromEntries(frontendDeclarations());
  let count = 0;

  async function same(prepare: (dir: string) => void, steps: Step[]): Promise<Record<string, unknown>[]> {
    const py = join(base, `py${count}`), ts = join(base, `ts${count++}`);
    for (const dir of [py, ts]) { mkdirSync(dir, { recursive: true }); prepare(dir); }
    const python = runPython(ORACLE, JSON.stringify({ ui, state: py, steps })).trim();
    const api = createRound8({ projectRoot: PROJECT_ROOT, stateDir: ts, locks });
    const replies = [];
    for (const [method, parts, body] of steps) {
      assert.ok(api.owns(method, parts), parts.join("/"));
      replies.push(await api.dispatch(method, parts, {}, body === null ? {} : pyJsonLoads(body, { lossless: true }) as Record<string, unknown>));
    }
    const path = join(ts, "plugin-state.json");
    assert.equal(pyJsonDumps({ replies, state: existsSync(path) ? readFileSync(path, "utf8") : null }, { sortKeys: true, ensureAscii: false }), python);
    return replies.map((reply) => (reply?.[1] ?? {}) as Record<string, unknown>);
  }
  const row = (reply: Record<string, unknown>, id: string): Record<string, unknown> => (reply.plugins as Record<string, unknown>[]).find((item) => item.id === id)!;

  it("lists and toggles from a missing state, refusing malformed requests", async () => {
    await same(() => {}, [
      ["GET", plugins(), null], ["POST", plugins("memory"), off], ["GET", plugins(), null], ["POST", plugins("memory"), on],
      ["POST", plugins("nope"), on], ["POST", plugins("memory"), '{"enabled":1}'], ["POST", plugins("memory"), '{"enabled":true,"x":1}'],
      ["POST", plugins("memory"), "{}"], ["POST", plugins("model_monitor"), on], ["PUT", plugins(), null], ["GET", plugins("memory"), null],
      ["POST", plugins(), on], ["DELETE", plugins("memory"), null], ["GET", plugins("memory", "extra"), null], ["POST", plugins("memory", "extra"), on],
    ]);
  });

  it("keeps a profile overlay under explicit switches", async () => {
    const state = '{"apiVersion":1,"enabled":{"memory":true,"browser":false},"profile":{"name":"quiet","overlay":{"subagents":false,"office":true}}}';
    await same((dir) => writeFileSync(join(dir, "plugin-state.json"), state), [["GET", plugins(), null], ["POST", plugins("office"), off], ["GET", plugins(), null]]);
  });

  it("reports corrupt switches as a configuration error", async () => {
    for (const state of ['{"apiVersion":1,"enabled":{"memory":"yes"}}', "{not json", '{"apiVersion":2}']) {
      const [listed] = await same((dir) => writeFileSync(join(dir, "plugin-state.json"), state), [["GET", plugins(), null], ["POST", plugins("memory"), on]]);
      assert.ok(row(listed!, "memory").configurationError);
    }
  });

  it("blocks dependents of a disabled provider", async () => {
    const [listed] = await same((dir) => writeFileSync(join(dir, "plugin-state.json"), '{"apiVersion":1,"enabled":{"files":false}}'), [
      ["GET", plugins(), null], ["POST", plugins("browser"), on], ["POST", plugins("files"), on], ["POST", plugins("browser"), on], ["GET", plugins(), null],
    ]);
    assert.deepEqual(row(listed!, "office").blockedBy, ["files"]);
  });

  it("enables an optional package once its marketplace marker is installed", async () => {
    const [listed] = await same((dir) => {
      mkdirSync(join(dir, "resources", "plugins"), { recursive: true });
      writeFileSync(join(dir, "resources", "plugins", "xueness-model-monitor.json"), '{"id":"xueness-model-monitor","version":"1.0.0","apiVersion":1,"builtin":"model_monitor","capabilities":[]}');
    }, [["GET", plugins(), null], ["POST", plugins("model_monitor"), on], ["POST", plugins("subscriptions"), on], ["GET", plugins(), null]]);
    assert.equal(row(listed!, "model_monitor").installed, true);
    assert.equal(row(listed!, "subscriptions").installed, false);
  });

  it("leaves manifest-claimed sub-families to their owners", () => {
    const api = createRound8({ projectRoot: PROJECT_ROOT, stateDir: join(base, "owners") });
    assert.equal(api.owns("GET", plugins("marketplace")), false);
    assert.equal(api.owns("GET", plugins("profiles")), false);
    assert.equal(api.owns("POST", plugins("marketplace", "validate")), false);
    assert.equal(api.owns("GET", ["api", "pluginsx"]), false);
  });
});
