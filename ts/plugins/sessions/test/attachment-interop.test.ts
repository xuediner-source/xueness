import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { normalizeError } from "@xueness/contracts";
import { createAttachmentsApi } from "../src/attachment-api.ts";
import { messageRevision } from "../src/journal-http.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { messageOwner } from "../src/media-history.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const oracle = `
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
p=json.load(sys.stdin);ctx=web.build_context(Path(p['state']),Path(p['root'])/'runs',Path(p['root']),csrf='fixture');s=web.create_server(0,ctx);threading.Thread(target=s.serve_forever,daemon=True).start()
try:
 c=http.client.HTTPConnection('127.0.0.1',s.server_port);c.request('POST','/api/composer/attachments/'+p['action'],json.dumps(p['data']),{'Content-Type':'application/json','X-CSRF-Token':'fixture'});r=c.getresponse();result=[r.status,json.loads(r.read())];c.close()
finally:s.shutdown();s.server_close()
print(json.dumps(result))
`;
async function fixture(fn: (f: { root: string; state: string; store: SessionStore; api: ReturnType<typeof createAttachmentsApi>; ts(action: string, data: Row): Promise<any>; py(action: string, data: Row): Promise<any> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "xueness-attachment-interop-")), state = join(root, "state"); mkdirSync(state);
  const store = new SessionStore(state), api = createAttachmentsApi({ stateDir: state, projectDir: root, webRuns: join(root, "runs"), store, enabled: () => true });
  try { await fn({ root, state, store, api, ts: async (action, data) => { const result = (await api.dispatch("POST", ["api", "composer", "attachments", action], {}, { root, ...data }))!; return [result[0], result[0] >= 400 ? normalizeError(result[0], result[1] as Row) : result[1]]; }, py: async (action, data) => JSON.parse(await runPythonAsync(oracle, JSON.stringify({ state, root, action, data: { root, ...data } }))) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const hash = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const declaration = (raw: Buffer, name = "a.png") => ({ origin: "file", name, mimeType: "image/png", size: raw.length, version: 1, uploadId: randomBytes(8).toString("hex"), draftId: "draft", totalChunks: Math.ceil(raw.length / 16), chunkBytes: 16, checksum: "sha256:" + hash(raw) });
it("resumes chunked durable uploads in either runtime and retries byte-identically after commit", { skip: pythonUnavailableReason() ?? false }, async () => fixture(async ({ ts, py }) => {
  for (const [start, finish] of [[ts, py], [py, ts]]) {
    const raw = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("cross runtime media data")]), data = declaration(raw);
    const begun = await start!("begin", data); assert.equal(begun[0], 200, JSON.stringify(begun)); const id = begun[1].ref.id;
    const first = { id, chunkIndex: 0, data: raw.subarray(0, 16).toString("base64") }; assert.equal((await start!("chunk", first))[0], 200);
    assert.deepEqual(await finish!("chunk", first), await start!("chunk", first));
    for (let i = 1; i < data.totalChunks; i++) assert.equal((await finish!("chunk", { id, chunkIndex: i, data: raw.subarray(i * 16, (i + 1) * 16).toString("base64") }))[0], 200);
    const committed = await finish!("commit", { id }); assert.equal(committed[0], 200, JSON.stringify(committed));
    assert.deepEqual(await start!("commit", { id }), committed); assert.deepEqual(await start!("preview", { id }), await finish!("preview", { id }));
    assert.equal((await start!("preview", { id }))[1].preview.data, raw.toString("base64"));
    assert.deepEqual(await finish!("chunk", first), await start!("chunk", first));
    assert.equal((await start!("release", { id }))[0], 200); assert.deepEqual(await finish!("release", { id }), [200, { ok: true }]);
  }
}));
it("matches Python validation, workspace reads, text preview and hardlink denial", { skip: pythonUnavailableReason() ?? false }, async () => fixture(async ({ root, ts, py, api }) => {
  const invalid: [string, Row][] = [["begin", {}], ["begin", { origin: "file", name: "../x", mimeType: "text/plain", size: 1 }], ["begin", { origin: "file", name: "x.txt", mimeType: "text/plain", size: -1 }], ["chunk", { chunkIndex: true, data: "" }], ["preview", { chunkIndex: -1 }], ["abort", { id: "bad" }], ["restore-epoch", {}], ["unknown", {}]];
  for (const [action, data] of invalid) assert.deepEqual(await ts(action, data), await py(action, data), action + JSON.stringify(data));
  writeFileSync(join(root, "note.txt"), "你好 attachment\n", "utf8");
  const begin = await ts("begin", { origin: "workspace", path: "note.txt" }); assert.equal(begin[0], 200, JSON.stringify(begin)); const id = begin[1].ref.id;
  assert.equal((await py("commit", { id }))[0], 200); assert.deepEqual(await ts("preview", { id }), await py("preview", { id }));
  const upload = await ts("begin", { origin: "paste", name: "text.txt", mimeType: "text/plain", size: 2 }); const uid = upload[1].ref.id;
  assert.equal((await py("commit", { id: uid, data: Buffer.from("ok").toString("base64") }))[0], 200);
  const scope = await api.files.scope(root, null), path = api.files.path(scope, uid, ".bin"); linkSync(path, join(root, "extra-link"));
  assert.deepEqual(await ts("preview", { id: uid }), await py("preview", { id: uid })); assert.equal((await ts("preview", { id: uid }))[0], 400);
}));
it("reads staged media status without changing or advancing the upload", async () => fixture(async ({ root, ts, api }) => {
  const declared = { origin: "file", name: "pending.png", mimeType: "image/png", size: 1, version: 1,
    uploadId: "upload-status", draftId: "draft-status", totalChunks: 1, chunkBytes: 16, checksum: "sha256:" + "0".repeat(64) };
  const begun = await ts("begin", declared);
  assert.equal(begun[0], 200, JSON.stringify(begun));
  const id = begun[1].ref.id, directory = await api.files.scope(root, null), path = api.files.path(directory, id);
  const before = readFileSync(path), entries = readdirSync(directory).sort();
  const status = await ts("status", { id });
  assert.equal(status[0], 200, JSON.stringify(status));
  assert.deepEqual(status[1], { ...begun[1], status: "pending", nextChunkIndex: 0, uploadedBytes: 0 });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(directory).sort(), entries);
}));
it("shares restore receipts, durable media ownership, cancellation and retired epochs with Python", { skip: pythonUnavailableReason() ?? false }, async () => fixture(async ({ root, state, store, ts, py }) => {
  const s = await store.new("Inspect image", root), message = (s.messages as Row[])[1]!, media = new MediaArtifactStore(state), bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
  message._media_refs = [await media.importBytes(messageOwner(s, message), bytes, { name: "saved.png", mimeType: "image/png", size: bytes.length })]; await store.save(s);
  const sid = String(s.id), epoch = await ts("restore-epoch", { session_id: sid }); assert.deepEqual(epoch, await py("restore-epoch", { session_id: sid }));
  const identity = { session_id: sid, messageIndex: 1, revision: messageRevision(s), restoreId: randomBytes(16).toString("hex"), restoreEpoch: epoch[1].restoreEpoch };
  const restored = await ts("restore", identity); assert.equal(restored[0], 200, JSON.stringify(restored)); assert.equal(restored[1].refs.length, 1);
  assert.deepEqual(await py("restore", identity), restored); assert.deepEqual(await ts("restore-status", identity), await py("restore-status", identity));
  const id = restored[1].refs[0].id; assert.deepEqual(await ts("preview", { session_id: sid, id }), await py("preview", { session_id: sid, id }));
  assert.deepEqual(await py("restore-abort", identity), await ts("restore-abort", identity));
  assert.equal((await ts("restore", identity))[0], 409); assert.equal((await ts("restore-epoch", { session_id: sid }))[1].restoreEpoch, 1);
  assert.deepEqual(await ts("restore-status", identity), await py("restore-status", identity)); assert.deepEqual(await media.resolve(messageOwner(s, message), message._media_refs[0].id), bytes);
  const cancelled = { ...identity, restoreId: randomBytes(16).toString("hex"), restoreEpoch: 1 };
  assert.equal((await py("restore-abort", cancelled))[0], 200); assert.equal((await ts("restore", cancelled))[0], 409);
}));
