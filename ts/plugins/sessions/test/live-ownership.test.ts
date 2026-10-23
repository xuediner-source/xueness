import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NativeFileLocks, SessionStore } from "@xueness/sessions";
import { createConversationTransportApi } from "../src/conversation-transport.ts";
import { ConversationWatch } from "../src/conversation-watch.ts";
import { createSessionLiveApi } from "../src/live-api.ts";
import { PROJECT_ROOT, PYTHON, pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
const sid = "a".repeat(32);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xueness-live-ownership-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  const store = new SessionStore(stateDir); let enabled = true, projections = 0;
  const options = { store, stateDir, projectDir: root, webRuns: join(root, "runs"), enabled: () => enabled, running: new Set<string>() };
  return { root, store, options, marker: join(stateDir, ".xueness-session-read", sid + ".json"),
    project: (s: Record<string, unknown>) => { projections++; return { id: s.id, status: s.status, history_hash: s.history_hash }; }, get projections() { return projections; },
    disable: () => { enabled = false; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
it("closes a native snapshot stream when another process takes the run lease", async () => {
  const f = fixture(), other = new NativeFileLocks();
  try {
    await f.store.new("ownership transition", f.root, { sessionId: sid });     const api = createSessionLiveApi(f.options, f.project), reply = await api.dispatch("GET", ["api", "sessions", sid, "updates"], {}, {}, { accept: "text/event-stream" }); assert.ok(reply);
    const iterator = (reply[1] as AsyncIterable<Uint8Array>)[Symbol.asyncIterator](); assert.equal((await iterator.next()).done, false);
    const held = await other.tryAcquire(f.store.lockDirectory, sid + ".lock");
    try {
      const before = readFileSync(f.store.pathFor(sid)); assert.equal((await iterator.next()).done, true);
      assert.equal(f.projections, 1, "live state owned by another process must never use local approval/context maps");
      assert.deepEqual(readFileSync(f.store.pathFor(sid)), before); assert.equal(existsSync(f.marker), false);
    } finally { await held.release(); }
  } finally { await other.close(); f.dispose(); }
});
it("answers a pending native watch with session_busy after another process takes ownership, without acknowledging unseen state", async () => {
  const f = fixture(), other = new NativeFileLocks();
  try {
    await f.store.new("watch transition", f.root, { sessionId: sid });     const api = createConversationTransportApi(f.options, f.project), first = await api.cache.observe(sid); unlinkSync(f.marker);
    let observed!: () => void; const entered = new Promise<void>((resolve) => { observed = resolve; }), original = api.cache.observe.bind(api.cache);
    api.cache.observe = async (...args) => { const result = await original(...args); observed(); return result; };
    const pending = api.dispatch("GET", ["api", "sessions", "conversation-transport", "watch"], { client: "fixture123", topic: `${sid}.${first.logEpoch}.${first.seq}`, wait: "2000" }, {});
    await entered; assert.equal(existsSync(f.marker), false, "long polls defer read-state writes until they answer");
    const held = await other.tryAcquire(f.store.lockDirectory, sid + ".lock");
    try {
      assert.deepEqual(await pending, [409, { error: "session is running in another process", code: "session_busy" }]); assert.equal(f.projections, 2); assert.equal(existsSync(f.marker), false); assert.equal(api.cache.entries.size, 0);
    } finally { await held.release(); }
  } finally { await other.close(); f.dispose(); }
});
for (const action of ["abort", "disable"] as const) it(`releases conversation waiters and read acknowledgements on ${action}`, async () => {
  const f = fixture();
  try {
    await f.store.new("watch cleanup", f.root, { sessionId: sid });
    const api = createConversationTransportApi(f.options, f.project), first = await api.cache.observe(sid); unlinkSync(f.marker);
    const watcher = new ConversationWatch(api.cache), abort = new AbortController(); let observed!: () => void;
    const entered = new Promise<void>((resolve) => { observed = resolve; }), original = api.cache.observe.bind(api.cache);
    api.cache.observe = async (...args) => { const result = await original(...args); observed(); return result; };
    const pending = watcher.watch({ client: "fixture123", topics: [[sid, { epoch: first.logEpoch, seq: first.seq }]], since: null, wait: 2000, pace: 0 }, abort.signal);
    await entered; assert.equal(watcher.waiters.size, 1);
    if (action === "abort") { abort.abort(); await pending; }
    else { f.disable(); await assert.rejects(pending, { name: "PermissionError" }); assert.equal(api.cache.entries.size, 0); }
    assert.equal(watcher.waiters.size, 0); assert.equal(existsSync(f.marker), false);
  } finally { f.dispose(); }
});
it("stops native SSE projection when sessions is disabled between chunks", async () => {
  const f = fixture();
  try {
    await f.store.new("stream disable", f.root, { sessionId: sid });
    const api = createSessionLiveApi(f.options, f.project), reply = await api.dispatch("GET", ["api", "sessions", sid, "updates"], {}, {}, { accept: "text/event-stream" }); assert.ok(reply);
    const iterator = (reply[1] as AsyncIterable<Uint8Array>)[Symbol.asyncIterator](); await iterator.next(); f.disable();
    assert.equal((await iterator.next()).done, true); assert.equal(f.projections, 1);
  } finally { f.dispose(); }
});
it("withholds an already prepared snapshot if sessions is disabled before the stream starts", async () => {
  const f = fixture();
  try {
    await f.store.new("stream admission disable", f.root, { sessionId: sid });
    const reply = await createSessionLiveApi(f.options, f.project).dispatch("GET", ["api", "sessions", sid, "updates"], {}, {}, { accept: "text/event-stream" }); assert.ok(reply);
    f.disable(); const chunks: Uint8Array[] = []; for await (const chunk of reply[1] as AsyncIterable<Uint8Array>) chunks.push(chunk);
    assert.equal(chunks.length, 0); assert.equal(f.projections, 1);
  } finally { f.dispose(); }
});
