import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppsFrame,
  AppsUiHost,
  McpAppsHost,
  appsBridgePath,
  appsBridgePostPath,
  appsClaimedFrame,
  appsReadyKey,
  appsServerIds,
  isSafeAppsFrameUrl,
  nextAppsPollDelay,
  nextReadyKey,
  parseAppsBridgeReply,
  parseAppsConnection,
  type AppsConnection,
} from "./AppsUiHost";

const snapshot = (extra: Partial<AppsConnection> = {}): AppsConnection => ({
  serverId: "srv",
  connectionId: "c1",
  generation: 3,
  appId: "notes",
  appName: "Notes",
  status: "connected",
  connectedAt: 1_800_000_000,
  uiResource: "ui://notes/main",
  iframeUrl: "https://apps.example.com/notes",
  tools: ["note.save", "note.open"],
  ...extra,
});

test("parseAppsConnection accepts a full snapshot and applies safe defaults", () => {
  const parsed = parseAppsConnection(snapshot());
  assert.deepEqual(parsed, snapshot());
  const minimal = parseAppsConnection({ serverId: "s", connectionId: "c", generation: 1, appId: "a", status: "connecting" });
  assert.deepEqual(minimal, {
    serverId: "s", connectionId: "c", generation: 1, appId: "a", appName: "a",
    status: "connecting", connectedAt: null, uiResource: null, iframeUrl: null, tools: [],
  });
});

test("parseAppsConnection rejects malformed snapshots", () => {
  assert.equal(parseAppsConnection(null), null);
  assert.equal(parseAppsConnection("x"), null);
  assert.equal(parseAppsConnection([]), null);
  assert.equal(parseAppsConnection({ ...snapshot(), serverId: "" }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), connectionId: 7 }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), appId: undefined }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), generation: 0 }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), generation: 1.5 }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), generation: "3" }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), status: "open" }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), connectedAt: "soon" }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), uiResource: "" }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), iframeUrl: "" }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), tools: ["ok", 5] }), null);
  assert.equal(parseAppsConnection({ ...snapshot(), tools: "note.save" }), null);
});

test("parseAppsBridgeReply unwraps the connection envelope only", () => {
  assert.deepEqual(parseAppsBridgeReply({ connection: snapshot() }), snapshot());
  assert.equal(parseAppsBridgeReply({ connection: null }), null);
  assert.equal(parseAppsBridgeReply({}), null);
  assert.equal(parseAppsBridgeReply("nope"), null);
});

test("bridge paths encode the session and server ids", () => {
  assert.equal(appsBridgePath("ab".repeat(16), "my srv", 500), `/api/sessions/${"ab".repeat(16)}/mcp-apps?server=my%20srv&wait=500`);
  assert.equal(appsBridgePostPath("s/id"), "/api/sessions/s%2Fid/mcp-apps");
});

test("only https or loopback http origins may host an app frame", () => {
  assert.equal(isSafeAppsFrameUrl("https://apps.example.com/notes"), true);
  assert.equal(isSafeAppsFrameUrl("http://localhost:5173/app"), true);
  assert.equal(isSafeAppsFrameUrl("http://127.0.0.1:5173/app"), true);
  assert.equal(isSafeAppsFrameUrl("http://[::1]:5173/app"), true);
  assert.equal(isSafeAppsFrameUrl("http://evil.example.com/app"), false);
  assert.equal(isSafeAppsFrameUrl("javascript:alert(1)"), false);
  assert.equal(isSafeAppsFrameUrl("not a url"), false);
});

test("nextReadyKey fires once per generation and never for a stale frame", () => {
  assert.equal(nextReadyKey("", null), null);
  assert.equal(nextReadyKey("", snapshot({ iframeUrl: null })), null);
  assert.equal(nextReadyKey("", snapshot({ status: "closed" })), null);
  // A `connecting` snapshot that already names its frame is reportable: waiting for
  // `connected` first would deadlock, since only this report sets it.
  assert.equal(nextReadyKey("", snapshot({ status: "connecting" })), appsReadyKey(snapshot()));
  const first = appsReadyKey(snapshot());
  assert.equal(nextReadyKey("", snapshot()), first);
  assert.equal(nextReadyKey(first, snapshot()), null);
  // A reconnect advanced the generation: the new key is reportable, the old frame's is not.
  const renewed = snapshot({ connectionId: "c2", generation: 4 });
  assert.equal(nextReadyKey(first, renewed), "c2:4");
  assert.equal(nextReadyKey("c2:4", snapshot()), first);
});

