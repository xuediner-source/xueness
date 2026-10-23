import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { isDict, pyJsonDumps } from "@xueness/contracts";
import { openAiMessages } from "@xueness/providers";
import { SessionStore } from "@xueness/sessions";
import { bindMediaPrompt } from "../src/media-binding.ts";
import { Owner } from "../src/media-owner.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { pythonUnavailableReason, runPython, PROJECT_ROOT } from "../../../test-support/python-oracle.ts";
const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
const oracle = `
import base64, io, json, sys
from xueness.bundled_plugins.sessions.media_artifacts import MediaArtifactStore
from xueness.bundled_plugins.sessions.media_ownership import Owner
from xueness.bundled_plugins.providers.media_input import bind_prompt
from xueness.bundled_plugins.providers.provider import _openai_messages
p=json.load(sys.stdin); store=MediaArtifactStore(p['state']); o=Owner(**p['owner'])
if p['action']=='import': out=store.import_stream(o,io.BytesIO(base64.b64decode(p['data'])),name='fixture.png',mime_type='image/png',size=len(base64.b64decode(p['data'])))
elif p['action']=='resolve': out=base64.b64encode(store.resolve(o,p['id'])).decode()
elif p['action']=='adopt': out=store.adopt(o,Owner(**p['target']),p['ids'])
elif p['action']=='describe': out=store.describe(o,p['id'])
elif p['action']=='bind':
 class Provider: capabilities={'image'}
 session=p['session']
 with bind_prompt(p['state'],session,session['messages']) as wire: out=_openai_messages(wire,Provider())
elif p['action']=='reconcile': out=store.reconcile()
print(json.dumps(out))
`;
const ownerValue = (o: Owner) => ({ kind: o.kind, key: o.key, root: o.root, session_id: o.sessionId });
describe("durable media and invocation authority", () => {
  it("roundtrips blobs, owners and provider bodies with the real Python store", { skip: pythonUnavailableReason() ?? false }, async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-media-"));
    try {
      const store = new MediaArtifactStore(root), owner = new Owner("draft", "draft-1", root);
      const ref = await store.importBytes(owner, PNG, { name: "fixture.png", mimeType: "image/png", size: PNG.length });
      const call = (action: string, rest = {}) => JSON.parse(runPython(oracle, JSON.stringify({ action, state: root, owner: ownerValue(owner), ...rest })));
      assert.equal(call("resolve", { id: ref.id }), PNG.toString("base64"));
      assert.deepEqual(call("describe", { id: ref.id }), ref);
      const imported = call("import", { data: PNG.toString("base64") });
      assert.deepEqual(await store.resolve(owner, imported.id), PNG);
      const journals = new SessionStore(join(root, "sessions"));
      const session = await journals.new("Inspect image", root);
      const message = (session.messages as Record<string, unknown>[])[1]!;
      const accepted = new Owner("message", String(message._message_id), root, String(session.id));
      call("adopt", { target: ownerValue(accepted), ids: [ref.id] });
      message._media_refs = [ref]; await journals.save(session);
      const pythonBody = call("bind", { session });
      const binding = await bindMediaPrompt(store, session, session.messages as Record<string, unknown>[], () => true);
      try { assert.deepEqual(openAiMessages(binding.messages, { capabilities: new Set(["image"]) }, binding.media), pythonBody); }
      finally { await binding.release(); }
      assert.throws(() => openAiMessages(binding.messages, { capabilities: new Set(["image"]) }), /authorized invocation/);
      assert.deepEqual(await store.listOwned(accepted), [ref]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("never authorizes a forged journal object and releases pins on failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-media-scope-"));
    try {
      const store = new MediaArtifactStore(root), owner = new Owner("message", "m1", root, "a".repeat(32));
      const ref = await store.importBytes(owner, PNG, { name: "fixture.png", mimeType: "image/png", size: PNG.length });
      const message = { role: "user", content: "image", _message_id: "m1", _media_refs: [ref] };
      const session = { id: owner.sessionId, root, messages: [message] };
      await assert.rejects(bindMediaPrompt(store, session, [{ ...message }], () => true), /accepted journal member/);
      const binding = await bindMediaPrompt(store, session, [message], () => true);
      assert.throws(() => openAiMessages(binding.messages, { capabilities: new Set() }, binding.media), /image input support/);
      await binding.release();
      assert.throws(() => openAiMessages(binding.messages, { capabilities: new Set(["image"]) }, binding.media), /authorized invocation/);
      const other = new Owner("message", "m1", root, "b".repeat(32));
      await assert.rejects(store.resolve(other, ref.id), /unavailable in this scope/);
      await store.release(owner);
      assert.equal((await store.reconcile()).retainedArtifacts, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reserves immutable command bindings and finalizes without replaying media", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-media-admission-"));
    try {
      const store = new MediaArtifactStore(root), draft = new Owner("draft", "draft", root), destination = new Owner("message", "destination", root, "a".repeat(32)), target = new Owner("message", "m1", root, "a".repeat(32));
      const ref = await store.importBytes(draft, PNG, { name: "fixture.png", mimeType: "image/png", size: PNG.length });
      const admission = await store.reserveAdmission("command", destination, [[draft, [ref.id]]], "fingerprint");
      assert.equal((await store.reserveAdmission("command", destination, [[draft, [ref.id]]], "fingerprint")).token(), admission.token());
      await assert.rejects(store.reserveAdmission("command", destination, [[draft, [ref.id]]], "changed"), /conflicting media admission/);
      await store.release(draft);
      assert.deepEqual(await store.finalizeAdmission("command", destination, target), [ref]);
      assert.deepEqual(await store.finalizeAdmission("command", destination, target), [ref]);
      await assert.rejects(store.finalizeAdmission("command", destination, new Owner("message", "m2", root, destination.sessionId)), /conflicting media finalization/);
      assert.deepEqual(await store.resolve(target, ref.id), PNG);
      writeFileSync(join(store.blobs, ref.id + ".bin"), Buffer.from("tampered"));
      await assert.rejects(store.resolve(target, ref.id), /integrity check failed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
