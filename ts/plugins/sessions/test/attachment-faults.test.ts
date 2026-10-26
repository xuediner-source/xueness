import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NativeFileLocks, SessionStore } from "@xueness/sessions";
import { createAttachmentsApi } from "../src/attachment-api.ts";
import { digest, type AttachmentRow as Row } from "../src/attachment-types.ts";
import { RestoreReceipts, restoreIdentity } from "../src/attachment-receipts.ts";
import { messageRevision } from "../src/journal-http.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { messageOwner } from "../src/media-history.ts";
import { Owner } from "../src/media-owner.ts";
import { PROJECT_ROOT, PYTHON, pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xueness-attachment-fault-")), stateDir = join(root, "state"), store = new SessionStore(stateDir);
  const api = createAttachmentsApi({ stateDir, store, projectDir: root, webRuns: join(root, "runs"), enabled: () => true });
  const call = async (action: string, data: Row) => (await api.dispatch("POST", ["api", "composer", "attachments", action], {}, { root, ...data }))! as [number, Row];
  const declaration = (raw = image) => ({ origin: "file", name: "image.png", mimeType: "image/png", size: raw.length, version: 1, uploadId: "upload", draftId: "draft", totalChunks: 1, chunkBytes: raw.length, checksum: "sha256:" + digest(raw) });
  return { root, stateDir, store, api, call, declaration, close: () => rmSync(root, { recursive: true, force: true }) };
}
async function restoredFixture(f: ReturnType<typeof fixture>) {
  const s = await f.store.new("original prompt", f.root), message = (s.messages as Row[])[1]!, media = new MediaArtifactStore(f.stateDir);
  message._media_refs = [await media.importBytes(messageOwner(s, message), image, { name: "saved.png", mimeType: "image/png", size: image.length })]; await f.store.save(s);
  const body = { session_id: s.id, messageIndex: 1, revision: messageRevision(s), restoreId: "a".repeat(32), restoreEpoch: 0 };
  return { s, message, media, body };
}
describe("attachment crash recovery and filesystem boundaries", () => {
  it("adopts an unacknowledged chunk only on an exact retry after metadata failure", async () => {
    const f = fixture();
    try {
      const begun = await f.call("begin", f.declaration()); assert.equal(begun[0], 200); const id = begun[1].ref.id, directory = await f.api.files.scope(f.root, null), path = f.api.files.path(directory, id), before = readFileSync(path);
      const write = f.api.files.writeJson.bind(f.api.files); let fail = true;
      f.api.files.writeJson = (target, record) => { if (target === path && record.nextChunkIndex === 1 && fail) { fail = false; throw new Error("metadata unavailable"); } write(target, record); };
      assert.equal((await f.call("chunk", { id, chunkIndex: 0, data: image.toString("base64") }))[0], 400);
      assert.deepEqual(readFileSync(path), before); assert.deepEqual(readFileSync(f.api.files.path(directory, id, ".0.chunk")), image);
      assert.equal((await f.call("chunk", { id, chunkIndex: 0, data: Buffer.alloc(image.length).toString("base64") }))[0], 409);
      const recovered = await f.call("chunk", { id, chunkIndex: 0, data: image.toString("base64") }); assert.equal(recovered[0], 200); assert.equal(recovered[1].uploadedBytes, image.length);
      assert.equal((await f.call("commit", { id }))[0], 200); assert.equal((await f.call("preview", { id }))[1].preview.data, image.toString("base64"));
    } finally { f.close(); }
  });
  it("recovers one imported artifact after commit publication fails without duplicating media", async () => {
    const f = fixture();
    try {
      const id = (await f.call("begin", f.declaration()))[1].ref.id; await f.call("chunk", { id, chunkIndex: 0, data: image.toString("base64") });
      const write = f.api.files.writeJson.bind(f.api.files); let fail = true;
      f.api.files.writeJson = (target, record) => { if (record.id === id && record.status === "committed" && fail) { fail = false; throw new Error("publication failure"); } write(target, record); };
      assert.equal((await f.call("commit", { id }))[0], 400);
      const media = new MediaArtifactStore(f.stateDir), owner = new Owner("draft", id, f.root), prior = await media.listOwned(owner); assert.equal(prior.length, 1);
      assert.equal((await f.call("commit", { id }))[0], 200); assert.deepEqual(await media.listOwned(owner), prior);
      assert.deepEqual(await media.resolve(owner, prior[0]!.id), image);
    } finally { f.close(); }
  });
  it("retains complete restore allocation after adoption failure and aborts only its draft owners", async () => {
    const f = fixture();
    try {
      const { s, message, media, body } = await restoredFixture(f), write = f.api.files.writeJson.bind(f.api.files); let fail = true;
      f.api.files.writeJson = (path, record) => { if (record.restoreId === body.restoreId && record.artifact && record.status === "committed" && fail) { fail = false; throw new Error("after adoption, before metadata commit"); } write(path, record); };
      assert.equal((await f.call("restore", body))[0], 400);
      const status = await f.call("restore-status", body); assert.equal(status[0], 200); assert.equal(status[1].status, "preparing");
      const directory = await f.api.files.scope(f.root, String(s.id)), receipts = new RestoreReceipts(f.api.files, directory), record = receipts.load(restoreIdentity(f.root, String(s.id), body))!, id = record.refs[0];
      assert.equal(record.refs.length, 1); assert.equal((await media.listOwned(new Owner("draft", id, f.root, String(s.id)))).length, 1);
      assert.equal((await f.call("restore", body))[0], 409);
      const aborted = await f.call("restore-abort", body); assert.equal(aborted[1].cleanupComplete, true);
      assert.equal(existsSync(f.api.files.path(directory, id)), false); assert.equal((await media.listOwned(new Owner("draft", id, f.root, String(s.id)))).length, 0);
      assert.deepEqual(await media.resolve(messageOwner(s, message), message._media_refs[0].id), image);
    } finally { f.close(); }
  });
  it("replays an already-committed restore after the acknowledgement write reports failure", async () => {
    const f = fixture();
    try {
      const { body } = await restoredFixture(f), write = f.api.files.writeJson.bind(f.api.files); let fail = true;
      f.api.files.writeJson = (path, record) => { write(path, record); if (path.includes("composer-restore-receipts") && record.status === "committed" && fail) { fail = false; throw new Error("lost response after durable receipt"); } };
      assert.equal((await f.call("restore", body))[0], 400);
      const status = await f.call("restore-status", body); assert.equal(status[1].status, "committed");
      const retry = await f.call("restore", body); assert.equal(retry[0], 200); assert.deepEqual(retry[1], status[1].result);
      const scope = await f.api.files.scope(f.root, String(body.session_id)); assert.equal(readdirSync(scope).filter((name) => name.endsWith(".json")).length, 1);
    } finally { f.close(); }
  });
  it("does not adopt media when restore allocation directory durability cannot be confirmed", async () => {
    const f = fixture();
    try {
      const { s, message, media, body } = await restoredFixture(f); assert.equal((await f.call("restore-epoch", { session_id: s.id }))[0], 200);
      const sync = f.api.files.syncDirectory.bind(f.api.files); let fail = true;
      f.api.files.syncDirectory = (path) => { if (path.includes("composer-restore-receipts") && path.endsWith("s" + s.id) && fail) { fail = false; throw new Error("directory fsync failed"); } sync(path); };
      assert.equal((await f.call("restore", body))[0], 400);
      const scope = await f.api.files.scope(f.root, String(s.id)), receipts = new RestoreReceipts(f.api.files, scope), saved = receipts.load(restoreIdentity(f.root, String(s.id), body))!;
      assert.equal(saved.status, "preparing"); assert.equal(saved.refs.length, 1);
      assert.equal((await media.listOwned(new Owner("draft", saved.refs[0], f.root, String(s.id)))).length, 0);
      assert.deepEqual(await media.resolve(messageOwner(s, message), message._media_refs[0].id), image);
      assert.equal((await f.call("restore-abort", body))[1].cleanupComplete, true);
    } finally { f.close(); }
  });
  it("rejects a corrupt restore receipt without reallocating or overwriting the durable identity", async () => {
    const f = fixture();
    try {
      const { body } = await restoredFixture(f); assert.equal((await f.call("restore", body))[0], 200);
      const scope = await f.api.files.scope(f.root, String(body.session_id)), receipts = new RestoreReceipts(f.api.files, scope), path = receipts.path(restoreIdentity(f.root, String(body.session_id), body));
      writeFileSync(path, "null"); const before = readdirSync(scope);
      assert.equal((await f.call("restore", body))[0], 409); assert.equal(readFileSync(path, "utf8"), "null"); assert.deepEqual(readdirSync(scope), before);
    } finally { f.close(); }
  });
  it("waits for another process's transaction lease before applying attachment directory ACLs", async () => {
    const f = fixture(), other = new NativeFileLocks();
    try {
      const held = await other.tryAcquire(join(f.stateDir, ".composer-attachment-locks"), "transactions.lock");
      const base = f.api.files.base.bind(f.api.files); let protections = 0; f.api.files.base = () => { protections++; return base(); };
      const pending = f.api.files.transaction(async () => "entered");
      try { await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(protections, 0); }
      finally { await held.release(); }
      assert.equal(await pending, "entered"); assert.equal(protections, 1);
    } finally { await other.close(); f.close(); }
  });
  it("reads bounded matching session snapshots without repairing a corrupt journal from backup", async () => {
    const f = fixture();
    try {
      const s = await f.store.new("snapshot", f.root); await f.store.save(s); const path = f.store.pathFor(s.id);
      assert.equal(existsSync(path + ".bak"), true); writeFileSync(path, "{");
      assert.equal((await f.call("restore-epoch", { session_id: s.id }))[0], 404); assert.equal(readFileSync(path, "utf8"), "{");
      writeFileSync(path, JSON.stringify({ ...s, id: "b".repeat(32) }));
      assert.equal((await f.call("restore-epoch", { session_id: s.id }))[0], 404);
      writeFileSync(path, JSON.stringify({ ...s, messages: [{ role: "user", content: "x".repeat(8 * 1024 * 1024) }] }));
      assert.equal((await f.call("restore-epoch", { session_id: s.id }))[0], 404);
    } finally { f.close(); }
  });
  it("rejects redirected workspace/staging directories and hardlinked metadata without touching their targets", async () => {
    const f = fixture(), outside = mkdtempSync(join(tmpdir(), "xueness-attachment-outside-"));
    try {
      writeFileSync(join(outside, "private.txt"), "private outside workspace");
      symlinkSync(outside, join(f.root, "redirect"), process.platform === "win32" ? "junction" : "dir");
      assert.equal((await f.call("begin", { origin: "workspace", path: "redirect/private.txt" }))[0], 400);
      const begun = await f.call("begin", f.declaration()), id = begun[1].ref.id, scope = await f.api.files.scope(f.root, null), path = f.api.files.path(scope, id);
      const bytes = readFileSync(path); linkSync(path, join(outside, "metadata-hardlink"));
      assert.equal((await f.call("chunk", { id, chunkIndex: 0, data: image.toString("base64") }))[0], 400); assert.deepEqual(readFileSync(path), bytes);
      assert.equal(existsSync(f.api.files.path(scope, id, ".0.chunk")), false);
      rmSync(join(f.stateDir, "composer-attachments"), { recursive: true, force: true });
      symlinkSync(outside, join(f.stateDir, "composer-attachments"), process.platform === "win32" ? "junction" : "dir");
      const before = readdirSync(outside); assert.equal((await f.call("begin", f.declaration()))[0], 400); assert.deepEqual(readdirSync(outside), before);
      assert.equal(readFileSync(join(outside, "private.txt"), "utf8"), "private outside workspace");
    } finally { f.close(); rmSync(outside, { recursive: true, force: true }); }
  });
  it("matches Python nullable declaration and Unicode protected-directory refusals", { skip: pythonUnavailableReason() ?? false }, async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, ".ſtate")); writeFileSync(join(f.root, ".ſtate", "private.txt"), "protected"); writeFileSync(join(f.root, "public.txt"), "public");
      const cases = [{ root: f.root, ...f.declaration(), version: null }, { root: f.root, origin: "workspace", path: "public.txt", name: null }, { root: f.root, origin: "workspace", path: ".ſtate/private.txt" }], actual = [];
      for (const data of cases) actual.push(await f.call("begin", data));
      const expected = JSON.parse(await runPythonAsync(`
import json,sys
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.sessions.composer_attachments import dispatch
d=json.load(sys.stdin);ctx=web.build_context(Path(d['state']),Path(d['root'])/'runs',Path(d['root']),allow_real=False)
print(json.dumps([dispatch('POST',['api','composer','attachments','begin'],{},data,ctx) for data in d['cases']]))
`, JSON.stringify({ state: f.stateDir, root: f.root, cases })));
      assert.deepEqual(actual, expected); assert(actual.every((reply) => reply[0] === 400));
    } finally { f.close(); }
  });
});
