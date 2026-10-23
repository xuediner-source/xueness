import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyDeepCopy } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { forkBoundaries } from "../src/fork-boundaries.ts";
import { createForkApi } from "../src/forking.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { Owner } from "../src/media-owner.ts";
import { messageOwner } from "../src/media-history.ts";
import { forkTruncation, ForkError, type Row } from "../src/fork-common.ts";
import { continuousStableAnchors, recordStableForkBoundaries } from "../src/stable-boundaries.ts";
import { PROJECT_ROOT, PYTHON, pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import { NativeFileLocks } from "@xueness/sessions";
const sid = "a".repeat(32), revision = "sha256:" + "0".repeat(64);
const call = (id = "read-one", args = '{}') => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read", arguments: args } }] });
const source = (): Row => ({ id: sid, task: "First task", root: "/fixture", status: "paused", messages: [{ role: "system", content: "old system" }, { role: "user", content: "First\u0085 closed 中 turn" }, call(), { role: "tool", tool_call_id: "read-one", content: "result" }, { role: "assistant", content: "done" }, { role: "user", content: "open later" }], results: { "read-one": { ok: true, output: "result" }, "unreferenced": { secret: "never copy" } } });
describe("safe session forks", () => {
  it("matches Python boundaries and refusals for malformed, stale and compacted turns", { skip: pythonUnavailableReason() ?? false }, async () => {
    const cases = [source()];
    for (const mutation of [(s: Row) => { s.messages.pop(); }, (s: Row) => { s.results["read-one"] = { ok: false, error: "denied" }; },
      (s: Row) => { s.messages.splice(3, 1); }, (s: Row) => { s.messages[2] = call("read-one", "[]"); },
      (s: Row) => { s.messages[3].tool_call_id = "unknown"; }, (s: Row) => { s.messages[2].tool_calls.push(s.messages[2].tool_calls[0]); },
      (s: Row) => { s.messages.pop(); s.status = "running"; }, (s: Row) => { s.archived_messages = [{ role: "user", content: "hidden" }]; s.compactions = [{ removed: 1 }]; },
      (s: Row) => { s.messages.splice(2, 0, { role: "system", content: "Older history compacted; untrusted summary" }); },
      (s: Row) => { s.messages[2].tool_calls[0].id = "__proto__"; s.messages[3].tool_call_id = "__proto__"; s.results = JSON.parse('{"__proto__":{"ok":false,"error":"denied"}}'); }]) { const s = pyDeepCopy(source()); mutation(s); cases.push(s); }
    const actual = cases.map((s) => { try { return { value: forkBoundaries(s, revision) }; } catch (e) { assert(e instanceof ForkError); return { status: e.status, error: e.message }; } });
    const expected = JSON.parse(await runPythonAsync(`
import json,sys
from xueness.bundled_plugins.sessions.forking import _boundaries,ForkError
d=json.load(sys.stdin);out=[]
for s in d['cases']:
 try: out.append({'value':_boundaries(s,d['revision'])})
 except ForkError as e: out.append({'status':e.status,'error':str(e)})
print(json.dumps(out,ensure_ascii=True))
`, JSON.stringify({ cases, revision })));
    assert.deepEqual(actual, expected); assert.equal(forkTruncation(source(), source().messages)[0], false);
  });
  it("copies only the closed prefix with child-local identities and no execution state", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-fork-")), stateDir = join(root, "state"), store = new SessionStore(stateDir);
    try {
      const session = await store.new("First task", root, { sessionId: sid }), sample = source();
      sample.messages[1]._turn_id = "turn-17"; sample.messages[2]._turn_id = "turn-17"; sample.messages[3]._turn_id = "turn-17"; sample.messages[4]._turn_id = "turn-17"; sample.messages[5]._turn_id = "turn-18";
      Object.assign(session, sample, { root, title: "Source", runtime_profile: "lightweight", model_selection: { provider_id: "fixture", model: "model-a" }, permission_mode: "yolo", remote_connection: { id: "never inherit" }, approval_log: [{ secret: true }], completion: { verified: true } });
      await store.save(session); const before = readFileSync(store.pathFor(sid)), sourceMessages = session.messages as Row[];
      const options = { store, stateDir, projectDir: root, webRuns: root, enabled: () => true }, api = createForkApi(options);
      const listed = (await api.dispatch("GET", ["api", "sessions", sid, "fork-boundaries"], {}, {}))!; assert.equal(listed[0], 200);
      const index = listed[1] as Row, data = { revision: index.revision, boundary: index.boundaries[0].token, title: "Reviewable fork" };
      const fork = (await api.dispatch("POST", ["api", "sessions", sid, "fork"], {}, data))!; assert.equal(fork[0], 201);
      const actual = await store.load((fork[1] as Row).session.id);
      const childMessages = actual.messages as Row[], sourceIds = new Set(sourceMessages.map((m) => m._message_id)), childIds = childMessages.map((m) => m._message_id);
      assert.equal(actual.status, "pending"); assert.equal(actual.permission_mode, undefined); assert.equal(actual.remote_connection, undefined);
      assert.equal(childMessages.some((m) => m.content === "open later"), false);
      assert.equal(childMessages[1]?._turn_id, "turn-1"); assert.equal(sourceMessages[1]?._turn_id, "turn-17");
      assert.ok(childIds.every((id) => typeof id === "string" && /^[0-9a-f]{32}$/.test(id)));
      assert.equal(new Set(childIds).size, childIds.length); assert.ok(childIds.every((id) => !sourceIds.has(id)));
      const callId = childMessages[2]!.tool_calls[0].id; assert.notEqual(callId, "read-one");
      assert.equal(childMessages[3]!.tool_call_id, callId); assert.deepEqual(actual.results, { [callId]: { ok: true, output: "result" } });
      assert.equal(((actual.fork_parent as Row).sourceRevision), index.revision);
      assert.deepEqual(readFileSync(store.pathFor(sid)), before);
      const stale = await api.dispatch("POST", ["api", "sessions", sid, "fork"], {}, { ...data, revision }); assert.equal(stale?.[0], 409);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses a source lease another process owns and a disabled feature without side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-fork-lock-")), store = new SessionStore(root), other = new NativeFileLocks();
    try {
      await store.new("source", root, { sessionId: sid }); const held = await other.tryAcquire(store.lockDirectory, sid + ".lock");
      try { const api = createForkApi({ store, stateDir: root, webRuns: root, projectDir: root, enabled: () => true }); assert.equal((await api.dispatch("GET", ["api", "sessions", sid, "fork-boundaries"], {}, {}))?.[0], 409); }
      finally { await held.release(); }
      const denied = createForkApi({ store, stateDir: root, webRuns: root, projectDir: root, enabled: () => false }); assert.equal((await denied.dispatch("GET", ["api", "sessions", sid, "fork-boundaries"], {}, {}))?.[0], 403);
    } finally { await other.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("links checkpoint forks to the earlier closed turn without rewriting the shared workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-fork-checkpoint-")), store = new SessionStore(root);
    try {
      const s = await store.new("source", root, { sessionId: sid }); Object.assign(s, source(), { root, turn_checkpoints: [{ checkpointId: "1".repeat(32), turn: 2 }] }); await store.save(s);
      const api = createForkApi({ store, stateDir: root, projectDir: root, webRuns: root, enabled: () => true }), path = ["api", "sessions", sid, "fork-from-checkpoint"], before = readFileSync(store.pathFor(sid));
      const result = (await api.dispatch("POST", path, {}, { latest: true }))!; assert.equal(result[0], 201);
      const reply = result[1] as Row, child = await store.load(reply.session.id);
      assert.deepEqual(reply.checkpoint, { checkpointId: "1".repeat(32), turn: 2 });
      assert.equal((child.fork_parent as Row).checkpointTurn, 2); assert.equal((child.fork_parent as Row).turn, 1);
      assert.equal((child.messages as Row[]).some((r) => r.content === "open later"), false); assert.deepEqual(readFileSync(store.pathFor(sid)), before);
      assert.equal((await api.dispatch("POST", path, {}, { latest: true, checkpoint: "1".repeat(32) }))?.[0], 400);
      assert.equal((await api.dispatch("POST", path, {}, { turn: 1 }))?.[0], 409);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("pins forked media under the child's exact message owner before publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-fork-media-")), store = new SessionStore(root);
    try {
      const s = await store.new("image turn", root, { sessionId: sid }); (s.messages as Row[]).push({ role: "assistant", content: "closed" }); s.status = "completed"; await store.save(s);
      const media = new MediaArtifactStore(root), message = (s.messages as Row[])[1]!, bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const owner = new Owner("message", message._message_id, root, sid), ref = await media.importBytes(owner, bytes, { name: "image.png", size: bytes.length, mimeType: "image/png" }); message._media_refs = [ref]; await store.save(s);
      const api = createForkApi({ store, stateDir: root, projectDir: root, webRuns: root, enabled: () => true }), listed = (await api.dispatch("GET", ["api", "sessions", sid, "fork-boundaries"], {}, {}))![1] as Row;
      const reply = (await api.dispatch("POST", ["api", "sessions", sid, "fork"], {}, { revision: listed.revision, boundary: listed.boundaries[0].token }))![1] as Row, child = await store.load(reply.session.id);
      const copied = (child.messages as Row[])[1]!; assert.notEqual(copied._message_id, message._message_id); assert.deepEqual(await media.resolve(messageOwner(child, copied), ref.id), bytes);
      assert.deepEqual(await media.resolve(owner, ref.id), bytes); assert.equal(child.status, "pending");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps guide and background notices inside their existing turn boundaries", () => {
    const s: Row = { ...source(), status: "completed", messages: [
      { role: "system", content: "system" },
      { role: "user", content: "first", _message_id: "1".repeat(32), _turn_id: "turn-1" },
      { role: "user", content: "guidance", _message_id: "2".repeat(32), _turn_id: "turn-1", _input_kind: "guide" },
      { role: "assistant", content: "first answer", _message_id: "3".repeat(32), _turn_id: "turn-1" },
      { role: "user", content: "task notice", _message_id: "4".repeat(32), _turn_id: "turn-1", _input_kind: "background_notice", _meta_source: "task_status", _background_task_notice: "bg-1:exited" },
      { role: "user", content: "second", _message_id: "5".repeat(32), _turn_id: "turn-2" },
      { role: "assistant", content: "second answer", _message_id: "6".repeat(32), _turn_id: "turn-2" },
      { role: "user", content: "late notice", _message_id: "7".repeat(32), _turn_id: "turn-2", _input_kind: "background_notice", _meta_source: "task_status", _background_task_notice: "bg-2:exited" },
    ] };
    const index = forkBoundaries(s, revision);
    assert.equal(index.hasUnclosedTurn, false); assert.equal(index.boundaries.length, 2);
    assert.equal(index.boundaries[0].turn, 1); assert.equal(index.boundaries[0].endIndex, 3);
    assert.equal(index.boundaries[1].turn, 2); assert.equal(index.boundaries[1].endIndex, 6);
  });
  it("persists only complete stable anchors and rejects prefixes that no longer match", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-stable-anchor-")), store = new SessionStore(root);
    try {
      const session = await store.new("anchored", root, { sessionId: sid }); (session.messages as Row[]).push({ role: "assistant", content: "closed" }); session.status = "completed";
      await store.save(session);
      assert.equal(recordStableForkBoundaries(session), true); await store.save(session);
      let loaded = await store.load(sid), anchors = continuousStableAnchors(loaded);
      assert.equal(anchors.length, 1); assert.equal(anchors[0]!.turn, 1); assert.equal(anchors[0]!.endMessageId, (loaded.messages as Row[])[2]!._message_id);
      (loaded.messages as Row[])[1]!._message_id = "f".repeat(32); await store.save(loaded);
      loaded = await store.load(sid); assert.deepEqual(continuousStableAnchors(loaded), []);
      assert.equal((forkBoundaries(loaded, revision).boundaries as Row[]).some((item) => item.anchorId), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
