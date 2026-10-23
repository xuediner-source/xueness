import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { modelDeltaPage } from "../src/live-api.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import type { LifecycleOptions } from "../src/lifecycle-types.ts";
type Row = Record<string, any>;
const options = (store: SessionStore, root: string, stateDir: string) => { const lifecycle: LifecycleOptions = { store, stateDir, enabled: () => true, approvals: new Map(), activeContext: new Map(), running: new Set(), allowReal: false, resolveProvider: () => { throw new Error(); }, createRunner: () => { throw new Error(); } }; return { store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true, lifecycle }; };
const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)])) : typeof v === "string" ? /^[0-9a-f]{32}$|^[0-9a-f]{64}$|^sha256:[0-9a-f]{64}$/.test(v) ? "(opaque)" : /^[0-9a-f]{16}\.[0-9]+$/.test(v) ? "(watch cursor)" : v : v;
const oracle = `
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
p=json.load(sys.stdin);ctx=web.build_context(Path(p['state']),Path(p['root'])/'runs',Path(p['root']),csrf='fixture');server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start();out=[]
def request(method,path,data={}):
 c=http.client.HTTPConnection('127.0.0.1',server.server_port);c.request(method,path,json.dumps(data),{'Content-Type':'application/json','X-CSRF-Token':'fixture'});r=c.getresponse();v=json.loads(r.read());out.append([r.status,v]);c.close();return v
try:
 path='/api/sessions/'+p['sid'];a=request('GET',path+'/conversation-transport');base='?logEpoch='+a['logEpoch']+'&seq='+str(a['seq'])
 request('GET',path+'/conversation-transport'+base);request('POST',path+'/messages',{'text':'Next turn'})
 b=request('GET',path+'/conversation-transport'+base)
 request('GET','/api/sessions/conversation-transport/watch?client=fixture123&topic='+p['sid']+'.'+b['logEpoch']+'.'+str(b['seq'])+'&wait=0')
 request('GET','/api/sessions/conversation-transport/watch?client=fixture123&topic='+'b'*32+'&wait=0')
 request('GET',path+'/conversation-transport?seq=0')
finally:server.shutdown();server.server_close()
print(json.dumps(out))
`;
it("matches real Python HTTP snapshot/resume frames and multiplexed watch behavior", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-transport-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("Initial", root, { sessionId: "a".repeat(32) }); cpSync(stateDir, pyState, { recursive: true });
    const expected = JSON.parse(await runPythonAsync(oracle, JSON.stringify({ state: pyState, root, sid: s.id }))), api = createSessionsApi(options(store, root, stateDir)), actual: unknown[] = [];
    const call = async (method: string, path: string, data: Row = {}): Promise<Row> => { const url = new URL(path, "http://local"), query: Row = {}; for (const [k, v] of url.searchParams) (query[k] ??= []).push(v); const result = await api.dispatch(method, url.pathname.split("/").filter(Boolean), query, data); assert.ok(result); actual.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); return result[1] as Row; };
    const path = `/api/sessions/${s.id}`, first = await call("GET", path + "/conversation-transport"), base = `?logEpoch=${first.logEpoch}&seq=${first.seq}`;
    await call("GET", path + "/conversation-transport" + base); await call("POST", path + "/messages", { text: "Next turn" }); const next = await call("GET", path + "/conversation-transport" + base);
    await call("GET", `/api/sessions/conversation-transport/watch?client=fixture123&topic=${s.id}.${next.logEpoch}.${next.seq}&wait=0`);
    await call("GET", "/api/sessions/conversation-transport/watch?client=fixture123&topic=" + "b".repeat(32) + "&wait=0"); await call("GET", path + "/conversation-transport?seq=0");
    assert.deepEqual(normalize(actual), normalize(expected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("streams exact completed model offsets and stops live snapshot generation on cancellation", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-live-stream-")), stateDir = join(root, "ts"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("Initial", root, { sessionId: "a".repeat(32) }); s.status = "completed"; s.stream_history = [{ id: "c".repeat(32), text: "😀".repeat(9000), status: "completed", truncated: true }]; await store.save(s);
    const api = createSessionsApi(options(store, root, stateDir)), reply = await api.dispatch("GET", ["api", "sessions", String(s.id), "deltas"], {}, {}, { accept: "text/event-stream" }); assert.ok(reply); const chunks: Buffer[] = [];
    for await (const value of reply[1] as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(value));
    const expected = JSON.parse(await runPythonAsync(`import json,sys\nfrom xueness.bundled_plugins.sessions.deltas import page\np=json.load(sys.stdin);s=p['s'];cursor=0;sid='';out=[]\nwhile True:\n r=page(s,sid,cursor);out.append('id: '+r['streamId']+':'+str(r['nextCursor'])+'\\nevent: model.delta\\ndata: '+json.dumps(r,ensure_ascii=False)+'\\n\\n');sid=r['streamId'];cursor=r['nextCursor']\n if r['done']:break\nprint(json.dumps(''.join(out)))`, JSON.stringify({ s })));
    assert.equal(Buffer.concat(chunks).toString("utf8"), expected); assert.equal(modelDeltaPage(s, "c".repeat(32), 4096).nextCursor, 8192);
    const abort = new AbortController(), updates = await api.dispatch("GET", ["api", "sessions", String(s.id), "updates"], {}, {}, { accept: "text/event-stream", signal: abort.signal }); assert.ok(updates); const iterator = (updates[1] as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const first = await iterator.next(); assert.match(Buffer.from(first.value!).toString("utf8"), /event: conversation.snapshot/);
    (s.messages as Row[]).push({ role: "assistant", content: "New answer" }); await store.save(s); const patch = await iterator.next(); assert.match(Buffer.from(patch.value!).toString("utf8"), /event: conversation.patch/);
    abort.abort(); assert.equal((await iterator.next()).done, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