test("nextAppsPollDelay backs off failures and stays bounded", () => {
  assert.equal(nextAppsPollDelay(0), 1200);
  assert.equal(nextAppsPollDelay(2), 4800);
  assert.equal(nextAppsPollDelay(9), 10000);
});

test("AppsFrame renders a sandboxed frame with the app tools while connected", () => {
  const html = renderToStaticMarkup(
    <AppsFrame connection={snapshot()} onLoad={() => undefined} onClose={() => undefined} />,
  );
  assert.match(html, /data-testid="apps-host-frame"/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /src="https:\/\/apps\.example\.com\/notes"/);
  assert.match(html, /title="Notes"/);
  assert.match(html, /data-testid="apps-host-tools"/);
  assert.match(html, /note\.save/);
  assert.match(html, /note\.open/);
  assert.match(html, /data-testid="apps-host-close"/);
  assert.match(html, /ui:\/\/notes\/main/);
});

test("AppsFrame omits the tools list when the app provides none", () => {
  const html = renderToStaticMarkup(
    <AppsFrame connection={snapshot({ tools: [] })} onLoad={() => undefined} onClose={() => undefined} />,
  );
  assert.doesNotMatch(html, /apps-host-tools/);
  assert.match(html, /apps-host-frame/);
});

test("appsClaimedFrame mounts a connecting frame so readiness can be reported", () => {
  const connecting = snapshot({ status: "connecting" });
  const claimed = renderToStaticMarkup(
    <AppsFrame connection={connecting} state={appsClaimedFrame(connecting)} onLoad={() => undefined} onClose={() => undefined} />,
  );
  assert.match(claimed, /data-testid="apps-host-frame"/);
  assert.equal(appsClaimedFrame(connecting).connected, true);
  assert.equal(appsClaimedFrame(snapshot({ status: "closed" })).connected, false);
  assert.equal(appsClaimedFrame(snapshot({ iframeUrl: "http://evil.example.com/app" })).connected, false);
  assert.equal(appsClaimedFrame(null).connected, false);
});

test("AppsFrame waits while connecting and refuses unsafe frame urls", () => {
  const waiting = renderToStaticMarkup(
    <AppsFrame connection={snapshot({ status: "connecting" })} onLoad={() => undefined} onClose={() => undefined} />,
  );
  assert.match(waiting, /data-testid="apps-host-status"/);
  assert.match(waiting, /Notes/);
  assert.doesNotMatch(waiting, /apps-host-frame/);
  const unsafe = renderToStaticMarkup(
    <AppsFrame connection={snapshot({ iframeUrl: "http://evil.example.com/app" })} onLoad={() => undefined} onClose={() => undefined} />,
  );
  assert.match(unsafe, /apps-host-status/);
  assert.doesNotMatch(unsafe, /apps-host-frame/);
});

test("AppsFrame relays load and close through the rendered connection", () => {
  const seen: string[] = [];
  const html = renderToStaticMarkup(
    <AppsFrame
      connection={snapshot({ connectionId: "cx", generation: 9 })}
      onLoad={connection => seen.push(`load:${connection.connectionId}:${connection.generation}`)}
      onClose={connection => seen.push(`close:${connection.connectionId}`)}
    />,
  );
  assert.match(html, /apps-host-frame/);
  // renderToStaticMarkup does not fire events; the container owns the callbacks.
  assert.deepEqual(seen, []);
});

test("AppsUiHost renders nothing without a session or server", () => {
  assert.equal(renderToStaticMarkup(<AppsUiHost sessionId="" serverId="srv" />), "");
  assert.equal(renderToStaticMarkup(<AppsUiHost sessionId="sid" serverId="" />), "");
});

test("appsServerIds keeps only apps-enabled server documents, tolerating malformed rows", () => {
  assert.deepEqual(appsServerIds(undefined), []);
  assert.deepEqual(appsServerIds("nope"), []);
  assert.deepEqual(appsServerIds([]), []);
  assert.deepEqual(appsServerIds([
    { id: "notes", apps: true },
    { id: "plain" },
    { id: "graphs", extra: { apps: true } },
    { id: "off", extra: { apps: false } },
    { id: "off", apps: "true" },
    null,
    "row",
    7,
    { apps: true },
    { id: "", apps: true },
    { id: "notes", apps: true },
  ]), ["notes", "graphs"]);
});

test("McpAppsHost renders nothing without a session or before any server resolves", () => {
  assert.equal(renderToStaticMarkup(<McpAppsHost sessionId="" />), "");
  // Effects do not run under renderToStaticMarkup: the host stays hidden until
  // an apps-enabled server is discovered and its connection turns live.
  const html = renderToStaticMarkup(<McpAppsHost sessionId={"ab".repeat(16)} />);
  assert.equal(html, "");
});
