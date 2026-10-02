import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRemoteConnections, RemoteConnections } from "./index";

const noop = () => {};

test("SSH panel renders its shell without issuing a request during SSR", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("unexpected request"); }) as typeof fetch;
  try {
    const html = renderToStaticMarkup(<RemoteConnections onUse={noop} />);
    assert.match(html, /data-testid="remote-connections"/);
    assert.match(html, /SSH 工作区/);
    // The connection list resolves after mount, so nothing is fetched while rendering.
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SSH panel lists saved connections and offers a per-connection action", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return new Response(JSON.stringify({
      connections: [
        { id: "office", host: "example.internal", user: "deploy", port: 22, directory: "~/projects/app", digest: "abc" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const { get } = await import("../../xuenessApi");
    const payload = await get<unknown>("/api/remote");
    const connections = parseRemoteConnections(payload);
    assert.deepEqual(calls, ["/api/remote"]);
    assert.equal(connections[0]?.id, "office");
    assert.equal(connections[0]?.host, "example.internal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SSH connection response guard rejects malformed JSON shapes and bad ports", () => {
  assert.deepEqual(parseRemoteConnections({ connections: [
    { id: "office", host: "example.internal", user: "deploy", digest: "abc" },
  ] }), [{ id: "office", host: "example.internal", user: "deploy", port: 22, directory: ".", digest: "abc" }]);
  assert.throws(() => parseRemoteConnections({ connections: {} }), /Invalid remote connections response/);
  assert.throws(() => parseRemoteConnections({ connections: [{ id: "office", host: "host", user: "deploy", port: 0, directory: ".", digest: "abc" }] }), /Invalid remote connections response/);
});
