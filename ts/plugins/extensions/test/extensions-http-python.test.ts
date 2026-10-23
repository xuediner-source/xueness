/** Differential tests for the extensions HTTP surface against the Python plugin. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createExtensionsHttp } from "../src/index.ts";
import { NetworkError } from "../src/marketplace.ts";

const skip = pythonUnavailableReason();
const MANIFEST = '{"id":"xueness-hooks","version":"1.0.0","apiVersion":1,"builtin":"hooks","capabilities":["filesystem-write"],"enabled":false}';
const BARE = MANIFEST.replace('["filesystem-write"]', "[]");
const ITEM = `{"id":"xueness-hooks","name":"Hooks","description":"Data-only adapter","manifest":${MANIFEST}}`;
const LISTING = `{"apiVersion":1,"items":[${ITEM}]}`;
const QUIET = '{"name":"quiet","extends":"minimal","description":"custom quiet","plugins":{"extensions":false,"subscriptions":true,"providers":false}}';
const SHADOW = '{"name":"minimal","description":"SHOULD NOT WIN","plugins":{"sessions":false}}';
const SWITCHES = '{"apiVersion":1,"enabled":{"memory":true}}';
type Step = [string, string[], string | null];
const doc = (document: string): string => `{"document":${document}}`;
const timeless = (text: string): string => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00/g, "<time>");

const ORACLE = `
import json, os, sys
os.environ.pop("XUENESS_MARKETPLACE_URL", None)
import xueness.plugin_runtime as runtime
runtime.sync_services = lambda ctx: None
from pathlib import Path
from xueness.bundled_plugins.extensions.plugin import dispatch
from xueness import resources

def answer(state, method, parts, body_text):
    body = {} if body_text is None else json.loads(body_text)
    ctx = {"state_dir": Path(state)}
    result = dispatch(method, parts, {}, body, ctx)
    if result is None and list(parts[:2]) == ["api", "resources"]:
        result = resources.dispatch(method, parts, {}, body, ctx)
    return None if result is None else [result[0], result[1]]

spec = json.loads(sys.stdin.read())
print(json.dumps([answer(spec["state"], method, parts, body) for method, parts, body in spec["steps"]], ensure_ascii=False, sort_keys=True))
`;

const DISABLED = `
import json, os, sys
os.environ.pop("XUENESS_MARKETPLACE_URL", None)
from pathlib import Path
from xueness import plugin_runtime
state = Path(sys.stdin.read().strip())
plugin_runtime.set_enabled(state, "extensions", False)
paths = [("GET", ["api", "plugins", "marketplace"]), ("GET", ["api", "plugins", "profiles"]),
         ("POST", ["api", "plugins", "marketplace", "validate"]), ("GET", ["api", "resources", "plugins"])]
print(json.dumps([list(plugin_runtime.dispatch_http(method, parts, {}, {}, {"state_dir": state})) for method, parts in paths], ensure_ascii=False, sort_keys=True))
`;

function prepare(dir: string): void {
  mkdirSync(join(dir, "plugin-profiles"), { recursive: true });
  writeFileSync(join(dir, "plugin-profiles", "quiet.json"), QUIET);
  writeFileSync(join(dir, "plugin-profiles", "minimal.json"), SHADOW);
  writeFileSync(join(dir, "plugin-state.json"), SWITCHES);
}

async function same(pyState: string, tsState: string, steps: Step[]): Promise<void> {
  const python = timeless(runPython(ORACLE, JSON.stringify({ state: pyState, steps })).trim());
  const env = { ...process.env };
  delete env.XUENESS_MARKETPLACE_URL;
  const api = createExtensionsHttp({ stateDir: tsState, enabled: true, env });
  const ours = [];
  for (const [method, parts, body] of steps) ours.push(await api.dispatch(method, parts, {}, body === null ? {} : pyJsonLoads(body, { lossless: true })));
  assert.equal(timeless(pyJsonDumps(ours, { sortKeys: true, ensureAscii: false })), python);
}

const VALIDATE: Step[] = [
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST)],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(BARE)],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace('"1.0.0"', "null"))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace('"xueness-hooks"', '"Trusted Hooks"'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace('"apiVersion":1', '"apiVersion":2'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace('"hooks"', '"kernel"'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace('["filesystem-write"]', '"filesystem-write"'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace('["filesystem-write"]', '["filesystem-read"]'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace(/}$/, ',"entrypoint":"payload.py"}'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc('{"features":[],"id":"usage"}')],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(MANIFEST.replace(/}$/, ',"note":1,"command":"curl"}'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING)],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace(`"manifest":${MANIFEST}`, `"sha256":"${"0".repeat(64)}","manifest":${MANIFEST}`))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace('"id":"xueness-hooks","name"', '"id":"xueness-other","name"'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(`{"apiVersion":1,"items":[${ITEM},${ITEM}]}`)],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc('{"items":[1]}')],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc('{"apiVersion":1,"items":[]}')],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace('"apiVersion":1', '"apiVersion":7'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace(/}$/, ',"script":"x"}'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace('"Hooks"', `"${"n".repeat(200)}"`))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace('"capabilities":["filesystem-write"]', '"capabilities":["filesystem-write"],"entrypoint":"payload.py"'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc('{"id":"xueness-hooks","name":"Hooks"}')],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace('"apiVersion":1', '"apiVersion":true'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], doc(LISTING.replace('"apiVersion":1', '"apiVersion":1.0'))],
  ["POST", ["api", "plugins", "marketplace", "validate"], "{}"],
  ["POST", ["api", "plugins", "marketplace", "validate"], `${doc(LISTING).slice(0, -1)},"path":"/etc/passwd"}`],
  ["POST", ["api", "plugins", "marketplace", "validate"], '{"document":7}'],
  ["GET", ["api", "plugins", "marketplace", "validate"], null],
  ["POST", ["api", "plugins", "marketplace", "nope"], null],
  ["GET", ["api", "plugins", "profiles", "nope"], null],
];

describe("extensions HTTP matches Python", { skip: skip ?? false }, () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-extensions-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  it("matches the empty-state catalog, inline validation and profile list", async () => {
    const state = join(base, "shared");
    prepare(state);
    await same(state, state, [
      ["GET", ["api", "plugins", "marketplace"], null],
      ...VALIDATE,
      ["GET", ["api", "plugins", "profiles"], null],
      ["POST", ["api", "plugins", "profiles", "apply"], JSON.stringify({ name: "quiet", dryRun: true })],
      ["POST", ["api", "plugins", "profiles", "apply"], JSON.stringify({ name: "missing" })],
      ["POST", ["api", "plugins", "profiles", "apply"], JSON.stringify({ name: "quiet", extra: true })],
      ["POST", ["api", "plugins", "profiles", "apply"], "{}"],
    ]);
  });

  it("applies a profile and installs a catalog manifest the same way", async () => {
    const py = join(base, "apply-py");
    const ts = join(base, "apply-ts");
    prepare(py);
    prepare(ts);
    await same(py, ts, [
      ["POST", ["api", "plugins", "profiles", "apply"], JSON.stringify({ name: "quiet" })],
      ["GET", ["api", "plugins", "profiles"], null],
    ]);
    const instPy = join(base, "inst-py");
    const instTs = join(base, "inst-ts");
    mkdirSync(instPy);
    mkdirSync(instTs);
    await same(instPy, instTs, [["GET", ["api", "plugins", "marketplace"], null]]);
    const env = { ...process.env };
    delete env.XUENESS_MARKETPLACE_URL;
    const preview = await createExtensionsHttp({ stateDir: instTs, enabled: true, env }).dispatch("GET", ["api", "plugins", "marketplace"], {}, {});
    const row = (preview?.[1] as { marketplace: { id: string; sha256: string }[] }).marketplace[0]!;
    const install = (action: string, sha256: string): Step => ["POST", ["api", "plugins", "marketplace", row.id, action], JSON.stringify({ sha256 })];
    await same(instPy, instTs, [install("install", "0".repeat(64)), install("install", row.sha256), install("install", row.sha256), install("update", row.sha256)]);
  });

  it("matches resources/plugins CRUD and keeps Python numbers", async () => {
    const crud: Step[] = [
      ["GET", ["api", "resources", "plugins"], null],
      ["POST", ["api", "resources", "plugins"], '{"id":"a","prompt":"x","createOnly":true,"n":1.0}'],
      ["POST", ["api", "resources", "plugins"], '{"id":"a","createOnly":true}'],
      ["POST", ["api", "resources", "plugins"], '{"id":"a","prompt":"y","createdAt":"spoof"}'],
      ["POST", ["api", "resources", "plugins"], '{"id":"bad/id"}'],
      ["PATCH", ["api", "resources", "plugins", "a"], '{"prompt":"z","id":"a","updatedAt":"spoof"}'],
      ["PUT", ["api", "resources", "plugins"], '{"items":[{"id":"c","prompt":"c"},{"id":"a","prompt":"a2"}]}'],
      ["DELETE", ["api", "resources", "plugins", "c"], null],
      ["DELETE", ["api", "resources", "plugins", "c"], null],
      ["GET", ["api", "resources", "plugins"], null],
      ["GET", ["api", "resources", "plugins", "a"], null],
    ];
    mkdirSync(join(base, "res-py"));
    mkdirSync(join(base, "res-ts"));
    await same(join(base, "res-py"), join(base, "res-ts"), crud);
    const kept = pyJsonDumps(pyJsonLoads(crud[1]![2]!, { lossless: true }), { sortKeys: true });
    assert.match(kept, /"n": 1\.0/);
  });

  it("returns the host 403 when extensions is disabled", async () => {
    const state = join(base, "disabled");
    mkdirSync(state);
    const python = runPython(DISABLED, state).trim();
    const env = { ...process.env };
    delete env.XUENESS_MARKETPLACE_URL;
    const api = createExtensionsHttp({ stateDir: join(base, "disabled-ts"), enabled: false, env });
    const paths: [string, string[]][] = [
      ["GET", ["api", "plugins", "marketplace"]],
      ["GET", ["api", "plugins", "profiles"]],
      ["POST", ["api", "plugins", "marketplace", "validate"]],
      ["GET", ["api", "resources", "plugins"]],
    ];
    const ours = [];
    for (const [method, parts] of paths) ours.push(await api.dispatch(method, parts, {}, {}));
    assert.equal(pyJsonDumps(ours, { sortKeys: true, ensureAscii: false }), python);
    assert.equal((ours[0] as [number, { error: string }])[1].error, "plugin disabled or dependency unavailable: extensions");
  });

  it("uses an injected fetcher and does not fetch when the URL is unset", async () => {
    const state = join(base, "fetch");
    mkdirSync(state);
    const env = { ...process.env, XUENESS_MARKETPLACE_URL: "https://example.test/catalog.json" };
    const missing = createExtensionsHttp({ stateDir: state, enabled: true, env });
    await assert.rejects(() => missing.dispatch("GET", ["api", "plugins", "marketplace"], {}, {}), (error: unknown) => error instanceof NetworkError);
    const remote = `{"items":[{"id":"xueness-subscriptions","name":"drop","description":"drop","manifest":{"id":"xueness-subscriptions","version":"9.9.9","apiVersion":1,"builtin":"subscriptions","capabilities":[],"enabled":false}},${ITEM}]}`;
    const fetched = createExtensionsHttp({ stateDir: state, enabled: true, env, fetchUrl: () => ({ output: remote, truncated: false }) });
    const reply = await fetched.dispatch("GET", ["api", "plugins", "marketplace"], {}, {});
    const ids = ((reply?.[1] as { marketplace: { id: string; source: string; version: string }[] }).marketplace).map((row) => [row.id, row.source, row.version]);
    assert.deepEqual(ids, [
      ["xueness-hooks", env.XUENESS_MARKETPLACE_URL, "1.0.0"],
      ["xueness-subscriptions", "bundled", "1.0.0"],
      ["xueness-model-monitor", "bundled", "1.0.0"],
      ["xueness-workbuddy", "bundled", "1.0.0"],
    ]);
    const broken = createExtensionsHttp({ stateDir: state, enabled: true, env, fetchUrl: () => ({ output: "{", truncated: false }) });
    assert.deepEqual(await broken.dispatch("GET", ["api", "plugins", "marketplace"], {}, {}), [400, { error: "marketplace validation or installation failed" }]);
    const huge = createExtensionsHttp({ stateDir: state, enabled: true, env, fetchUrl: () => ({ output: "{}", truncated: true }) });
    assert.deepEqual(await huge.dispatch("GET", ["api", "plugins", "marketplace"], {}, {}), [400, { error: "marketplace validation or installation failed" }]);
  });
});
