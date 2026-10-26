import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { uuid4Hex } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { createForkApi } from "../src/forking.ts";
import { createRewindApi } from "../src/rewind-api.ts";
import { createSessionRuntimeEventLog } from "../src/runtime-event-log.ts";
import { applyCanonicalIntent, LineageSidecar, recordLineageRow } from "../src/lineage.ts";
import { messageRevision } from "../src/journal-http.ts";
type Row = Record<string, any>;

const sid = "d".repeat(32);
const commandId = (n: number) => `c_${Date.now()}_${"0".repeat(31)}${n}`;
const call = (id = "read-one") => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] });
const source = (): Row => ({ id: sid, task: "First task", root: "/fixture", status: "paused", messages: [{ role: "system", content: "old system" }, { role: "user", content: "First\u0085 closed 中 turn" }, call(), { role: "tool", tool_call_id: "read-one", content: "result" }, { role: "assistant", content: "done" }, { role: "user", content: "open later" }], results: { "read-one": { ok: true, output: "result" }, "unreferenced": { secret: "never copy" } } });

describe("canonical fork/edit/retry lineage (C-SES-04)", () => {
  it("executes a canonical fork exactly once per commandId and records its lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-lineage-")), stateDir = join(root, "state"), store = new SessionStore(stateDir);
    try {
      const session = await store.new("First task", root, { sessionId: sid });
      Object.assign(session, source(), { root, title: "Source" });
      await store.save(session);
      const options = { store, stateDir, projectDir: root, webRuns: root, enabled: () => true }, api = createForkApi(options);
      const listed = (await api.dispatch("GET", ["api", "sessions", sid, "fork-boundaries"], {}, {}))!;
      assert.equal(listed[0], 200);
      const index = listed[1] as Row, cmd = commandId(1);
      const body = { revision: index.revision, boundary: index.boundaries[0].token, title: "Reviewable fork", commandId: cmd };
      const first = (await api.dispatch("POST", ["api", "sessions", sid, "fork"], {}, body))!;
      assert.equal(first[0], 201);
      const child = (first[1] as Row).session.id as string;
      const replay = (await api.dispatch("POST", ["api", "sessions", sid, "fork"], {}, body))!;
      assert.equal(replay[0], 200);
      const ack = replay[1] as Row;
      assert.equal(ack.status, "duplicate");
      assert.equal(ack.originalStatus, "accepted");
      assert.equal(ack.commandId, cmd);
      assert.equal(ack.result.session.id, child, "the replay returns the recorded child instead of forking again");
      const conflict = (await api.dispatch("POST", ["api", "sessions", sid, "fork"], {}, { ...body, title: "Different fork" }))!;
      assert.equal(conflict[0], 200);
      assert.equal((conflict[1] as Row).status, "rejected");
      assert.equal((conflict[1] as Row).reasonCode, "command_id_conflict");
      const lineage = (await api.dispatch("GET", ["api", "sessions", sid, "lineage"], {}, {}))!;
      assert.equal(lineage[0], 200);
      const rows = (lineage[1] as Row).lineage as Row[];
      assert.equal(rows.length, 1, "replays and conflicts never append lineage rows");
      const row = rows[0]!;
      assert.equal(row.intent, "fork");
      assert.equal(row.parentId, sid);
      assert.equal(row.childSessionId, child);
      assert.equal(row.parentRevision, index.revision);
      assert.equal(row.boundaryTurn, index.boundaries[0].turn);
      assert.equal(row.context.messages, 5);
      assert.equal(row.context.toolCalls, 1);
      assert.equal(row.context.toolResults, 1);
      const remapped = row.context.toolCallRemap["read-one"];
      assert.ok(typeof remapped === "string" && /^[0-9a-f]{32}$/.test(remapped), "the child-local tool call id is recorded");
      const childSession = await store.load(child);
      assert.ok(Object.hasOwn(childSession.results as Row, remapped), "the child keeps tool context under its remapped call id");
      assert.equal(Object.keys(childSession.results as Row).length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("replays a rewind command without re-executing and records the branch lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-lineage-rewind-")), store = new SessionStore(root);
    try {
      const session = await store.new("rewind lineage", root, { sessionId: sid });
      const messages = session.messages as Row[];
      messages[1]!._turn_id = "turn-1";
      const removedAnswer = uuid4Hex();
      messages.push(
        { role: "assistant", content: "first answer", _turn_id: "turn-1", _message_id: uuid4Hex() },
        { role: "user", content: "rewind from here", _turn_id: "turn-2", _message_id: uuid4Hex() },
        { role: "assistant", content: "removed answer", _turn_id: "turn-2", _message_id: removedAnswer },
      );
      session.status = "completed";
      await store.save(session);
      const options = { store, stateDir: root, projectDir: root, webRuns: root, enabled: () => true }, api = createRewindApi(options);
      const listed = (await api.dispatch("GET", ["api", "sessions", sid, "rewind-targets"], {}, {}))![1] as Row;
      const target = (listed.targets as Row[]).find((row) => row.preview === "rewind from here")!;
      const cmd = commandId(2);
      const body = { messageId: target.messageId, revision: listed.revision, confirmed: true, commandId: cmd };
      const first = (await api.dispatch("POST", ["api", "sessions", sid, "rewind"], {}, body))!;
      assert.equal(first[0], 200);
      const replay = (await api.dispatch("POST", ["api", "sessions", sid, "rewind"], {}, body))!;
      assert.equal(replay[0], 200);
      const ack = replay[1] as Row;
      assert.equal(ack.commandStatus, "duplicate");
      assert.equal(ack.commandId, cmd);
      assert.equal(ack.generation, (first[1] as Row).generation);
      assert.deepEqual(ack.removedMessageIds, (first[1] as Row).removedMessageIds);
      const resets = createSessionRuntimeEventLog(root, sid).readPage({ limit: 50 }).events.filter((event) => event.type === "HistoryReset");
      assert.equal(resets.length, 1, "the replay appends no second HistoryReset");
      const record = new LineageSidecar(store.directory).readRecord(sid);
      assert.equal((record.lineage as Row[]).length, 1);
      const row = (record.lineage as Row[])[0]!;
      assert.equal(row.intent, "rewind");
      assert.equal(row.parentId, sid);
      assert.equal(row.messageId, target.messageId);
      assert.equal(row.parentRevision, listed.revision);
      assert.ok((row.removedMessageIds as string[]).includes(removedAnswer));
      assert.equal(row.generation, (first[1] as Row).generation);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records an edit_retry lineage row only under a command envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-lineage-edit-")), stateDir = join(root, "ts"), store = new SessionStore(stateDir);
    try {
      const session = await store.new("Original", root, { sessionId: sid });
      const messages = session.messages as Row[];
      const laterId = uuid4Hex();
      messages.push({ role: "assistant", content: "First answer", _message_id: uuid4Hex() }, { role: "user", content: "Later user", _turn_id: "turn-2", _message_id: laterId }, { role: "assistant", content: "Later answer", _message_id: uuid4Hex() });
      session.status = "completed";
      session.steps = 3;
      await store.save(session);
      const api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true });
      const revision = messageRevision(await store.load(sid)), cmd = commandId(3);
      const result = await api.dispatch("PATCH", ["api", "sessions", sid, "message-actions"], {}, { revision, messageIndex: 1, action: "edit", text: "Replacement" }, { command: { id: cmd, fingerprint: "0".repeat(64) } });
      assert.equal(result?.[0], 200);
      const sidecar = new LineageSidecar(store.directory);
      let rows = sidecar.readRecord(sid).lineage as Row[];
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.intent, "edit_retry");
      assert.equal(row.commandId, cmd);
      assert.equal(row.parentId, sid);
      assert.equal(row.parentRevision, revision);
      assert.ok((row.hiddenMessageIds as string[]).includes(laterId), "the edit boundary hides the discarded suffix");
      assert.equal(row.context.turn, 1);
      assert.equal(row.context.messageIndex, 1);
      recordLineageRow(sidecar, sid, { commandId: cmd, intent: "edit_retry", parentRevision: revision });
      assert.equal((sidecar.readRecord(sid).lineage as Row[]).length, 1, "recording the same commandId twice keeps one row");
      const followup = await api.dispatch("PATCH", ["api", "sessions", sid, "message-actions"], {}, { revision: messageRevision(await store.load(sid)), messageIndex: 1, action: "edit", text: "Again" });
      assert.equal(followup?.[0], 200);
      assert.equal((sidecar.readRecord(sid).lineage as Row[]).length, 1, "edits without a command envelope record no lineage");
      const lineage = (await api.dispatch("GET", ["api", "sessions", sid, "lineage"], {}, {}))!;
      assert.equal(lineage[0], 200);
      assert.equal(((lineage[1] as Row).lineage as Row[])[0]!.intent, "edit_retry");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never locks the session out once retired claims age past the retention window", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-lineage-retire-"));
    try {
      const sidecar = new LineageSidecar(root), old = Date.now() - 2 * 86_400_000;
      const claims = Array.from({ length: 256 }, (_, i) => ({ commandId: `c_${old}_${i.toString(16).padStart(32, "0")}`, fingerprint: "0".repeat(64), intent: "rewind", ack: null }));
      await sidecar.locked(sid, () => sidecar.saveRecord(sid, { schema: 1, commands: claims, lineage: [], retiredBefore: 0 }));
      const blocked = await applyCanonicalIntent(sidecar, sid, { commandId: `c_${old}_${"1".repeat(32)}`, intent: "rewind", payload: { messageId: "m" } }, async () => ({ status: 200, result: { generation: 1 } }));
      assert.equal(blocked.reply[0], 200);
      assert.equal(blocked.outcome, "conflict", "an expired commandId is rejected as stale, not replayed");
      assert.equal((blocked.reply[1] as Row).reasonCode, "command_expired");
      const executed = await applyCanonicalIntent(sidecar, sid, { commandId: commandId(7), intent: "rewind", payload: { messageId: "m" } }, async () => ({ status: 200, result: { generation: 2 } }), (result) => ({ messageId: "m", generation: result.generation }));
      assert.equal(executed.outcome, "executed", "a full command window of expired claims no longer blocks new intents");
      const record = sidecar.readRecord(sid);
      assert.equal((record.commands as Row[]).length, 1);
      assert.ok(Number(record.retiredBefore) > 0, "retirement is durable so the window keeps shrinking");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never re-executes a claim whose outcome is unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-lineage-claim-"));
    try {
      const sidecar = new LineageSidecar(root), cmd = commandId(4);
      let attempts = 0;
      await assert.rejects(applyCanonicalIntent(sidecar, sid, { commandId: cmd, intent: "fork", payload: { boundary: "b" } }, async () => { attempts++; throw new Error("crash after claim"); }), /crash after claim/);
      assert.equal(attempts, 1);
      const unknown = await applyCanonicalIntent(sidecar, sid, { commandId: cmd, intent: "fork", payload: { boundary: "b" } }, async () => { attempts++; return { status: 201, result: { session: { id: "child" } } }; });
      assert.equal(unknown.outcome, "unknown");
      assert.equal(unknown.reply[0], 503);
      assert.equal(attempts, 1, "an uncertain claim is never re-executed");
      const second = commandId(5);
      const next = await applyCanonicalIntent(sidecar, sid, { commandId: second, intent: "rewind", payload: { messageId: "m" } }, async () => { attempts++; return { status: 200, result: { generation: 4 } }; }, (result) => ({ messageId: "m", generation: result.generation }));
      assert.equal(next.outcome, "executed");
      assert.equal(attempts, 2);
      assert.equal(next.lineage?.generation, 4);
      const duplicate = await applyCanonicalIntent(sidecar, sid, { commandId: second, intent: "rewind", payload: { messageId: "m" } }, async () => { attempts++; return { status: 200, result: { generation: 5 } }; });
      assert.equal(duplicate.outcome, "duplicate");
      assert.equal(attempts, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
