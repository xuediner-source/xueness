import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict, normalizeError, pyJsonDumps } from "@xueness/contracts";
import { NativeFileLocks, SessionStore } from "@xueness/sessions";
import { MessageQueue } from "../src/queue.ts";
import { createSessionCommandsApi } from "../src/command-http.ts";
import { createSessionsApi } from "../src/http-api.ts";
import { CommandReceipts } from "../src/command-receipts.ts";
import { beforeModelRequest, pendingSnapshot, SteeringInbox } from "../src/steering.ts";
import { fingerprint, type Row, type SessionCommandsOptions } from "../src/queue-types.ts";
import { QueueMedia } from "../src/queue-media.ts";
import { PROJECT_ROOT, PYTHON, pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
const sid = "a".repeat(32), first = "1".repeat(32), second = "2".repeat(32);
const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : isDict(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ["created_at", "updated_at", "createdAt", "expiresAt"].includes(k) ? "(time)" : clean(v)])) : value;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xueness-queue-ts-")), stateDir = join(root, "ts"); mkdirSync(stateDir);
  const store = new SessionStore(stateDir), options: SessionCommandsOptions = { store, stateDir, webRuns: join(root, "web-runs"), projectDir: root, enabled: () => true, running: new Set() };
  return { root, store, options, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
describe("queue and command admission", () => {
  it("matches real Python queue mutation/CAS/history semantics", { skip: pythonUnavailableReason() ?? false }, async () => {
    const f = fixture();
    try {
      await f.store.new("queue fixture", f.root, { sessionId: sid });
      const pyState = join(f.root, "python"); cpSync(f.options.stateDir, pyState, { recursive: true });
      const queue = new MessageQueue(f.store); let next = first; queue.media.itemId = () => next;
      const result: unknown[] = [];
      await queue.setAccepting(sid, true);
      result.push(await queue.enqueue(sid, "one", { text: "one\ncontext", edit_prefix: "one", metadata: { files: ["file.txt"] } }, { requestId: first, fingerprint: fingerprint("one") }));
      next = second; result.push(await queue.enqueue(sid, "two", null, { requestId: second, fingerprint: fingerprint("two") }));
      result.push(await queue.snapshot(sid));
      result.push(await queue.locked(sid, () => queue.editLocked(sid, first, "edited", "one", null, 3)));
      result.push(await queue.locked(sid, () => queue.reorderLocked(sid, [second, first], [first, second], null, 4)));
      result.push(await queue.locked(sid, () => queue.cancelLocked(sid, first, null, "edited", 5)));
      result.push(await queue.snapshot(sid)); result.push(await queue.closeIfEmpty(sid));
      await queue.claimNext(sid); result.push(await queue.update(sid, second, "completed", { status: "completed", verified: true }));
      result.push(await queue.closeIfEmpty(sid)); result.push(await queue.snapshot(sid));
      const expected = JSON.parse(await runPythonAsync(`
import json,sys
from pathlib import Path
from xueness.core import Store
from xueness.bundled_plugins.sessions.queue import MessageQueue
data=json.load(sys.stdin); q=MessageQueue(Store(Path(data['directory']))); sid=data['sid']; first=data['first']; second=data['second']; out=[]
q._item_id=lambda *args,**kwargs:first
q.set_accepting(sid, True)
with q.session_lock(sid): out.append(q._enqueue_locked(sid,'one',{'text':'one\\ncontext','edit_prefix':'one','metadata':{'files':['file.txt']}},request_id=first,fingerprint=data['fp1']))
q._item_id=lambda *args,**kwargs:second
with q.session_lock(sid): out.append(q._enqueue_locked(sid,'two',request_id=second,fingerprint=data['fp2']))
out.append(q.snapshot(sid)); out.append(q.edit(sid,first,'edited','one',expected_revision=3));out.append(q.reorder(sid,[second,first],[first,second],expected_revision=4))
with q.session_lock(sid): out.append(q._cancel_locked(sid,first,expected_text='edited',expected_revision=5))
out.append(q.snapshot(sid));out.append(q.close_if_empty(sid));q.claim_next(sid);out.append(q.update(sid,second,'completed',{'status':'completed','verified':True}));out.append(q.close_if_empty(sid));out.append(q.snapshot(sid))
print(json.dumps(out,ensure_ascii=True))
`, JSON.stringify({ directory: pyState, sid, first, second, fp1: fingerprint("one"), fp2: fingerprint("two") })));
      assert.deepEqual(clean(result), clean(expected));
      const published = JSON.parse(readFileSync(queue.path(sid), "utf8"));
      assert.deepEqual(clean(published), clean(JSON.parse(readFileSync(join(pyState, "session-message-queues", sid + ".json"), "utf8"))));
    } finally { f.dispose(); }
  });

  it("matches Python HTTP receipt validation, noop/duplicate/query and expiry", { skip: pythonUnavailableReason() ?? false }, async () => {
    const f = fixture();
    try {
      const session = await f.store.new("commands", f.root, { sessionId: sid });
      const pyState = join(f.root, "python"); cpSync(f.options.stateDir, pyState, { recursive: true });
      const commandId = `c_${Date.now() - 3600000}_${first}`, expired = `c_${Date.now() - 90000000}_${second}`;
      const payload = { expected_turn_id: null }, envelope = { commandId, type: "stop", payload };
      const requests = [
        { method: "POST", path: `/api/sessions/${sid}/commands`, data: {} },
        { method: "POST", path: `/api/sessions/${sid}/commands`, data: envelope },
        { method: "POST", path: `/api/sessions/${sid}/commands`, data: envelope },
        { method: "GET", path: `/api/sessions/${sid}/commands/${commandId}` },
        { method: "POST", path: `/api/sessions/${sid}/commands`, data: { ...envelope, payload: { expected_turn_id: "old" } } },
        { method: "POST", path: `/api/sessions/${sid}/commands`, data: { ...envelope, commandId: expired } },
        { method: "GET", path: `/api/sessions/${sid}/commands/${expired}` },
      ];
      let executions = 0;
      const api = createSessionCommandsApi({ ...f.options, executeCommand: async () => { executions++; return [200, { id: sid, stopping: false, status: session.status, cancelled_tasks: [] }]; } });
      const actual: unknown[] = [];
      for (const r of requests) { const reply = (await api.dispatch(r.method, r.path.split("/").filter(Boolean), {}, r.data ?? {}))!; actual.push([reply[0], reply[0] >= 400 && isDict(reply[1]) ? normalizeError(reply[0], reply[1]) : reply[1]]); }
      const path = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
      const expected = JSON.parse(await runPythonAsync(`import runpy; runpy.run_path(${JSON.stringify(path)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: f.root, requests })));
      assert.deepEqual(actual, expected); assert.equal(executions, 1);
    } finally { f.dispose(); }
  });

  it("keeps an unknown durable claim non-replayable across API instances", async () => {
    const f = fixture();
    try {
      await f.store.new("unknown write", f.root, { sessionId: sid }); let executions = 0;
      const options = { ...f.options, executeCommand: async (): Promise<[number, unknown]> => { executions++; throw new Error("committed then failed"); } };
      const envelope = { commandId: `c_${Date.now()}_${first}`, type: "send", payload: { text: "once" } }, p = ["api", "sessions", sid, "commands"];
      const one = (await createSessionCommandsApi(options).dispatch("POST", p, {}, envelope))!;
      assert.equal(one[0], 503); assert.equal((one[1] as Row).reasonCode, "command_unknown");
      const retry = await createSessionCommandsApi(options).dispatch("POST", p, {}, envelope); assert.deepEqual(retry, one); assert.equal(executions, 1);
      const receipts = new CommandReceipts(f.options.stateDir); assert.equal(receipts.readRecord(sid).commands[0].ack, null);
      assert.deepEqual(await createSessionCommandsApi(options).dispatch("GET", [...p, envelope.commandId], {}, {}), [200, { result: "unknown" }]);
    } finally { f.dispose(); }
  });

  it("rejects unsupported commands before any durable claim or user mutation", async () => {
    const f = fixture();
    try {
      const session = await f.store.new("unsupported agent plugin", f.root, { sessionId: sid });
      const before = readFileSync(f.store.pathFor(sid)); let executions = 0;
      const api = createSessionCommandsApi({ ...f.options, supportsCommand: () => false, executeCommand: async () => { executions++; return [200, {}]; } });
      const result = await api.dispatch("POST", ["api", "sessions", sid, "commands"], {}, { commandId: `c_${Date.now()}_${first}`, type: "run", payload: {} });
      assert.equal(result?.[0], 200); assert.equal((result?.[1] as Record<string, unknown>).status, "rejected"); assert.equal((result?.[1] as Record<string, unknown>).reasonCode, "unsupported_command");
      assert.equal(executions, 0); assert.deepEqual(readFileSync(f.store.pathFor(sid)), before);
      assert.equal(existsSync(join(f.options.stateDir, "session-command-receipts")), false);
      assert.equal(session.status, "pending");
    } finally { f.dispose(); }
  });

  it("refuses mutations while another process owns the run, without pausing queues or claiming commands", async () => {
    const f = fixture(), other = new NativeFileLocks();
    try {
      const s = await f.store.new("Python owns the turn", f.root, { sessionId: sid }); s.status = "running"; s.active_turn_id = "turn-1"; await f.store.save(s);
      const held = await other.tryAcquire(f.store.lockDirectory, `${sid}.lock`);
      try {
        const api = createSessionCommandsApi(f.options), command = { commandId: `c_${Date.now()}_${first}`, type: "run", payload: {} };
        const requests = [
          [["api", "sessions", sid, "queue"], { text: "next", expected_turn_id: "turn-1" }],
          [["api", "sessions", sid, "steer"], { text: "guide", request_id: first, expected_turn_id: "turn-1" }],
          [["api", "sessions", sid, "queue", first, "send-now"], { request_id: second, expected_turn_id: "turn-1" }],
          [["api", "sessions", sid, "commands"], command],
        ] as const;
        const before = readFileSync(f.store.pathFor(sid));
        for (const [parts, data] of requests) {
          const reply = await api.dispatch("POST", [...parts], {}, data);
          if (parts[3] === "commands") assert.equal((reply?.[1] as Record<string, unknown>).reasonCode, "session_busy", parts.join("/"));
          else assert.equal(reply?.[0], 409, parts.join("/"));
        }
        const sessions = createSessionsApi(f.options);
        const events = await sessions.dispatch("GET", ["api", "sessions", sid, "events.v1"], {}, {});
        assert.equal(events?.[0], 200);
        assert.deepEqual(readFileSync(f.store.pathFor(sid)), before);
        for (const folder of ["session-command-receipts", "session-message-queues", "session-turn-inputs"]) assert.equal(existsSync(join(f.options.stateDir, folder)), false, folder);
      } finally { await held.release(); }
    } finally { await other.close(); f.dispose(); }
  });

  it("matches Python HTTP queue CAS, fenced refusal, idempotent enqueue and withdrawal escrow", { skip: pythonUnavailableReason() ?? false }, async () => {
    const f = fixture();
    try {
      const session = await f.store.new("HTTP queue", f.root, { sessionId: sid }); session.status = "paused"; await f.store.save(session);
      const q = new MessageQueue(f.store); let next = first; q.media.itemId = () => next;
      await q.setAccepting(sid, true); await q.enqueue(sid, "one"); next = second; await q.enqueue(sid, "two"); await q.pausePending(sid);
      const pyState = join(f.root, "python"); cpSync(f.options.stateDir, pyState, { recursive: true });
      const commandId = `c_${Date.now() - 3600000}_${"4".repeat(32)}`, requestId = "3".repeat(32), path = `/api/sessions/${sid}`;
      const requests = [
        { method: "GET", path: `${path}/queue` },
        { method: "PATCH", path: `${path}/queue/${first}`, data: { text: "edited", expectedText: "one", expectedRevision: 3 } },
        { method: "PATCH", path: `${path}/queue/${first}`, data: { text: "edited", expectedText: "one", expectedRevision: 4 } },
        { method: "PATCH", path: `${path}/queue`, data: { ids: [second, first], expectedIds: [first, second], expectedRevision: 5 } },
        { method: "DELETE", path: `${path}/queue/${first}`, data: { expectedText: "edited", expectedRevision: 5 } },
        { method: "POST", path: `${path}/queue`, data: { text: "three", request_id: requestId, expected_turn_id: "old-turn" } },
        { method: "POST", path: `${path}/queue`, data: { text: "three", request_id: requestId } },
        { method: "POST", path: `${path}/queue`, data: { text: "three", request_id: requestId } },
        { method: "POST", path: `${path}/queue`, data: { text: "conflict", request_id: requestId } },
        { method: "DELETE", path: `${path}/queue/${second}`, data: { expectedText: "two", expectedRevision: 7 } },
        { method: "POST", path: `${path}/commands`, data: { commandId, type: "withdraw_queue", payload: { queueId: first, expectedText: "edited", expectedRevision: 8 } } },
        { method: "GET", path: `${path}/queue-withdrawals` },
        { method: "GET", path: `${path}/queue-withdrawals/${commandId}` },
        { method: "DELETE", path: `${path}/queue-withdrawals/${commandId}` },
        { method: "GET", path: `${path}/queue` },
      ];
      const api = createSessionCommandsApi(f.options), actual: unknown[] = [];
      for (const r of requests) { const reply = (await api.dispatch(r.method, r.path.split("/").filter(Boolean), {}, r.data ?? {}))!; actual.push([reply[0], reply[0] >= 400 && isDict(reply[1]) ? normalizeError(reply[0], reply[1]) : reply[1]]); }
      const oracle = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
      const expected = JSON.parse(await runPythonAsync(`import runpy; runpy.run_path(${JSON.stringify(oracle)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: f.root, requests })));
      const normalizeId = (v: unknown): unknown => typeof v === "string" && /^[0-9a-f]{32}$/.test(v) && ![sid, first, second, requestId].includes(v) ? "(generated id)" : Array.isArray(v) ? v.map(normalizeId) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeId(x)])) : v;
      assert.deepEqual(normalizeId(clean(actual)), normalizeId(clean(expected)));
      assert.equal((await q.snapshot(sid)).queue_revision, 9, "reading/dismissing escrow must not advance queue generation");
    } finally { f.dispose(); }
  });

  it("splices guidance once in the same turn and pauses undelivered old guidance", async () => {
    const f = fixture();
    try {
      const session = await f.store.new("guidance", f.root, { sessionId: sid }); session.active_turn_id = "turn-1"; session.status = "running"; await f.store.save(session);
      const inbox = new SteeringInbox(f.store); let next = first; inbox.media.itemId = () => next;
      await inbox.locked(sid, () => inbox.admitLocked(sid, "guide now", "turn-1", first, fingerprint("first")));
      assert.equal(await beforeModelRequest(session, f.store, f.options.stateDir), 1);
      assert.equal(await beforeModelRequest(session, f.store, f.options.stateDir), 0);
      const messages = session.messages as Row[]; assert.equal(messages.at(-1)!._input_id, first); assert.equal(messages.at(-1)!._turn_id, "turn-1");
      next = second; await inbox.locked(sid, () => inbox.admitLocked(sid, "old guide", "turn-1", second, fingerprint("second")));
      session.active_turn_id = "turn-2"; await f.store.save(session);
      const snapshot = await pendingSnapshot(session, f.store, f.options.stateDir);
      assert.equal(snapshot.pending_guidance[0].status, "paused"); assert.match(snapshot.pending_guidance[0].pause_reason, /target turn has ended/);
      assert.equal((await f.store.load(sid)).messages && (session.messages as Row[]).filter((m) => m._input_id === first).length, 1);
    } finally { f.dispose(); }
  });

  it("matches real Python HTTP guide, retained queries and send-now reservation fences", { skip: pythonUnavailableReason() ?? false }, async () => {
    const f = fixture(), original = QueueMedia.prototype.itemId;
    try {
      const session = await f.store.new("live turn fixture", f.root, { sessionId: sid }); session.status = "running"; session.active_turn_id = "turn-1"; await f.store.save(session);
      const q = new MessageQueue(f.store); q.media.itemId = () => first; await q.setAccepting(sid, true); await q.enqueue(sid, "future turn");
      const pyState = join(f.root, "python"); cpSync(f.options.stateDir, pyState, { recursive: true });
      const guideId = "3".repeat(32), promotionId = "4".repeat(32); QueueMedia.prototype.itemId = () => guideId;
      const guide = { text: "guide current turn", request_id: second, expected_turn_id: "turn-1" }, promotion = { request_id: promotionId, expected_turn_id: "turn-1", expectedRevision: 2 }, base = `/api/sessions/${sid}`;
      const requests = [
        { method: "GET", path: `${base}/steer` },
        { method: "POST", path: `${base}/steer`, data: guide },
        { method: "POST", path: `${base}/steer`, data: guide },
        { method: "POST", path: `${base}/steer`, data: { ...guide, text: "conflicting input" } },
        { method: "POST", path: `${base}/steer`, data: { ...guide, request_id: guideId, expected_turn_id: "old-turn" } },
        { method: "GET", path: `${base}/steer` },
        { method: "POST", path: `${base}/steer-query`, data: { operation: "send", payload: guide } },
        { method: "POST", path: `${base}/queue/${first}/send-now`, data: promotion },
        { method: "POST", path: `${base}/queue/${first}/send-now`, data: promotion },
        { method: "POST", path: `${base}/steer-query`, data: { operation: "promote", queueId: first, payload: promotion } },
        { method: "DELETE", path: `${base}/steer/${guideId}` },
        { method: "POST", path: `${base}/steer-query`, data: { operation: "cancel", guidanceId: guideId } },
      ];
      let stops = 0; const api = createSessionCommandsApi({ ...f.options, running: new Set([sid]), requestStop: () => { stops++; } }), actual: unknown[] = [];
      for (const r of requests) { const reply = (await api.dispatch(r.method, r.path.split("/").filter(Boolean), {}, r.data ?? {}))!; actual.push([reply[0], reply[0] >= 400 && isDict(reply[1]) ? normalizeError(reply[0], reply[1]) : reply[1]]); }
      const expected = JSON.parse(await runPythonAsync(`
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.sessions.steering import SteeringInbox
data=json.load(sys.stdin); root=Path(data['workspace']); ctx=web.build_context(Path(data['stateDir']),root/'web-runs',root,False,csrf='fixture-csrf');ctx['running'].add(data['sid'])
SteeringInbox._item_id=lambda *args,**kwargs:data['guideId']
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start();out=[]
try:
 for row in data['requests']:
  c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=10);body=json.dumps(row.get('data',{})).encode();c.request(row['method'],row['path'],None if row['method']=='GET' else body,{'Content-Type':'application/json','X-CSRF-Token':'fixture-csrf'});r=c.getresponse();out.append([r.status,json.loads(r.read())]);c.close()
finally:
 server.shutdown();server.server_close()
print(json.dumps(out,ensure_ascii=True))
`, JSON.stringify({ stateDir: pyState, workspace: f.root, sid, guideId, requests })));
      assert.deepEqual(clean(actual), clean(expected)); assert.equal(stops, 1, "replaying a reservation must not request stop twice");
    } finally { QueueMedia.prototype.itemId = original; f.dispose(); }
  });
});
