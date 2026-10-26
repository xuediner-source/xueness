/** F06.05: concurrent elicitation queue, tool-call attribution, cancellation, session recovery. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cancelServerElicitations, deleteElicitationPublic, pendingPublic, resetElicitationState, resolveElicitation, responseFor } from "../src/elicitation-protocol.ts";
import { createElicitationHttp } from "../src/elicitation-http.ts";
import type { Row } from "../src/names.ts";

const sid = "ab".repeat(16);
const emptySchema = { type: "object", properties: {}, required: [], additionalProperties: false };
const nameSchema = { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"], additionalProperties: false };
let stateDir: string;

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "mcp-elicit-")); });
afterEach(() => { resetElicitationState(stateDir); rmSync(stateDir, { recursive: true, force: true }); });

function server(extra: Row = {}): Row {
  return { id: "srv", name: "Srv", elicitation: true, _state_dir: stateDir, _elicitation_session: { id: sid }, ...extra };
}

function create(id: number, message = "need input", requestedSchema: Row = emptySchema, meta?: Row): Row {
  return { id, method: "elicitation/create", params: { message, requestedSchema, ...(meta ? { _meta: meta } : {}) } };
}

const pendingRow = (): Row | null => pendingPublic(sid, stateDir);

describe("concurrent elicitation queue", () => {
  it("parks concurrent requests per session and resolves each by rpc id", async () => {
    const first = responseFor(server(), create(1));
    const second = responseFor(server(), create(2));
    assert.equal(pendingRow()?.id, 1);
    assert.equal(resolveElicitation(sid, 2, "accept", {}, stateDir), "ok");
    assert.equal(pendingRow()?.id, 1, "the head stays published until it resolves");
    assert.equal(resolveElicitation(sid, 1, "decline", null, stateDir), "ok");
    assert.deepEqual(await first, { jsonrpc: "2.0", id: 1, result: { action: "decline" } });
    assert.deepEqual(await second, { jsonrpc: "2.0", id: 2, result: { action: "accept", content: {} } });
    assert.equal(pendingRow(), null);
  });

  it("answers a mismatched id with 409 semantics and keeps the request parked", async () => {
    const answer = responseFor(server(), create(7));
    assert.equal(resolveElicitation(sid, 999, "decline", null, stateDir), "mismatch");
    assert.equal(pendingRow()?.id, 7);
    assert.equal(resolveElicitation(sid, 7, "cancel", null, stateDir), "ok");
    assert.deepEqual(await answer, { jsonrpc: "2.0", id: 7, result: { action: "cancel" } });
  });

  it("declines beyond the bounded queue", async () => {
    const parked = [1, 2, 3, 4].map((id) => responseFor(server(), create(id)));
    const overflow = await responseFor(server(), create(5));
    assert.deepEqual(overflow, { jsonrpc: "2.0", id: 5, result: { action: "decline" } });
    for (let id = 1; id <= 4; id += 1) assert.equal(resolveElicitation(sid, id, "cancel", null, stateDir), "ok");
    await Promise.all(parked);
  });

  it("accept returns cleaned content; decline and cancel stay standard results", async () => {
    const accept = responseFor(server(), create(11, "name?", nameSchema));
    assert.equal(resolveElicitation(sid, 11, "accept", { name: "ok" }, stateDir), "ok");
    assert.deepEqual((await accept).result, { action: "accept", content: { name: "ok" } });
    const bad = responseFor(server(), create(12, "name?", nameSchema));
    assert.deepEqual(resolveElicitation(sid, 12, "accept", { name: "" }, stateDir), ["invalid", "length", "name"]);
    assert.equal(resolveElicitation(sid, 12, "decline", null, stateDir), "ok");
    assert.deepEqual((await bad).result, { action: "decline" });
  });
});

describe("tool call attribution", () => {
  it("attributes the parked request to the in-flight tool call via _meta.relatedRequestId", async () => {
    const context = { toolCallOf: (rid: unknown) => rid === 42 ? "search_docs" : null };
    const answer = responseFor(server(), create(21, "hi", emptySchema, { relatedRequestId: 42 }), context);
    assert.equal(pendingRow()?.toolCall, "search_docs");
    assert.equal(resolveElicitation(sid, 21, "cancel", null, stateDir), "ok");
    await answer;
  });

  it("an unknown or absent related request leaves toolCall null", async () => {
    const context = { toolCallOf: () => null };
    const answer = responseFor(server(), create(22, "hi", emptySchema, { relatedRequestId: 43 }), context);
    assert.equal(pendingRow()?.toolCall, null);
    assert.equal(resolveElicitation(sid, 22, "cancel", null, stateDir), "ok");
    await answer;
  });
});

describe("cancellation and session recovery", () => {
  it("a dropped connection cancels only its own server's parked requests", async () => {
    const mine = responseFor(server(), create(31));
    const other = responseFor(server({ id: "other" }), create(32));
    assert.equal(cancelServerElicitations(stateDir, sid, "srv"), 1);
    assert.deepEqual(await mine, { jsonrpc: "2.0", id: 31, result: { action: "cancel" } });
    assert.equal(pendingRow()?.id, 32);
    assert.equal(resolveElicitation(sid, 32, "decline", null, stateDir), "ok");
    await other;
  });

  it("recovers a published request from disk after a host restart", () => {
    const row = { id: 51, serverId: "srv", serverName: "Srv", message: "still open", requestedSchema: emptySchema, toolCall: null, expiresAt: Math.trunc(Date.now() / 1000 + 60) };
    const directory = join(stateDir, "mcp-elicitations");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${sid}.json`), JSON.stringify(row), { encoding: "utf8" });
    assert.equal(pendingRow()?.message, "still open");
    assert.equal(pendingRow()?.toolCall, null);
    deleteElicitationPublic(stateDir, sid);
    assert.equal(pendingRow(), null);
  });

  it("an expired published row is not recovered", () => {
    const directory = join(stateDir, "mcp-elicitations");
    mkdirSync(directory, { recursive: true });
    const row = { id: 52, serverId: "srv", serverName: "Srv", message: "stale", requestedSchema: emptySchema, expiresAt: Math.trunc(Date.now() / 1000 - 5) };
    writeFileSync(join(directory, `${sid}.json`), JSON.stringify(row), { encoding: "utf8" });
    assert.equal(pendingRow(), null);
  });

  it("resetElicitationState cancels every parked request for the state dir", async () => {
    const answer = responseFor(server(), create(61));
    resetElicitationState(stateDir);
    assert.deepEqual(await answer, { jsonrpc: "2.0", id: 61, result: { action: "cancel" } });
    assert.equal(pendingRow(), null);
  });
});

describe("elicitation HTTP surface with the queue", () => {
  it("serves the head, resolves by id, and refuses mismatches", async () => {
    const api = createElicitationHttp({ stateDir, enabled: () => true });
    const answer = responseFor(server(), create(71));
    const found = await api.dispatch("GET", ["api", "sessions", sid, "elicitation"], {}, null);
    const [, head] = found as [number, Row];
    assert.equal((head.pending as Row | null)?.id, 71);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", sid, "elicitation"], {}, { id: 71, action: "decline" }), [200, { ok: true, action: "decline" }]);
    await answer;
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", sid, "elicitation"], {}, { id: 71, action: "decline" }), [409, { error: "no elicitation is waiting" }]);
  });
});
