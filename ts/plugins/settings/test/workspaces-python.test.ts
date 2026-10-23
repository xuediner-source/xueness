import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { listLevel } from "@xueness/plugin-files";
import { createSettingsApi, declaredWorkspaceRoots, isTooBroadNativeRoot, PickerFailed, PickerUnavailable } from "../src/index.ts";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const ORACLE = `
import json,sys
from pathlib import Path
from xueness import plugin_runtime
from xueness.bundled_plugins.settings import workspaces_api as w
p=json.loads(sys.stdin.read()); state=Path(p['state']); script=iter(p['chooser']); seen=[]; enabled={}
plugin_runtime.is_enabled=lambda state_dir, pid: enabled.get(pid, True)
def choose(initial_root):
    seen.append(initial_root); kind, value = next(script)
    if kind == 'raise': raise {'NotImplementedError': NotImplementedError, 'RuntimeError': RuntimeError}[value]('dialog')
    if kind == 'disable': enabled['sessions'] = False
    return value
w._choose_native_directory=choose
w.native_picker_capability=lambda platform_name=None: {'available': True, 'platform': 'macos'}
class Handler:
    def __init__(self, host): self.client_address=(host, 50000)
ctx={'state_dir': state, 'project_dir': Path(p['project']), 'web_runs': Path(p['runs']), 'workspace_roots': tuple(Path(r) for r in p['declared']), 'max_entries': p['max']}
out=[]
for method, path, query, data, host, toggles in p['requests']:
    enabled.update(toggles)
    try: reply=w.dispatch(method, [x for x in path.split('/') if x], query, data, {**ctx, 'handler': Handler(host)} if host else ctx)
    except Exception as exc: reply=[type(exc).__name__, str(exc)]
    out.append([reply, (state/'settings.json').read_text(encoding='utf-8') if (state/'settings.json').exists() else None])
broad=[w._is_too_broad_native_root(Path(x)) for x in p['broad']]
from xueness import web
import os
os.environ['XUENESS_WORKSPACE_ROOTS']=p['env']
declared=[str(x) for x in web._declared_workspace_roots(p['additional'])]
print(json.dumps({'out': out, 'seen': seen, 'broad': broad, 'declared': declared}, ensure_ascii=False))
`;

const NOW = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?Z/g;
const normal = (value: unknown): unknown => JSON.parse(pyJsonDumps(value).replace(NOW, "<time>"));

