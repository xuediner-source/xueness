import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { V4_METHODS, V4_WIRE_PROTOCOL_VERSION } from "@xueness/contracts";
import { AppProtocolError } from "../src/app-protocol-types.ts";
import { createV4Facade, V4_PROTOCOL_NAME, V4_TO_NATIVE_ROUTES } from "../src/v4-facade.ts";

function facade(native: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}) {
  const notes: unknown[] = [];
  return {
    notes,
    api: createV4Facade({
      port: { workspaceIdentity: "ws-1" },
      connectionId: "conn-1",
      xuenessVersion: "0.2.1",
      nativeMethods: () => native as never,
      notify: async (method, params) => { notes.push([method, params]); },
      serverTime: () => 1_700_000_000_000,
    }),
  };
}

describe("createV4Facade (F11.01)", () => {
  it("negotiates V4 on initialize with protocolVersion 3 and refuses a second initialize", () => {
    const { api } = facade({ "connection/flow": async () => ({ ok: true }) });
    const hello = api.acceptClientHello({ kind: "clientHello", protocolVersion: 3, clientId: "client-1", clientKind: "desktop", appVersion: "0.2.1", capabilities: {} });
    assert.equal(hello.protocolVersion, V4_WIRE_PROTOCOL_VERSION);
    assert.equal(hello.connectionId, "conn-1");
    const init = api.initialize({ protocolVersion: V4_WIRE_PROTOCOL_VERSION });
    assert.equal(init.protocolName, V4_PROTOCOL_NAME);
    assert.equal(init.protocolVersion, 3);
    assert.equal(init.clientHelloAccepted, true);
    assert.ok((init.routableMethods as string[]).includes(V4_METHODS.connectionFlow));
    assert.throws(() => api.initialize({ protocolVersion: 3 }), (err: unknown) => err instanceof AppProtocolError);
  });

  it("dispatches curated v4 routes to native handlers and refuses unknown/mixed-family methods", async () => {
    const calls: unknown[] = [];
    const { api } = facade({
      "connection/flow": async (params) => { calls.push(params); return { routed: true }; },
    });
    api.initialize({ protocolVersion: 3 });
    const result = await api.dispatch(V4_METHODS.connectionFlow, { ping: 1 }, false);
    assert.deepEqual(result, { routed: true });
    assert.deepEqual(calls, [{ ping: 1 }]);
    await assert.rejects(() => api.dispatch("conversation/subscribe", {}, false), AppProtocolError);
    await assert.rejects(() => api.dispatch("v4/not-a-real-route", {}, false), AppProtocolError);
  });

  it("refuses V4 methods before initialize and refuses legacy-family connections", async () => {
    const { api } = facade({ "connection/flow": async () => ({}) });
    await assert.rejects(() => api.dispatch(V4_METHODS.connectionFlow, {}, false), AppProtocolError);
    api.initialize({ protocolVersion: 3 });
    await assert.rejects(() => api.dispatch(V4_METHODS.connectionFlow, {}, true), AppProtocolError);
  });

  it("keeps the curated route map non-empty and stable", () => {
    assert.ok(Object.keys(V4_TO_NATIVE_ROUTES).length >= 5);
    assert.equal(V4_TO_NATIVE_ROUTES[V4_METHODS.connectionFlow], "connection/flow");
  });
});
