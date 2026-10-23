import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "createdAt" ? "(created)" : normalize(x)])) : typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? "(id)" : typeof v === "string" && /^\/share\/[0-9a-f]{32}$/.test(v) ? "/share/(id)" : v;
const oracle = `
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
p=json.load(sys.stdin);ctx=web.build_context(Path(p['state']),Path(p['root'])/'runs',Path(p['root']),csrf='fixture');server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start();out=[]
def request(method,path,data={}):
 c=http.client.HTTPConnection('127.0.0.1',server.server_port);c.request(method,path,json.dumps(data),{'Content-Type':'application/json','X-CSRF-Token':'fixture'});r=c.getresponse();v=json.loads(r.read());out.append([r.status,v]);c.close();return v
try:
 path='/api/sessions/'+p['sid']+'/share';preview=request('GET',path)
 request('POST',path,{'expected_revision':'sha256:'+'0'*64})
 request('POST',path,{'expected_revision':preview['message_revision'],'forged':True})
 published=request('POST',path,{'expected_revision':preview['message_revision'],'turn_ids':['turn-2'],'title':'共享记录'})
 share='/api/conversation_shares/'+published['id'];request('GET',share)
 request('POST',share+'/import',{'root':p['root'],'title':'Imported','forged':True})
 imported=request('POST',share+'/import',{'root':p['root'],'title':'Imported'})
 s=ctx['store'].load(imported['id']);result={k:s.get(k) for k in ['task','title','title_source','status','root','results','pending_question','imported_share']};result['messages']=[{'role':m['role'],'content':m['content']} for m in s['messages']]
 request('DELETE',share);request('GET',share)
finally:server.shutdown();server.server_close()
print(json.dumps({'responses':out,'imported':result}))
`;
it("matches actual Python HTTP selected-turn publishing, clean import and revocation", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-sharing-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("First task", root, { sessionId: "a".repeat(32) });
    (s.messages as Row[]).push({ role: "assistant", content: "First answer" }, { role: "user", content: "Second task" }, { role: "assistant", content: "Second answer" }); s.status = "completed"; s.results = { secret: { ok: true, data: "Never imported" } }; await store.save(s); cpSync(stateDir, pyState, { recursive: true });
    const expected = JSON.parse(await runPythonAsync(oracle, JSON.stringify({ root, state: pyState, sid: s.id }))), api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true }), responses: unknown[] = [];
    const call = async (method: string, path: string, data: Row = {}): Promise<Row> => { const result = await api.dispatch(method, path.split("/").filter(Boolean), {}, data); assert.ok(result); responses.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); return result[1] as Row; };
    const path = `/api/sessions/${s.id}/share`, preview = await call("GET", path);
    await call("POST", path, { expected_revision: "sha256:" + "0".repeat(64) }); await call("POST", path, { expected_revision: preview.message_revision, forged: true });
    const published = await call("POST", path, { expected_revision: preview.message_revision, turn_ids: ["turn-2"], title: "共享记录" }), share = "/api/conversation_shares/" + published.id; await call("GET", share);
    await call("POST", share + "/import", { root, title: "Imported", forged: true }); const imported = await call("POST", share + "/import", { root, title: "Imported" }), importedSession = await store.load(imported.id), projection: Row = Object.fromEntries(["task", "title", "title_source", "status", "root", "results", "pending_question", "imported_share"].map((k) => [k, importedSession[k] ?? null]));
    projection.messages = (importedSession.messages as Row[]).map((m) => ({ role: m.role, content: m.content })); await call("DELETE", share); await call("GET", share);
    assert.deepEqual(normalize({ responses, imported: projection }), normalize(expected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