it("answers /api/workspaces, grants and the native picker exactly as Python workspaces_api", { skip: pythonUnavailableReason() ?? (process.platform === "win32" ? "POSIX fixture" : false) }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-workspaces-")));
  const at = (...parts: string[]) => join(base, ...parts), proj = at("proj"), runs = at("runs"), extra = at("extra"), outside = at("outside");
  const session = join(runs, "0123456789abcdef0123456789abcdef");
  for (const dir of [join(proj, "a"), join(proj, "b"), join(proj, ".hid"), join(proj, "ro"), session, join(extra, "x"), outside, at("chosen"), at("chosen2"), at("ts"), at("py")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(proj, "file.txt"), "x"); symlinkSync("a", join(proj, "link-in")); symlinkSync(outside, join(proj, "link-out")); chmodSync(join(proj, "ro"), 0o555);
  const initial = `{"general": {"zoom": 1.0, "big": 123456789012345678901234567890}, "workspace": {"defaultRoot": ${JSON.stringify(join(extra, "x"))},
    "recentDirectories": [{"path": ${JSON.stringify(join(proj, "a"))}, "lastUsed": "2026-01-01T00:00:00Z"}, {"path": ${JSON.stringify(outside)}}, {"path": ${JSON.stringify(session)}}, "junk",
      {"path": ${JSON.stringify(join(proj, "a"))}, "lastUsed": "dup"}, {"path": ${JSON.stringify(join(proj, "b"))}, "lastUsed": 5}],
    "selectedRoots": [${[at("chosen"), "/", "relative", at("chosen", "..", "chosen"), 5, at("missing"), join(proj, "link-in")].map((x) => JSON.stringify(x)).join(", ")}]}}`;
  writeFileSync(at("ts", "settings.json"), initial); writeFileSync(at("py", "settings.json"), initial);
  const local = "127.0.0.1", remote = "203.0.113.9", picker = "/api/workspaces/native-picker";
  type Request = [string, string, Record<string, string[]>, unknown, string | null, Record<string, boolean>];
  const requests: Request[] = [
    ["GET", "/api/workspaces", {}, {}, null, {}], ["GET", "/api/workspaces", { path: [join(proj, "a")] }, {}, null, {}], ["GET", "/api/workspaces", { path: [outside] }, {}, null, {}],
    ["GET", "/api/workspaces", { path: [proj], includeHidden: ["1"] }, {}, null, {}], ["GET", "/api/workspaces", { path: [proj], includeHidden: [" NO "] }, {}, null, {}],
    ["GET", "/api/workspaces", { path: ["relative"] }, {}, null, {}], ["GET", "/api/workspaces", { path: ["/"] }, {}, null, {}], ["GET", "/api/workspaces", { path: [join(proj, "file.txt")] }, {}, null, {}],
    ["GET", "/api/workspaces", { path: [at("chosen")] }, {}, null, {}], ["GET", "/api/workspaces", { path: [join(proj, "link-in")] }, {}, null, {}], ["POST", "/api/workspaces", {}, {}, null, {}],
    ["POST", "/api/workspaces/default", {}, { root: join(proj, "b") }, null, {}], ["POST", "/api/workspaces/default", {}, { root: join(proj, "b"), extra: 1 }, null, {}],
    ["POST", "/api/workspaces/confirm", {}, { root: extra }, null, {}], ["POST", "/api/workspaces/confirm", {}, { root: session }, null, {}], ["GET", "/api/workspaces/other", {}, {}, null, {}],
    ["GET", "/api/workspaces/default", {}, {}, null, {}], ["POST", "/api/workspaces/confirm", {}, { root: "/" }, null, {}], ["POST", "/api/workspaces/confirm", {}, { root: 5 }, null, {}],
    ["POST", "/api/workspaces/confirm", {}, { root: join(proj, "ro") }, null, {}], ["POST", "/api/workspaces/a/b", {}, {}, null, {}],
    ["GET", picker, {}, {}, null, {}], ["GET", picker, {}, {}, remote, {}], ["GET", picker, {}, {}, local, {}], ["PUT", picker, {}, {}, local, {}], ["POST", picker, {}, {}, remote, {}],
    ["POST", picker, {}, { foo: 1 }, local, {}], ["POST", picker, {}, { initialRoot: outside }, local, {}], ["POST", picker, {}, {}, local, {}], ["POST", picker, {}, { initialRoot: join(proj, "a") }, local, {}],
    ...Array.from({ length: 10 }, (): Request => ["POST", picker, {}, {}, local, {}]),
    ["POST", picker, {}, {}, local, {}], ["GET", "/api/workspaces", {}, {}, null, { sessions: true }], ["GET", "/api/workspaces", {}, {}, null, { sessions: false }],
    ["POST", "/api/workspaces/default", {}, { root: at("chosen2") }, null, { sessions: true }], ["GET", "/api/workspaces", { path: [join(proj, "a")] }, {}, null, {}],
  ];
  const chooser: [string, unknown][] = [["value", at("chosen2")], ["value", null], ["value", "relative/path"], ["value", "/"], ["value", join(proj, "file.txt")], ["value", at("missing")],
    ["raise", "RuntimeError"], ["raise", "NotImplementedError"], ["value", ""], ["value", at("chosen2")], ["value", join(proj, "link-in")], ["value", `${proj}/a\u0000`], ["disable", at("chosen")]];
  const broad = ["/", "/tmp", tmpdir(), homedir(), "/usr", "/usr/local", base, "/proc", "/dev/shm", "/sys/fs", at("missing")];
  const env = [extra, "ts", "/", "/tmp", at("missing"), " ", join(proj, "file.txt"), extra].join(":"), additional = [proj, join(proj, "link-in"), proj];
  try {
    const expected = pyJsonLoads(runPython(ORACLE, JSON.stringify({ state: at("py"), project: proj, runs, declared: [extra], max: 3, requests, chooser, broad, env, additional }))) as Record<string, unknown[]>;
    const toggles = new Map<string, boolean>(), seen: unknown[] = [], script = chooser[Symbol.iterator]();
    const api = createSettingsApi({ stateDir: at("ts"), projectDir: proj, webRuns: runs, declaredRoots: [extra], maxEntries: 3, listLevel, enabled: (id) => toggles.get(id) ?? true,
      capability: () => ({ available: true, platform: "macos" }),
      async chooser(initialRoot) {
        seen.push(initialRoot);
        const [kind, value] = script.next().value as [string, unknown];
        if (kind === "raise") throw value === "RuntimeError" ? new PickerFailed("dialog") : new PickerUnavailable("dialog");
        if (kind === "disable") toggles.set("sessions", false);
        return value as string | null;
      } });
    const out: unknown[] = [];
    for (const [method, path, query, data, host, changes] of requests) {
      for (const [id, on] of Object.entries(changes)) toggles.set(id, on);
      let reply: unknown;
      try { reply = await api.dispatch(method, path.split("/").filter(Boolean), query, pyJsonLoads(JSON.stringify(data), { lossless: true }), { loopback: host === local }); } catch (error) { reply = [(error as Error).name, (error as Error).message]; }
      out.push([reply, existsSync(at("ts", "settings.json")) ? readFileSync(at("ts", "settings.json"), "utf8") : null]);
    }
    assert.deepEqual(normal(out), normal(expected.out));
    assert.deepEqual(seen, expected.seen);
    assert.deepEqual(broad.map((path) => isTooBroadNativeRoot(path)), expected.broad);
    assert.deepEqual(declaredWorkspaceRoots(additional, env, PROJECT_ROOT), expected.declared);
    // The host gate Python applies before plugin dispatch (`Handler._guard`).
    toggles.set("settings", false);
    assert.deepEqual(await api.dispatch("GET", ["api", "workspaces"], {}, {}), [403, { error: "plugin disabled or dependency unavailable: settings", plugin: "settings", code: "plugin_disabled" }]);
    assert.equal(api.owns("HEAD", ["api", "workspaces"]), false);
    assert.equal(createSettingsApi({ ...api.workspaces.options, desktop: true }).owns("POST", ["api", "workspaces", "native-picker"]), false);
  } finally {
    chmodSync(join(proj, "ro"), 0o755);
    rmSync(base, { recursive: true, force: true });
  }
});
