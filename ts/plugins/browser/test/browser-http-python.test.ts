/**
 * Browser HTTP against Python `dispatch_http`. Runtime and Chrome are stubbed.
 * Refusals compare status and JSON. No browser process is started.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { createBrowserHttp, type BrowserHttpOptions, type BrowserReply } from "../src/index.ts";

type Row = Record<string, unknown>;
type Call = { method: string; parts: string[]; data?: Row };
interface Flags {
  browser?: boolean; desktopPlugin?: boolean; desktop?: boolean; running?: boolean;
  chromeRoot?: string | null; chromeRunning?: boolean; project?: string; web?: string;
  sessions?: Record<string, Row>;
}
interface Spec {
  flags?: Flags; calls: Call[]; expect: { status: number; body: Row }[];
  seed?: Record<string, string>; tree?: Record<string, unknown>; keep?: string[]; drop?: string[];
}

const RUNTIME = { available: true, browser: "Chrome", reason: null };
const SID = "a".repeat(32);
const TABS = ["api", "browser", "tabs"];
const DATA = ["api", "browser", "data"];
const PROFILES = ["api", "browser", "profiles"];
const RUNTIME_PATH = ["api", "browser", "runtime"];
const base = mkdtempSync(join(tmpdir(), "xue-bhttp-"));
const project = join(base, "project");
const web = join(base, "web");
const outside = join(base, "outside");
const chrome = join(base, "chrome");
const broken = join(base, "broken-chrome");
const skipPython = pythonUnavailableReason();
after(() => rmSync(base, { recursive: true, force: true }));

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
function present(root: string, rel: string): boolean {
  try { statSync(join(root, ...rel.split("/"))); return true; } catch { return false; }
}
function profileTree(state: string): Record<string, unknown> {
  const root = join(state, "browser-profile");
  const out: Record<string, unknown> = {};
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, rel);
      else out[rel] = rel === "Local State" ? JSON.parse(readFileSync(path, "utf8")) : readFileSync(path, "utf8");
    }
  };
  walk(root, "");
  return out;
}
const VOLATILE = new Set(["pageId", "workspaceId", "approvalId", "subject"]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Row = {};
    for (const [key, item] of Object.entries(value as Row)) if (!VOLATILE.has(key)) out[key] = stable(item) as never;
    return out;
  }
  return value;
}
function httpFor(state: string, flags: Flags = {}) {
  const options: BrowserHttpOptions = {
    stateDir: state,
    enabled: (id) => id === "browser" ? flags.browser !== false : id === "desktop" ? flags.desktopPlugin !== false : true,
    running: flags.running ? new Set(["task"]) : new Set(),
    desktop: flags.desktop !== false,
    chromeRoot: flags.chromeRoot === undefined ? null : flags.chromeRoot,
    chromeRunning: () => flags.chromeRunning === true,
    runtime: () => RUNTIME,
    ...(flags.project ? { projectDir: flags.project } : {}),
    ...(flags.web ? { webRuns: flags.web } : {}),
    ...(flags.sessions ? { loadSession: (_dir, id) => { const row = flags.sessions?.[id]; if (!row) throw new Error("invalid session id"); return row; } } : {}),
  };
  return createBrowserHttp(options);
}
async function dispatchAll(state: string, flags: Flags, calls: Call[]): Promise<BrowserReply[]> {
  const http = httpFor(state, flags);
  const replies: BrowserReply[] = [];
  let pageId = "";
  for (const call of calls) {
    const parts = call.parts.map((part) => part === "$page" ? pageId : part);
    const reply = await http.dispatch(call.method, parts, call.data ?? {});
    assert.ok(reply, call.method + " " + parts.join("/"));
    if (typeof reply[1].pageId === "string") pageId = reply[1].pageId;
    replies.push(reply);
  }
  return replies;
}

const err = (status: number, error: string) => [{ status, body: { error } }];
const ok = (body: Row) => [{ status: 200, body }];
const tab = (extra: Row = {}): Flags => ({ project, web, chromeRoot: null, sessions: { [SID]: { id: SID, root: project, ...extra } } });
const open = (data: Row = { sessionId: SID }): Call => ({ method: "POST", parts: TABS, data });
const action = (data: Row): Call => ({ method: "POST", parts: [...TABS, "$page", "action"], data });
const opened = { status: 200, body: { sessionId: SID, title: "Browser", url: "" } };
const eight = Array.from({ length: 8 }, () => open());
const names = [{ id: "Default", name: "Work" }, { id: "Profile 2", name: "x".repeat(80) }];
const localState = { profile: { info_cache: { Default: { name: " Work\n" }, "Profile 2": { name: "x".repeat(90) } }, last_used: "Profile 9" }, os_crypt: { encrypted_key: "abc" }, account_info: [{ email: "a@b.c" }] };
const imported = { profile: { last_used: "Default" }, os_crypt: { encrypted_key: "abc" } };

const cases: Spec[] = [
  { flags: { browser: false }, calls: [{ method: "GET", parts: RUNTIME_PATH }], expect: err(403, "plugin disabled or dependency unavailable: browser").map((item) => ({ status: item.status, body: { ...item.body, plugin: "browser" } })) },
  { flags: { browser: false, desktop: false }, calls: [{ method: "GET", parts: PROFILES }], expect: [{ status: 403, body: { error: "plugin disabled or dependency unavailable: browser", plugin: "browser" } }] },
  { flags: { browser: false }, calls: [open()], expect: [{ status: 403, body: { error: "plugin disabled or dependency unavailable: browser", plugin: "browser" } }] },
  { calls: [{ method: "POST", parts: RUNTIME_PATH }], expect: err(405, "method not allowed") },
  { calls: [{ method: "PUT", parts: DATA }], expect: err(405, "method not allowed") },
  { calls: [{ method: "DELETE", parts: PROFILES }], expect: err(405, "method not allowed") },
  { calls: [{ method: "GET", parts: [...TABS, "missing", "action"] }], expect: err(405, "method not allowed") },
  { calls: [{ method: "PUT", parts: TABS }], expect: err(405, "method not allowed") },
  { calls: [{ method: "GET", parts: [...TABS, "missing"] }], expect: err(405, "method not allowed") },
  { flags: { desktop: false }, calls: [{ method: "PUT", parts: PROFILES }], expect: err(403, "desktop_required") },
  { flags: { desktop: false }, calls: [{ method: "GET", parts: PROFILES }], expect: err(403, "desktop_required") },
  { flags: { desktopPlugin: false }, calls: [{ method: "GET", parts: PROFILES }], expect: err(403, "desktop_required") },
  { calls: [{ method: "POST", parts: DATA, data: { operation: "all" } }], expect: err(400, "confirmation required to clear all browser data") },
  { calls: [{ method: "POST", parts: DATA, data: { operation: "all", confirmed: "true" } }], expect: err(400, "confirmation required to clear all browser data") },
  { flags: { running: true }, calls: [{ method: "POST", parts: DATA, data: { operation: "all" } }], expect: err(400, "confirmation required to clear all browser data"), seed: { "browser-profile/Default/Cookies": "stay" }, keep: ["browser-profile/Default/Cookies"] },
  { flags: { running: true }, calls: [{ method: "POST", parts: DATA, data: { operation: "all", confirmed: true } }], expect: err(409, "stop running tasks before clearing browser data"), seed: { "browser-profile/Default/Cookies": "stay" }, keep: ["browser-profile/Default/Cookies"] },
  { flags: { running: true }, calls: [{ method: "POST", parts: DATA, data: { operation: "cache" } }], expect: err(409, "stop running tasks before clearing browser data"), seed: { "browser-profile/Default/Cookies": "stay" }, keep: ["browser-profile/Default/Cookies"] },
  { calls: [{ method: "POST", parts: DATA, data: {} }], expect: err(400, "expected cache or all operation") },
  { calls: [{ method: "POST", parts: DATA, data: { operation: "cache", extra: 1 } }], expect: err(400, "expected cache or all operation") },
  { calls: [{ method: "POST", parts: DATA, data: { operation: "nope" } }], expect: err(400, "managed browser data unavailable or invalid"), seed: { "browser-profile": "file" } },
  { calls: [{ method: "GET", parts: DATA }], expect: ok({ profilePresent: false }) },
  { calls: [{ method: "GET", parts: DATA }], expect: ok({ profilePresent: true }), seed: { "browser-profile/Default/Cookies": "session" } },
  { calls: [{ method: "POST", parts: DATA, data: { operation: "cache" } }], expect: ok({ ok: true }), seed: { "browser-profile/Default/Cookies": "session", "browser-profile/Default/Cache/data": "cache", "browser-profile/Cache/x": "top", "browser-profile-other/Cache/a": "other" }, tree: { "Default/Cookies": "session" }, keep: ["browser-profile-other/Cache/a"], drop: ["browser-profile/Default/Cache/data", "browser-profile/Cache/x"] },
  { calls: [{ method: "POST", parts: DATA, data: { operation: "all", confirmed: true } }], expect: ok({ ok: true }), seed: { "browser-profile/Default/Cookies": "session", ["browser-import-old-" + "ab".repeat(16) + "/Cookies"]: "old", "browser-import-old-personal/Cookies": "personal" }, tree: {}, drop: ["browser-profile/Default/Cookies", "browser-import-old-" + "ab".repeat(16) + "/Cookies"], keep: ["browser-import-old-personal/Cookies"] },
  { flags: { desktop: false }, calls: [{ method: "GET", parts: RUNTIME_PATH }], expect: ok({ ...RUNTIME, desktop: false, importEnabled: false }) },
  { calls: [{ method: "GET", parts: RUNTIME_PATH }], expect: ok({ ...RUNTIME, desktop: true, importEnabled: true }) },
  { flags: { desktopPlugin: false }, calls: [{ method: "GET", parts: RUNTIME_PATH }], expect: ok({ ...RUNTIME, desktop: true, importEnabled: false }) },
  { calls: [{ method: "GET", parts: PROFILES }], expect: ok({ profiles: [] }) },
  { flags: { chromeRoot: chrome }, calls: [{ method: "GET", parts: PROFILES }], expect: ok({ profiles: names }) },
  { calls: [{ method: "POST", parts: PROFILES, data: {} }], expect: err(400, "confirmation_required") },
  { calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Default", confirmed: false } }], expect: err(400, "confirmation_required") },
  { calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Default", confirmed: true, extra: 1 } }], expect: err(400, "confirmation_required") },
  { flags: { running: true, chromeRoot: chrome }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Default", confirmed: true } }], expect: err(409, "tasks_running") },
  { flags: { chromeRunning: true, chromeRoot: chrome }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Not A Profile", confirmed: true } }], expect: err(400, "profile_not_found") },
  { flags: { chromeRunning: true, chromeRoot: chrome }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Profile 999", confirmed: true } }], expect: err(409, "close_chrome") },
  { flags: { chromeRoot: chrome }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Profile 999", confirmed: true } }], expect: err(400, "profile_not_found") },
  { flags: { chromeRoot: chrome }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: 1, confirmed: true } }], expect: err(400, "profile_not_found") },
  { flags: { chromeRoot: broken }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Default", confirmed: true } }], expect: err(400, "source_invalid"), drop: ["browser-profile"] },
  { flags: { chromeRoot: chrome, chromeRunning: false }, calls: [{ method: "POST", parts: PROFILES, data: { profileId: "Default", confirmed: true } }], expect: ok({ ok: true, profilePresent: true, loginMayRequireSignIn: true, cleanupPending: false }), tree: { "Local State": imported, "Default/Cookies": "cookie-bytes", "Default/Bookmarks": "marks" } },
  { calls: [open({})], expect: err(400, "at most eight browser tabs may be open") },
  { flags: tab(), calls: [open({ sessionId: "bad id" })], expect: err(400, "invalid session") },
  { flags: tab(), calls: [open({ sessionId: SID, extra: 1 })], expect: err(400, "at most eight browser tabs may be open") },
  { flags: tab({ remote_connection: null }), calls: [open()], expect: err(400, "remote browser adapter unavailable") },
  { flags: tab({ id: "other" }), calls: [open()], expect: err(400, "session binding changed") },
  { flags: { ...tab(), sessions: { [SID]: { id: SID, root: outside } } }, calls: [open()], expect: err(400, "workspace root not permitted") },
  { flags: tab(), calls: [open(), { method: "GET", parts: TABS }], expect: [opened, { status: 200, body: { tabs: [{ sessionId: SID, title: "Browser", url: "" }] } }] },
  { flags: tab(), calls: [...eight, open()], expect: [...eight.map(() => opened), { status: 400, body: { error: "at most eight browser tabs may be open" } }] },
  { flags: tab(), calls: [{ method: "POST", parts: [...TABS, "dead", "action"], data: { action: "refresh" } }], expect: err(404, "browser tab not found") },
  { flags: tab(), calls: [{ method: "POST", parts: [...TABS, "dead", "nope"], data: {} }], expect: err(404, "browser tab not found") },
  { flags: tab(), calls: [open(), { method: "POST", parts: [...TABS, "$page", "nope"], data: {} }], expect: [opened, { status: 404, body: { error: "browser operation not found" } }] },
  { flags: tab(), calls: [open(), { method: "POST", parts: [...TABS, "$page", "close"], data: { x: 1 } }], expect: [opened, { status: 400, body: { error: "close body must be empty" } }] },
  { flags: tab(), calls: [open(), { method: "POST", parts: [...TABS, "$page", "close"], data: {} }], expect: [opened, { status: 200, body: { ok: true } }] },
  { flags: tab(), calls: [open(), action({ action: "navigate", url: "https://example.com", extra: 1 })], expect: [opened, { status: 400, body: { error: "unknown action fields" } }] },
  { flags: tab(), calls: [open(), action({ action: "close" })], expect: [opened, { status: 400, body: { error: "unsupported browser action" } }] },
  { flags: tab(), calls: [open(), action({ action: "navigate" })], expect: [opened, { status: 400, body: { error: "invalid action fields" } }] },
  { flags: tab(), calls: [open(), action({ action: "navigate", url: "u".repeat(4097) })], expect: [opened, { status: 400, body: { error: "action exceeds bounds" } }] },
  { flags: tab({ permission_mode: "plan" }), calls: [open(), action({ action: "navigate", url: "https://example.com" })], expect: [opened, { status: 403, body: { error: "browser actions denied in plan mode" } }] },
  { flags: tab(), calls: [open(), action({ action: "refresh" })], expect: [opened, { status: 200, body: { approvalRequired: true } }] },
  { flags: tab(), calls: [open(), { method: "POST", parts: [...TABS, "$page", "cancel"], data: {} }], expect: [opened, { status: 400, body: { error: "exact pending approval required" } }] },
  { flags: tab(), calls: [open(), { method: "POST", parts: [...TABS, "$page", "cancel"], data: { approvalId: "nope", subject: "nope" } }], expect: [opened, { status: 409, body: { ok: false, cancelled: false, error: "Pending approval changed or is no longer available; cancellation not confirmed." } }] },
];

const ORACLE = String.raw`
import json, sys, threading
from pathlib import Path
from unittest.mock import patch
from xueness.plugin_runtime import dispatch_http, set_enabled
from xueness.bundled_plugins.browser import tabs_api
from xueness.bundled_plugins.browser import profiles as profiles_mod
from xueness.bundled_plugins.browser import runtime as runtime_mod

class Store:
    def __init__(self, sessions):
        self.sessions = sessions or {}
    def load(self, sid):
        row = self.sessions.get(sid)
        if row is None:
            raise ValueError("invalid session id")
        return row

def one(case):
    try:
        state = Path(case["state"])
        state.mkdir(parents=True, exist_ok=True)
        set_enabled(state, "browser", bool(case.get("browser", True)))
        set_enabled(state, "desktop", bool(case.get("desktopPlugin", True)))
        tabs_api.clear_state(None)
        ctx = {
            "state_dir": state,
            "running": {"task"} if case.get("running") else set(),
            "lock": threading.RLock(),
            "desktop_token": "fixture" if case.get("desktop", True) else None,
            "project_dir": Path(case["project"]) if case.get("project") else state,
            "web_runs": Path(case["web"]) if case.get("web") else state,
            "store": Store(case.get("sessions")),
        }
        root = case.get("chromeRoot")
        runtime_value = case.get("runtime") or {"available": True, "browser": "Chrome", "reason": None}
        with patch.object(runtime_mod, "browser_runtime", return_value=runtime_value), patch.object(profiles_mod, "chrome_root", return_value=None if not root else Path(root)), patch.object(profiles_mod, "chrome_running", return_value=bool(case.get("chromeRunning"))):
            replies, page_id = [], ""
            for call in case["calls"]:
                parts = [page_id if part == "$page" else part for part in call["parts"]]
                result = dispatch_http(call["method"], parts, {}, call.get("data") or {}, ctx)
                if result is None:
                    replies.append({"status": None, "body": None})
                else:
                    status, body = result
                    replies.append({"status": status, "body": body})
                    if isinstance(body, dict) and isinstance(body.get("pageId"), str):
                        page_id = body["pageId"]
            return replies
    except Exception as exc:
        return [{"status": 599, "body": {"error": type(exc).__name__ + ": " + str(exc)}}]

sys.stdout.write(json.dumps([one(json.loads(line)) for line in sys.stdin.read().splitlines() if line.strip()]))
`;

describe("browser http matches Python refusals", () => {
  it("answers tabs, runtime, data and profiles", { timeout: 120_000 }, async () => {
    mkdirSync(project, { recursive: true }); mkdirSync(web, { recursive: true }); mkdirSync(outside, { recursive: true });
    writeTree(chrome, { "Local State": JSON.stringify(localState), "Default/Cookies": "cookie-bytes", "Default/Bookmarks": "marks", "Default/Cache/skip": "nope", "Profile 2/Preferences": "{}", "Not A Profile/Cookies": "ignore" });
    writeTree(broken, { "Default/Cookies": "x", "Default/Network": "not-a-directory" });
    const prepared = cases.map((item, index) => {
      const flags = item.flags ?? {};
      const tsState = join(base, `ts-${index}`);
      const pyState = join(base, `py-${index}`);
      mkdirSync(tsState, { recursive: true }); mkdirSync(pyState, { recursive: true });
      if (item.seed) { writeTree(tsState, item.seed); writeTree(pyState, item.seed); }
      return { item, flags, tsState, pyState };
    });
    for (const row of prepared) {
      const replies = await dispatchAll(row.tsState, row.flags, row.item.calls);
      assert.deepEqual(stable(replies.map(([status, body]) => ({ status, body }))), row.item.expect, JSON.stringify(row.item.calls));
      if (row.item.tree) assert.deepEqual(profileTree(row.tsState), row.item.tree);
      for (const rel of row.item.keep ?? []) assert.equal(present(row.tsState, rel), true, rel);
      for (const rel of row.item.drop ?? []) assert.equal(present(row.tsState, rel), false, rel);
    }
    if (skipPython) return;
    const payload = prepared.map((row) => JSON.stringify({
      state: row.pyState, browser: row.flags.browser !== false, desktopPlugin: row.flags.desktopPlugin !== false,
      desktop: row.flags.desktop !== false, running: row.flags.running === true, project: row.flags.project, web: row.flags.web,
      sessions: row.flags.sessions, chromeRoot: row.flags.chromeRoot ?? null, chromeRunning: row.flags.chromeRunning === true,
      runtime: RUNTIME, calls: row.item.calls,
    })).join("\n");
    const python = JSON.parse(runPython(ORACLE, payload)) as { status: number; body: Row }[][];
    prepared.forEach((row, index) => {
      assert.deepEqual(stable(python[index]), row.item.expect, "python " + JSON.stringify(row.item.calls[0]));
      if (row.item.tree) assert.deepEqual(profileTree(row.pyState), row.item.tree, "python tree");
      for (const rel of row.item.keep ?? []) assert.equal(present(row.pyState, rel), true, "python " + rel);
      for (const rel of row.item.drop ?? []) assert.equal(present(row.pyState, rel), false, "python " + rel);
    });
  });

  it("does not probe a disabled plugin, and the handoff answers every browser route itself", async () => {
    let probes = 0;
    const state = join(base, "gate");
    mkdirSync(state, { recursive: true });
    const http = createBrowserHttp({ stateDir: state, enabled: () => false, running: new Set(), desktop: true, chromeRoot: null, runtime: () => { probes += 1; return RUNTIME; } });
    assert.equal(http.owns("GET", RUNTIME_PATH), true);
    assert.equal(http.owns("GET", ["api", "browser", "other"]), false);
    assert.equal(await http.dispatch("GET", ["api", "browser", "other"], {}), null);
    assert.deepEqual(await http.dispatch("GET", RUNTIME_PATH, {}), [403, { error: "plugin disabled or dependency unavailable: browser", plugin: "browser" }]);
    assert.equal(probes, 0);
    const { createBrowserHandoff } = await import("../../../apps/server/src/browser-handoff.ts");
    const bare = createBrowserHandoff({ stateDir: state, enabled: () => true, running: new Set(), desktop: false, chromeRoot: null, runtime: () => RUNTIME });
    assert.equal(bare.owns("GET", DATA), true);
    assert.equal(bare.owns("GET", TABS), true);
    assert.equal(bare.owns("POST", [...TABS, "p", "action"]), true);
    const unfenced = await bare.dispatch("POST", TABS, { sessionId: SID });
    assert.ok(unfenced && unfenced[0] >= 400, "without the workspace fence a tab open is refused here: " + JSON.stringify(unfenced));
    assert.deepEqual(await bare.dispatch("POST", DATA, { operation: "all" }), [400, { error: "confirmation required to clear all browser data" }]);
    const hosted = createBrowserHandoff({ stateDir: join(base, "hosted"), enabled: () => true, running: new Set(["task"]), desktop: true, chromeRoot: null, runtime: () => RUNTIME, projectDir: project, webRuns: web });
    assert.equal(hosted.owns("POST", TABS), true);
    assert.deepEqual(await hosted.dispatch("POST", TABS, {}), [400, { error: "at most eight browser tabs may be open" }]);
    assert.deepEqual(await hosted.dispatch("POST", PROFILES, { profileId: "Default", confirmed: true }), [409, { error: "tasks_running" }]);
  });

  it("rejects an expired approval and keeps a mismatched one pending", async () => {
    let clock = 1_000;
    const state = join(base, "expiry");
    mkdirSync(state, { recursive: true });
    const owned = createBrowserHttp({ stateDir: state, enabled: () => true, running: new Set(), desktop: true, chromeRoot: null, projectDir: project, webRuns: web, now: () => clock, loadSession: (_dir, id) => { const row = tab().sessions?.[id]; if (!row) throw new Error("invalid session id"); return row; } });
    const openedTab = await owned.dispatch("POST", TABS, { sessionId: SID });
    assert.equal(openedTab?.[0], 200);
    const pageId = String(openedTab?.[1].pageId);
    const asked = await owned.dispatch("POST", [...TABS, pageId, "action"], { action: "refresh" });
    assert.equal(asked?.[1].approvalRequired, true);
    const approvalId = String(asked?.[1].approvalId);
    const subject = String(asked?.[1].subject);
    assert.deepEqual(await owned.dispatch("POST", [...TABS, pageId, "action"], { action: "refresh", approvalId: "other" }), [409, { error: "approval expired or action changed; request again" }]);
    clock = 1_000 + 120_001;
    assert.deepEqual(await owned.dispatch("POST", [...TABS, pageId, "action"], { action: "refresh", approvalId }), [409, { error: "approval expired or action changed; request again" }]);
    clock = 1_000;
    assert.deepEqual(await owned.dispatch("POST", [...TABS, pageId, "cancel"], { approvalId, subject }), [200, { ok: true, cancelled: true, status: "cancelled" }]);
  });
});
