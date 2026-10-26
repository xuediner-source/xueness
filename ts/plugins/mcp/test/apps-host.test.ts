/** F06.06: MCP Apps UI host — capability, connection generations, wait, ui:// open, bridge HTTP. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appsClientCapabilities, appsConnect, appsDisconnect, appsEnabled, appsReady, appsSnapshot, appsToolsVisible,
  appsToolContext, appsResponseFor, isAppsUiUri, openAppsResource, resetAppsState, validateAppsConnect,
  waitForAppConnection, type AppsConnectParams,
} from "../src/apps-protocol.ts";
import { createAppsHttp } from "../src/apps-http.ts";
import type { Row } from "../src/names.ts";

const sid = "cd".repeat(16);
let stateDir: string;

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "mcp-apps-")); });
afterEach(() => { resetAppsState(stateDir); rmSync(stateDir, { recursive: true, force: true }); });

const params = (extra: Partial<AppsConnectParams> = {}): AppsConnectParams => ({
  appId: "notes", appName: "Notes", iframeUrl: "https://apps.example.com/notes", resource: { uri: "ui://notes/main", iframeUrl: "https://apps.example.com/notes", version: "2" }, tools: ["note.save", "note.open"], ...extra,
});

const connected = (connectionId = "c1", generation = 1): { connectionId: string; generation: number } => ({ connectionId, generation });

describe("apps capability and validation", () => {
  it("declares the apps client capability only for opted-in servers", () => {
    assert.deepEqual(appsClientCapabilities({ apps: true }), { apps: {} });
    assert.deepEqual(appsClientCapabilities({}), {});
    assert.equal(appsEnabled({ apps: true }), true);
    assert.equal(appsEnabled({ apps: "yes" }), false);
  });

  it("accepts only bounded ui:// uris and validated connect params", () => {
    assert.equal(isAppsUiUri("ui://notes/main"), true);
    assert.equal(isAppsUiUri("https://notes"), false);
    assert.equal(isAppsUiUri("ui://"), false);
    assert.equal(isAppsUiUri("ui://a b"), false);
    const [ok] = validateAppsConnect({ appId: "notes", iframeUrl: "https://apps.example.com", resource: { uri: "ui://notes" } });
    assert.equal(ok?.appId, "notes");
    assert.equal(validateAppsConnect({ appId: "bad id!" })[1], "invalid_app_id");
    assert.equal(validateAppsConnect({ appId: "x", iframeUrl: "http://evil.example.com" })[1], "invalid_iframe_url");
    assert.equal(validateAppsConnect({ appId: "x", iframeUrl: "http://localhost:5173/app" })[1], null);
    assert.equal(validateAppsConnect({ appId: "x", resource: { uri: "https://nope" } })[1], "invalid_resource_uri");
    assert.equal(validateAppsConnect({ appId: "x", tools: ["a", "a"] })[1], "invalid_tools");
  });
});

describe("connection lifecycle and generation rechecks", () => {
  it("registers, waits for readiness, and exposes app tools only while connected", async () => {
    appsConnect(stateDir, sid, "srv", "c1", params());
    const guard = connected();
    assert.equal(appsSnapshot(stateDir, sid, "srv")?.status, "connecting");
    assert.deepEqual(appsToolsVisible(appsSnapshot(stateDir, sid, "srv")), []);
    const waiting = waitForAppConnection(stateDir, sid, "srv", guard, 1000);
    await Promise.resolve();
    assert.equal(appsReady(stateDir, sid, "srv", guard).ok, true);
    const result = await waiting;
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(appsToolsVisible(result.snapshot), ["note.save", "note.open"]);
  });

  it("a reconnect advances the generation and refuses the previous app frame", async () => {
    const first = appsConnect(stateDir, sid, "srv", "c1", params());
    assert.equal(appsReady(stateDir, sid, "srv", connected("c1", first.generation)).ok, true);
    const second = appsConnect(stateDir, sid, "srv", "c2", params({ tools: ["fresh.tool"] }));
    assert.equal(second.generation, first.generation + 1);
    const stale = appsReady(stateDir, sid, "srv", connected("c1", first.generation));
    assert.deepEqual(stale, { ok: false, reason: "stale" });
    assert.equal(appsReady(stateDir, sid, "srv", connected("c2", second.generation)).ok, true);
    assert.equal(openAppsResource(stateDir, sid, "ui://notes/main", connected("c1", first.generation)).ok, false);
  });

  it("waitForAppConnection re-validates the lease after waking", async () => {
    appsConnect(stateDir, sid, "srv", "c1", params());
    const waiting = waitForAppConnection(stateDir, sid, "srv", connected(), 2000);
    await Promise.resolve();
    appsConnect(stateDir, sid, "srv", "c2", params());
    assert.deepEqual(await waiting, { ok: false, reason: "stale" });
  });

  it("times out, reports closed connections, and ignores disconnects from old connections", async () => {
    assert.deepEqual(await waitForAppConnection(stateDir, sid, "srv", connected(), 10), { ok: false, reason: "no_connection" });
    const entry = appsConnect(stateDir, sid, "srv", "c1", params());
    appsDisconnect(stateDir, sid, "srv", "c1");
    assert.deepEqual(await waitForAppConnection(stateDir, sid, "srv", connected(), 10), { ok: false, reason: "closed" });
    appsConnect(stateDir, sid, "srv", "c2", params());
    appsDisconnect(stateDir, sid, "srv", "c1");
    assert.equal(appsSnapshot(stateDir, sid, "srv")?.connectionId, "c2");
    assert.notEqual(appsSnapshot(stateDir, sid, "srv")?.status, "closed");
    void entry;
  });

  it("opens the caller's own ui:// resource when another app publishes the same uri", () => {
    appsConnect(stateDir, sid, "srv", "c1", params());
    appsConnect(stateDir, sid, "other", "c2", params());
    appsReady(stateDir, sid, "other", connected("c2", 1));
    // `c1` belongs to another server: its generation is current, but only for itself.
    assert.equal(openAppsResource(stateDir, sid, "ui://notes/main", connected("c1", 1)).ok, false);
    appsReady(stateDir, sid, "srv", connected("c1", 1));
    const own = openAppsResource(stateDir, sid, "ui://notes/main", connected("c1", 1));
    assert.equal(own.ok, true);
    if (own.ok) assert.equal((own.manifest as Row).appId, "notes");
    assert.deepEqual(openAppsResource(stateDir, sid, "ui://missing/main", connected("c1", 1)), { ok: false, reason: "no_connection" });
  });

  it("opens ui:// resources and exchanges tool context only under the live generation", async () => {
    const entry = appsConnect(stateDir, sid, "srv", "c1", params());
    assert.deepEqual(openAppsResource(stateDir, sid, "ui://notes/main", connected()), { ok: false, reason: "not_connected" });
    assert.equal(openAppsResource(stateDir, sid, "https://notes/main", connected()).ok, false);
    appsReady(stateDir, sid, "srv", connected());
    const opened = openAppsResource(stateDir, sid, "ui://notes/main", connected());
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal((opened.manifest as Row).iframeUrl, "https://apps.example.com/notes");
    const context = appsToolContext(stateDir, sid, "srv", connected());
    assert.equal(context.ok, true);
    if (context.ok) assert.deepEqual((context.context as Row).ui, { sessionId: sid, serverId: "srv", generation: entry.generation, connectionId: "c1" });
    assert.equal(appsToolContext(stateDir, sid, "srv", connected("c1", 99)).ok, false);
  });
});

describe("apps server request handling", () => {
  const server = (extra: Row = {}): Row => ({ id: "srv", apps: true, _state_dir: stateDir, _elicitation_session: { id: sid }, ...extra });

  it("accepts apps/connect and apps/disconnect for an attended session", async () => {
    const answer = await appsResponseFor(server(), { id: 1, method: "apps/connect", params: { appId: "notes", tools: ["note.save"] } }, "c1");
    assert.equal((answer.result as Row).accepted, true);
    assert.equal(typeof (answer.result as Row).generation, "number");
    assert.deepEqual(await appsResponseFor(server(), { id: 2, method: "apps/disconnect" }, "c1"), { jsonrpc: "2.0", id: 2, result: { accepted: true } });
  });

  it("refuses unattended sessions, disabled hosts, and unknown methods", async () => {
    const unattended = await appsResponseFor(server({ _elicitation_session: { id: "sub-1" } }), { id: 1, method: "apps/connect", params: { appId: "notes" } }, "c1");
    assert.deepEqual((unattended.result as Row), { accepted: false, reason: "unattended" });
    const disabled = await appsResponseFor(server({ apps: false }), { id: 2, method: "apps/connect", params: { appId: "notes" } }, "c1");
    assert.equal((disabled.error as Row).code, -32601);
    const unknown = await appsResponseFor(server(), { id: 3, method: "sampling/createMessage" }, "c1");
    assert.equal((unknown.error as Row).code, -32601);
    const invalid = await appsResponseFor(server(), { id: 4, method: "apps/connect", params: { appId: "bad id!" } }, "c1");
    assert.equal((invalid.result as Row).accepted, false);
  });
});

describe("apps bridge HTTP surface", () => {
  let api: ReturnType<typeof createAppsHttp>;
  beforeEach(() => { api = createAppsHttp({ stateDir, enabled: () => true }); });
  const parts = ["api", "sessions", sid, "mcp-apps"];
  const connectionOf = (reply: unknown): { status?: string } | undefined => (reply as [number, { connection?: { status?: string } }])[1]?.connection;

  it("owns only the session mcp-apps path and validates requests", async () => {
    assert.equal(api.owns("GET", ["api", "sessions", sid, "mcp-apps"]), true);
    assert.equal(api.owns("GET", ["api", "sessions", sid, "elicitation"]), false);
    assert.equal(api.owns("GET", ["api", "sessions", sid, "mcp-apps", "extra"]), false);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", "nope", "mcp-apps"], { server: ["srv"] }, null), [404, { error: "session not found" }]);
    assert.deepEqual(await api.dispatch("GET", parts, {}, null), [400, { error: "invalid apps server" }]);
    assert.deepEqual(await api.dispatch("GET", parts, { server: ["srv"], wait: ["x"] }, null), [400, { error: "invalid apps wait" }]);
    assert.deepEqual(await api.dispatch("PUT", parts, { server: ["srv"] }, {}), [405, { error: "method not allowed" }]);
    assert.deepEqual(await api.dispatch("POST", parts, {}, { type: "wat", server: "srv" }), [400, { error: "invalid apps bridge request" }]);
    const off = createAppsHttp({ stateDir, enabled: (id) => id !== "mcp" });
    assert.deepEqual(await off.dispatch("GET", parts, { server: ["srv"] }, null), [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }]);
    // Ownership gates every verb: a disabled plugin accepts no bridge state change either.
    assert.deepEqual(await off.dispatch("POST", parts, {}, { type: "app_closed", server: "srv", connectionId: "c1" }), [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }]);
    assert.deepEqual(await off.dispatch("POST", parts, {}, { type: "app_ready", server: "srv", connectionId: "c1", generation: 1 }), [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }]);
    const noSessions = createAppsHttp({ stateDir, enabled: (id) => id !== "sessions" });
    assert.deepEqual(await noSessions.dispatch("POST", parts, {}, { type: "tool_context", server: "srv", connectionId: "c1", generation: 1 }), [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }]);
  });

  it("serves snapshots, resolves ready/open/tool_context, and refuses stale generations", async () => {
    const entry = appsConnect(stateDir, sid, "srv", "c1", params());
    const guard = { connectionId: "c1", generation: entry.generation };
    const found = await api.dispatch("GET", parts, { server: ["srv"] }, null);
    assert.equal(connectionOf(found)?.status, "connecting");
    assert.deepEqual(await api.dispatch("POST", parts, {}, { type: "app_ready", server: "srv", ...guard }), [200, { ok: true, connection: appsSnapshot(stateDir, sid, "srv") }]);
    assert.deepEqual(await api.dispatch("POST", parts, {}, { type: "app_ready", server: "srv", connectionId: "c1", generation: 99 }), [409, { error: "app connection is stale", reason: "stale" }]);
    const opened = await api.dispatch("POST", parts, {}, { type: "open_ui", server: "srv", uri: "ui://notes/main", ...guard });
    assert.equal((opened as [number, Row])[0], 200);
    assert.deepEqual(await api.dispatch("POST", parts, {}, { type: "open_ui", server: "srv", uri: "https://notes", ...guard }), [400, { error: "invalid apps ui uri" }]);
    const context = await api.dispatch("POST", parts, {}, { type: "tool_context", server: "srv", ...guard });
    assert.equal((context as [number, { context?: { ui?: { sessionId?: string } } }])[1]?.context?.ui?.sessionId, sid);
    assert.deepEqual(await api.dispatch("POST", parts, {}, { type: "app_closed", server: "srv", connectionId: "c1" }), [200, { ok: true }]);
  });

  it("long-waits until the app frame reports ready", async () => {
    const entry = appsConnect(stateDir, sid, "srv", "c1", params());
    const waiting = api.dispatch("GET", parts, { server: ["srv"], wait: ["500"] }, null);
    await Promise.resolve();
    appsReady(stateDir, sid, "srv", { connectionId: "c1", generation: entry.generation });
    const result = await waiting;
    assert.equal(connectionOf(result)?.status, "connected");
  });
});
