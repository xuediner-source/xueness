/**
 * Browser tools on the TS front door: the agent runs browser_* through the TS
 * plugin's worker (a fake bridge here), `browser:false` hides them, a profile
 * held by the Python backend keeps an explicitly browser-enabled run with Python,
 * disabling or disposing stops the worker, and the front door hands the profile
 * to Python before tab actions, profile import and data clearing.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Row } from "@xueness/agent";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { currentWorker, managedProfile } from "@xueness/plugin-browser";
import { SessionStore } from "@xueness/sessions";
import { configuredAgentFeatures } from "../src/agent-features.ts";
import { createAgentService } from "../src/agent-service.ts";
import { createBrowserHandoff } from "../src/browser-handoff.ts";

const call = (id: string, name: string, args: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const policy = (permissionMode: string, disallowed: string[] = []): RunPolicy => ({ mode: "build", permissionMode, disallowed, selection: {}, request: {} }) as RunPolicy;
const POSIX = process.platform !== "win32";
const base = mkdtempSync(join(tmpdir(), "xue-browser-srv-"));
const saved = { node: process.env.XUENESS_DESKTOP_NODE, mode: process.env.FAKE_BRIDGE };
before(() => {
  // The worker command is `$XUENESS_DESKTOP_NODE bridge.mjs <profile>`; the wrapper runs the fake bridge instead.
  const wrapper = join(base, "fake-node");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "..", "..", "..", "plugins", "browser", "test", "fake-bridge.mjs")}" "$2"\n`);
  chmodSync(wrapper, 0o755);
  process.env.XUENESS_DESKTOP_NODE = wrapper; process.env.FAKE_BRIDGE = "ready";
});
after(() => {
  if (saved.node === undefined) delete process.env.XUENESS_DESKTOP_NODE; else process.env.XUENESS_DESKTOP_NODE = saved.node;
  if (saved.mode === undefined) delete process.env.FAKE_BRIDGE; else process.env.FAKE_BRIDGE = saved.mode;
  rmSync(base, { recursive: true, force: true });
});

function setup(name: string) {
  const root = realpathSync(mkdtempSync(join(base, `${name}-ws-`))), state = join(base, `${name}-state`); mkdirSync(state);
  const flags = new Set(["sessions", "providers", "files", "shell", "planning", "browser"]);
  return { root, state, flags, store: new SessionStore(state), enabled: (id: string): boolean => flags.has(id) };
}

describe("browser plugin in the agent service", { skip: !POSIX && "the fake worker wrapper is a POSIX shell script" }, () => {
  it("navigates and snapshots through the TS worker without the Python executor", async () => {
    const t = setup("run");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      const session = await t.store.new("Open the page and list its buttons", t.root);
      session.browser_enabled = true;
      assert.deepEqual(configuredAgentFeatures(session, { browser: true }, { stateDir: t.state, enabled: t.enabled, settings: {} }).filter((f) => f.startsWith("browser")), []);
      assert.equal(service.supports(session, { browser: true }), true, "browser runs stay on TS");
      for (const action of ["navigate", "inspect", "snapshot", "click", "fill", "screenshot"]) assert.ok(service.knownTools().includes("browser_" + action));
      let turn = 0; const seen: string[][] = [];
      await service.createRunner(session, { complete: async (_messages, tools) => {
        seen.push((tools ?? []).map((tool) => String(((tool as Row).function as Row | undefined)?.name ?? (tool as Row).name)));
        turn += 1;
        if (turn === 1) return { tool_calls: [call("c1", "browser_navigate", { url: "https://example.com/" })] };
        if (turn === 2) return { tool_calls: [call("c2", "browser_snapshot", {})] };
        return { content: "The page has one button: Go." };
      } }, policy("yolo")).run(session);
      assert.ok(seen[0]!.includes("browser_snapshot"), JSON.stringify(seen[0]));
      assert.equal(session.status, "completed", JSON.stringify(session.error ?? session.completion ?? null));
      const results = session.results as Record<string, Row>;
      assert.equal((results.c1!.data as Row | undefined)?.url ?? results.c1!.url, "https://example.com/");
      assert.match(JSON.stringify(results.c2), /button \\"Go\\" \[ref=e1\]/);
      assert.ok(currentWorker(t.state), "the worker persists across calls");
    } finally { await service.dispose(); }
    assert.equal(currentWorker(t.state), null, "disposing the service stops the worker");
  });

  it("asks for each exact action outside yolo, and browser:false refuses the tools", async () => {
    const t = setup("ask");
    // Without the sessions plugin nobody can answer in process, so the call pauses as approval_required.
    t.flags.delete("sessions");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      const session = await t.store.new("Open example.com", t.root);
      let turn = 0;
      await service.createRunner(session, { complete: async () => { turn += 1; return turn === 1 ? { tool_calls: [call("c1", "browser_navigate", { url: "https://example.com/" })] } : { content: "done" }; } }, policy("build")).run(session);
      const pending = JSON.stringify(session.pending_approvals ?? session.results ?? {});
      assert.match(pending, /\{\\"action\\":\\"navigate\\",\\"url\\":\\"https:\/\/example.com\/\\"\}/, "the approval subject is Python's sorted compact JSON");
      assert.equal(currentWorker(t.state), null, "nothing starts before approval");
      // browser:false puts every browser_* tool on the run's disallow list; as in Python the call is refused, nothing starts.
      const hidden = await t.store.new("No browser", t.root);
      const disallowed = service.knownTools().filter((name) => name.startsWith("browser_"));
      assert.equal(disallowed.length, 6);
      let step = 0;
      await service.createRunner(hidden, { complete: async () => { step += 1; return step === 1 ? { tool_calls: [call("d1", "browser_inspect", {})] } : { content: "ok" }; } }, policy("yolo", disallowed)).run(hidden);
      const refused = (hidden.results as Record<string, Row>).d1!;
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(currentWorker(t.state), null);
    } finally { await service.dispose(); }
  });

  it("stops the worker when the plugin is disabled", async () => {
    const t = setup("disable");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      const session = await t.store.new("inspect", t.root);
      let turn = 0;
      await service.createRunner(session, { complete: async () => { turn += 1; return turn === 1 ? { tool_calls: [call("c1", "browser_inspect", {})] } : { content: "done" }; } }, policy("yolo")).run(session);
      assert.ok(currentWorker(t.state));
      t.flags.delete("browser");
      await service.refresh();
      assert.equal(currentWorker(t.state), null);
    } finally { await service.dispose(); }
  });

  it("answers data, profiles, runtime and tabs itself, refusing tab opens without the workspace fence", async () => {
    const t = setup("handoff");
    t.flags.add("desktop");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    const running = new Set<string>();
    const handoff = createBrowserHandoff({ stateDir: t.state, enabled: t.enabled, running, desktop: true });
    try {
      assert.equal(handoff.owns("POST", ["api", "browser", "tabs", "p1", "action"]), true);
      assert.equal(handoff.owns("POST", ["api", "browser", "data"]), true);
      assert.equal(handoff.owns("GET", ["api", "browser", "data"]), true);
      assert.equal(handoff.owns("GET", ["api", "browser", "runtime"]), true);
      assert.equal(handoff.owns("POST", ["api", "browser", "profiles"]), true);
      for (const [method, parts] of [["GET", ["api", "browser", "tabs"]], ["POST", ["api", "browser", "tabs"]], ["POST", ["api", "browser", "tabs", "p1", "close"]]] as const) assert.equal(handoff.owns(method, parts), true, parts.join("/"));
      const session = await t.store.new("inspect", t.root);
      let turn = 0;
      await service.createRunner(session, { complete: async () => { turn += 1; return turn === 1 ? { tool_calls: [call("c1", "browser_inspect", {})] } : { content: "done" }; } }, policy("yolo")).run(session);
      assert.ok(currentWorker(t.state));
      const opened = await handoff.dispatch("POST", ["api", "browser", "tabs"], { sessionId: session.id });
      assert.ok(opened && opened[0] >= 400, JSON.stringify(opened));
      const action = await handoff.dispatch("POST", ["api", "browser", "tabs", "p1", "action"], { action: "inspect" });
      assert.ok(action && action[0] >= 400, "an unknown tab is answered here, never released: " + JSON.stringify(action));
      running.add("s1");
      assert.deepEqual(await handoff.dispatch("POST", ["api", "browser", "data"], { operation: "cache" }), [409, { error: "stop running tasks before clearing browser data" }]);
      assert.deepEqual(await handoff.dispatch("POST", ["api", "browser", "data"], { operation: "all", confirmed: true }), [409, { error: "stop running tasks before clearing browser data" }]);
      assert.deepEqual(await handoff.dispatch("POST", ["api", "browser", "data"], { operation: "all" }), [400, { error: "confirmation required to clear all browser data" }]);
      assert.deepEqual(await handoff.dispatch("POST", ["api", "browser", "profiles"], { profileId: "Default", confirmed: true }), [409, { error: "tasks_running" }]);
      assert.deepEqual(await handoff.dispatch("POST", ["api", "browser", "profiles"], { profileId: "Default" }), [400, { error: "confirmation_required" }]);
      running.clear();
      assert.deepEqual(await handoff.dispatch("POST", ["api", "browser", "data"], { operation: "cache" }), [200, { ok: true }]);
    } finally { await service.dispose(); }
  });
});
