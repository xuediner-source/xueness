import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { isDict, PyValueError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { stageGoal } from "@xueness/plugin-planning";
import { appendAcceptedQueuedTurn, appendAcceptedTurn, createAcceptedSession } from "../src/create-session.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { Owner } from "../src/media-owner.ts";
import type { PreparedInputOptions } from "../src/prepared-input.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const selection = { provider_id: "fixture", model: "fixture-model", reasoning_effort: null };
const prepared = (text: string): Row => ({ text, goal: true, metadata: { modelSelection: selection, files: [{ id: "f", path: "notes.txt", secret: "omit" }], commandInvocations: [{ command: "fixture", args: "hello" }] } });
const project = (s: Row): Row => Object.fromEntries(["task", "status", "model_selection", "input_context", "input_attachments", "command_invocations", "goal"].map((k) => [k, s[k] ?? null]).concat([["turns", s.messages.filter((m: Row) => m.role === "user").map((m: Row) => m.content)]]));
const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ["message_id", "setAt", "updatedAt", "at"].includes(k) ? "(dynamic)" : normalize(x)])) : v;
const oracle = `
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.sessions import composer_api
p=json.load(sys.stdin); state=Path(p['state']); root=Path(p['root']); state.mkdir(); (state/'providers').mkdir()
(state/'providers'/'fixture.json').write_text(json.dumps({'id':'fixture','name':'Fixture','apiKey':'local-only','baseUrl':'https://example.invalid/v1','model':'fixture-model'}))
ctx=web.build_context(state,root/'runs',root,csrf='fixture'); server=web.create_server(0,ctx); threading.Thread(target=server.serve_forever,daemon=True).start()
def request(path,data):
 c=http.client.HTTPConnection('127.0.0.1',server.server_port);c.request('POST',path,json.dumps(data),{'Content-Type':'application/json','X-CSRF-Token':'fixture'});r=c.getresponse();v=json.loads(r.read());c.close();assert r.status==200,(r.status,v);return v
try:
 pp=p['prepared']; token=composer_api._cache_prepared(ctx,str(root),pp['text'],pp['metadata'],pp['goal'])
 v=request('/api/sessions',{'task':'First goal','root':str(root),'prepared_token':token}); sid=v['id']
 token=composer_api._cache_prepared(ctx,str(root),'Second expanded prompt',pp['metadata'],True)
 request('/api/sessions/'+sid+'/messages',{'text':'Second goal','prepared_token':token})
 s=ctx['store'].load(sid); out={k:s.get(k) for k in ['task','status','model_selection','input_context','input_attachments','command_invocations','goal']};out['turns']=[m['content'] for m in s['messages'] if m['role']=='user']
finally:server.shutdown();server.server_close()
print(json.dumps(out))
`;
it("accepts trusted prepared create/send exactly as real Python HTTP with goal and command metadata", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-prepared-")), stateDir = join(root, "ts"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), cache = new Map([["a".repeat(32), prepared("First expanded prompt")], ["b".repeat(32), prepared("Second expanded prompt")]]);
    const o: PreparedInputOptions = { store, stateDir, webRuns: join(root, "runs"), enabled: () => true, resolveSelection: () => undefined,
      consumePrepared: async (token, boundRoot) => { assert.equal(boundRoot, root); const value = cache.get(token); if (!value) throw new PyValueError("prepared input invalid or expired"); cache.delete(token); return value; },
      applyGoal: (s, text) => { stageGoal(s, text, { enabled: () => true, replace: true, source: "composer" }); } };
    const s = await createAcceptedSession(o, { task: "First goal", root, prepared_token: "a".repeat(32) }, root);
    const lease = await store.lease(String(s.id)); try { await appendAcceptedTurn(o, s, "Second goal", { prepared_token: "b".repeat(32) }); } finally { await lease.release(); }
    const expected = JSON.parse(await runPythonAsync(oracle, JSON.stringify({ state: join(root, "python"), root, prepared: prepared("First expanded prompt") })));
    // TS goals follow ZCode and store no default round/time budget; frozen Python still stores 8 rounds / 600 s.
    const want = normalize(expected) as Row; if (isDict(want.goal)) want.goal = { ...want.goal, budget: {} };
    assert.deepEqual(normalize(project(s)), want);
    await assert.rejects(createAcceptedSession(o, { task: "Replay", prepared_token: "a".repeat(32), root }, root), /invalid or expired/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("requires durable media admission before creation and binds only trusted cached bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-prepared-media-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), media = new MediaArtifactStore(stateDir), draft = new Owner("draft", "fixture", root), bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const ref = await media.importBytes(draft, bytes, { name: "a.png", mimeType: "image/png", size: bytes.length }), p = prepared("Inspect cached image"); p.goal = false; p.metadata.media_refs = [ref]; p.media_sources = [{ owner: { kind: draft.kind, key: draft.key, root, session_id: null }, ids: [ref.id] }];
    const o: PreparedInputOptions = { store, stateDir, webRuns: join(root, "runs"), enabled: () => true, resolveSelection: () => undefined, consumePrepared: async () => structuredClone(p) };
    await assert.rejects(createAcceptedSession(o, { task: "Image", root, prepared_token: "a".repeat(32) }, root), /stable command envelope/); assert.equal((await store.list()).length, 0);
    const s = await createAcceptedSession(o, { task: "Image", root, prepared_token: "a".repeat(32) }, root, { id: `c_${Date.now()}_${"a".repeat(32)}`, fingerprint: "f".repeat(64) });
    const message = (s.messages as Row[])[1]!, owner = new Owner("message", message._message_id, root, String(s.id)); assert.deepEqual(await media.resolve(owner, ref.id), bytes); assert.deepEqual(message._media_refs, [ref]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("queued acceptance applies goal and slash expansion without rerunning trusted prepared text", async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-queued-prepared-"));
  try {
    const store = new SessionStore(root), s = await store.new("Initial", root); let expansions = 0;
    const o: PreparedInputOptions = { store, stateDir: root, webRuns: root, enabled: () => true,
      expandCommands: async () => { expansions++; return { text: "Expanded slash", invocation: { command: "fixture", args: "raw" } }; },
      applyGoal: (s, text) => { stageGoal(s, text, { enabled: () => true, replace: true, source: "composer" }); } };
    const lease = await store.lease(String(s.id));
    try { await appendAcceptedQueuedTurn(o, s, { id: "a".repeat(32), text: "/fixture raw" }); await appendAcceptedQueuedTurn(o, s, { id: "b".repeat(32), text: "Goal text", prepared: prepared("Already expanded") }); } finally { await lease.release(); }
    assert.equal(expansions, 1); assert.equal((s.goal as Row).text, "Goal text"); assert.equal(s.current_queue_item_id, "b".repeat(32)); assert.deepEqual((s.messages as Row[]).slice(-2).map((m) => m.content), ["Expanded slash", "Already expanded"]);
    assert.deepEqual(s.command_invocations, [{ command: "fixture", args: "raw" }, { command: "fixture", args: "hello" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
