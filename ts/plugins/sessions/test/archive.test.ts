import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { Owner } from "../src/media-owner.ts";
import { markViewed } from "../src/read-state.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const oracle = `
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
p=json.load(sys.stdin); sid=p['sid']; ctx=web.build_context(Path(p['state']),Path(p['root'])/'runs',Path(p['root']),csrf='fixture')
server=web.create_server(0,ctx); threading.Thread(target=server.serve_forever,daemon=True).start()
out=[]
def request(method,path,data={}):
 c=http.client.HTTPConnection('127.0.0.1',server.server_port); c.request(method,path,json.dumps(data),{'Content-Type':'application/json','X-CSRF-Token':'fixture'}); r=c.getresponse(); v=json.loads(r.read()); c.close(); out.append([r.status,v]); return v
try:
 path='/api/sessions/'+sid
 request('DELETE',path)
 rows=request('GET','/api/sessions/archived'); revision=rows['sessions'][0]['revision']
 request('DELETE','/api/sessions/archived/'+sid,{'confirmed':True,'expectedRevision':'0'*64})
 request('POST',path+'/restore')
 request('DELETE',path)
 rows=request('GET','/api/sessions/archived'); revision=rows['sessions'][0]['revision']
 request('DELETE','/api/sessions/archived/'+sid,{'confirmed':False,'expectedRevision':revision})
 request('DELETE','/api/sessions/archived/'+sid,{'confirmed':True,'expectedRevision':revision})
 request('GET','/api/sessions/archived')
 request('DELETE','/api/sessions/archived/'+sid,{'confirmed':True,'expectedRevision':revision})
finally: server.shutdown();server.server_close()
print(json.dumps(out))
`;
const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ["archivedAt", "revision"].includes(k) ? "(dynamic)" : normalize(x)])) : v;
it("archives, restores and permanently deletes with Python HTTP confirmation and revision semantics", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-archive-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("Archive me", root, { sessionId: "a".repeat(32) });
    const media = new MediaArtifactStore(stateDir), message = (s.messages as Row[])[1]!;
    const owner = new Owner("message", message._message_id, root, String(s.id)), retained = new Owner("fork", "other", root, "b".repeat(32));
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex"), ref = await media.importBytes(owner, bytes, { name: "a.png", mimeType: "image/png", size: bytes.length });
    await media.adopt(owner, retained, [ref.id]); message._media_refs = [ref]; await store.save(s);
    const before = readFileSync(store.pathFor(String(s.id))), mtime = statSync(store.pathFor(String(s.id)), { bigint: true }).mtimeNs;
    await markViewed(store, String(s.id)); assert.deepEqual(readFileSync(store.pathFor(String(s.id))), before); assert.equal(statSync(store.pathFor(String(s.id)), { bigint: true }).mtimeNs, mtime);
    cpSync(stateDir, pyState, { recursive: true });
    const expected = JSON.parse(await runPythonAsync(oracle, JSON.stringify({ root, state: pyState, sid: s.id })));
    const api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true }), actual: unknown[] = [], path = `/api/sessions/${s.id}`;
    const request = async (method: string, path: string, data: Row = {}): Promise<Row> => { const result = await api.dispatch(method, path.split("/").filter(Boolean), {}, data); assert.ok(result); actual.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); return result[1] as Row; };
    await request("DELETE", path); let rows = await request("GET", "/api/sessions/archived"), revision = rows.sessions[0].revision;
    await request("DELETE", `/api/sessions/archived/${s.id}`, { confirmed: true, expectedRevision: "0".repeat(64) });
    await request("POST", path + "/restore"); await request("DELETE", path);
    rows = await request("GET", "/api/sessions/archived"); revision = rows.sessions[0].revision;
    await request("DELETE", `/api/sessions/archived/${s.id}`, { confirmed: false, expectedRevision: revision });
    await request("DELETE", `/api/sessions/archived/${s.id}`, { confirmed: true, expectedRevision: revision });
    await request("GET", "/api/sessions/archived"); await request("DELETE", `/api/sessions/archived/${s.id}`, { confirmed: true, expectedRevision: revision });
    assert.deepEqual(normalize(actual), normalize(expected));
    assert.equal(existsSync(store.pathFor(String(s.id))), false); assert.deepEqual(await media.listOwned(owner), []); assert.deepEqual(await media.resolve(retained, ref.id), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
