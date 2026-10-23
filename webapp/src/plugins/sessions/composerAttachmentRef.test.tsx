import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, persistDraft, readPersistedDraft, restoredDraft, type ComposerDraftState } from "./XuenessWorkbenchView";
import {
  attachmentPayloadForSend, attachmentRefFromLocalFile, attachmentsFromRefs, commitUploadedAttachment,
  commitWorkspaceAttachment, editorAttachmentRefs, isBoundedWorkspacePath, parseAttachmentRef,
  type AttachmentRef, type ComposerAttachment,
} from "./composerAttachmentRef";

const draft = (text: string, attachments: ComposerAttachment[] = []): ComposerDraftState => ({
  text, goal: false, attachments, selectedCapabilities: [],
  selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
  submissionError: "", attachmentError: "", revision: 1,
});

const token = (digit: string): string => digit.repeat(32);

function committed(id: string, origin: AttachmentRef["origin"] = "paste", name = "shot.png"): ComposerAttachment {
  const ref: AttachmentRef = {
    id, token: id, name, mimeType: "image/png", size: 4, origin, source: "upload",
  };
  return { name, mimeType: "image/png", data: "", ref };
}

test("file select, paste and drop share one attachment ref shape", () => {
  const file = { name: "dir/shot.png", type: "image/png", size: 12 };
  const refs = (["file", "paste", "drop"] as const).map(origin => attachmentRefFromLocalFile(file, origin, "local-1"));
  assert.deepEqual(refs.map(ref => ref.origin), ["file", "paste", "drop"]);
  assert.deepEqual(refs.map(ref => ref.name), ["shot.png", "shot.png", "shot.png"]);
  assert.deepEqual(refs.map(ref => ref.mimeType), ["image/png", "image/png", "image/png"]);
  assert.deepEqual(refs.map(ref => ref.size), [12, 12, 12]);
  assert.equal("data" in refs[0], false);
  assert.equal(parseAttachmentRef(refs[0]), null);
});

test("workspace paths that leave the root are rejected before any request", async () => {
  assert.equal(isBoundedWorkspacePath("src/note.txt"), true);
  assert.equal(isBoundedWorkspacePath("../secret"), false);
  assert.equal(isBoundedWorkspacePath("/etc/passwd"), false);
  assert.equal(isBoundedWorkspacePath("C:/secret"), false);
  assert.equal(isBoundedWorkspacePath("note/../../secret"), false);
  await assert.rejects(commitWorkspaceAttachment({ root: "/ws", path: "../secret" }), /workspace file unavailable/);
});

test("rich send keeps committed ids and the textarea path keeps inline bytes", () => {
  const id = token("a");
  const attachments = [committed(id, "drop"), { name: "local.txt", mimeType: "text/plain", data: "LOCAL_BYTES" }];
  const rich = attachmentPayloadForSend(attachments, true);
  assert.deepEqual(rich.attachmentRefs, [{ id }]);
  assert.deepEqual(rich.attachments, [{ name: "local.txt", mimeType: "text/plain", data: "LOCAL_BYTES" }]);
  const plain = attachmentPayloadForSend(attachments, false);
  assert.equal(plain.attachmentRefs, undefined);
  assert.equal(plain.attachments[0].data, "");
  assert.equal(plain.attachments[1].data, "LOCAL_BYTES");
});

test("session drafts restore attachment refs and still refuse to store bytes", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const first = token("b");
  const second = token("c");
  persistDraft("ws", "session:one", draft("keep one", [committed(first, "file", "one.png")]), storage);
  persistDraft("ws", "session:two", {
    ...draft("keep two", [{ name: "lost.txt", mimeType: "text/plain", data: "PRIVATE_ATTACHMENT_BYTES" }]),
  }, storage);
  const one = restoredDraft(readPersistedDraft("ws", "session:one", storage)!);
  const two = restoredDraft(readPersistedDraft("ws", "session:two", storage)!);
  assert.equal(one.text, "keep one");
  assert.equal(one.attachments[0]?.ref?.id, first);
  assert.equal(one.attachments[0]?.ref?.origin, "file");
  assert.equal(one.attachmentError, "");
  assert.equal(one.hadAttachments, false);
  assert.equal(two.text, "keep two");
  assert.equal(two.attachments.length, 0);
  assert.equal(two.hadAttachments, true);
  assert.match(two.attachmentError, /附件|reattach/u);
  assert.deepEqual(editorAttachmentRefs(attachmentsFromRefs([one.attachments[0].ref!])), [one.attachments[0].ref]);
  assert.doesNotMatch([...values.values()].join("\n"), /PRIVATE_ATTACHMENT_BYTES/);
  assert.equal(readPersistedDraft("other-ws", "session:one", storage), null);
});

test("removing a chip drops that ref from the next send payload", () => {
  const kept = token("d");
  const removed = token("e");
  const next = [committed(kept, "paste"), committed(removed, "drop")].filter(item => item.ref?.id !== removed);
  assert.deepEqual(attachmentPayloadForSend(next, true).attachmentRefs, [{ id: kept }]);
});

test("rich composer stays a textarea and can be turned off", () => {
  const rich = renderToStaticMarkup(<Composer richComposer defaultValue="draft" />);
  const plain = renderToStaticMarkup(<Composer richComposer={false} defaultValue="draft" />);
  assert.match(rich, /<textarea[^>]*class="xn-composer__input"/);
  assert.match(plain, /<textarea[^>]*class="xn-composer__input"/);
  assert.match(rich, /data-rich-composer="true"/);
  assert.match(plain, /data-rich-composer="false"/);
});

test("upload begin then commit sends one bounded reference and releases a failed commit", async () => {
  const previous = globalThis.fetch;
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const id = token("f");
  let commitAttempts = 0;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const path = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body });
    if (path === "/api/csrf") return { ok: true, json: async () => ({ csrfToken: "t" }) } as Response;
    if (path.endsWith("/begin")) {
      return { ok: true, json: async () => ({ status: "pending", ref: {
        id, token: id, name: "shot.png", mimeType: "image/png", size: 4, origin: "paste", source: "upload",
      } }) } as Response;
    }
    if (path.endsWith("/commit")) {
      commitAttempts += 1;
      if (commitAttempts === 1) return { ok: false, status: 400, json: async () => ({ error: "invalid attachment" }) } as Response;
      return { ok: true, json: async () => ({ status: "committed", ref: {
        id, token: id, name: "shot.png", mimeType: "image/png", size: 4, origin: "paste", source: "upload",
      } }) } as Response;
    }
    if (path.endsWith("/release")) return { ok: true, json: async () => ({ ok: true }) } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(commitUploadedAttachment({
      root: "/ws", sessionId: id, name: "shot.png", mimeType: "image/png", size: 4, origin: "paste", data: "YQ==",
    }), /invalid attachment/);
    assert.equal(calls.filter(call => call.path.endsWith("/release")).length, 1);
    calls.length = 0;
    const ref = await commitUploadedAttachment({
      root: "/ws", name: "shot.png", mimeType: "image/png", size: 4, origin: "drop", data: "YQ==",
    });
    assert.equal(ref.id, id);
    assert.equal(ref.origin, "paste");
    const begin = calls.find(call => call.path.endsWith("/begin"));
    assert.equal(begin?.body?.origin, "drop");
    assert.equal(begin?.body?.session_id, undefined);
    assert.equal("data" in (begin?.body ?? {}), false);
    const commit = calls.find(call => call.path.endsWith("/commit"));
    assert.deepEqual(commit?.body?.id, id);
    assert.equal(Object.keys(commit?.body ?? {}).includes("path"), false);
  } finally {
    globalThis.fetch = previous;
  }
});

test("unknown ACK persistence retains eight large refs and original owner through recovery", () => {
  const attachments = Array.from({ length: 8 }, (_, index) => {
    const item = committed(String(index).repeat(32));
    return { ...item, ref: { ...item.ref!, size: 8 * 1024 * 1024 } };
  });
  const owner = { root: '/ws', draftId: 'original-root-draft' };
  const frozen = { ...draft('pending text', attachments), draftId: owner.draftId, attachmentOwner: owner };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  persistDraft('ws', 'session:promoted', { ...draft('new input'), pendingSubmission: { id: 'unknown-ticket', draft: frozen } }, storage);
  const restored = restoredDraft(readPersistedDraft('ws', 'session:promoted', storage)!);
  const recovered = restored.recoverableDrafts?.find(item => item.text === 'pending text') ?? restored.pendingSubmission?.draft;
  assert.equal(recovered?.attachments.length, 8);
  assert.deepEqual(recovered?.attachmentOwner, owner);
  assert.ok(recovered?.attachments.every(item => item.data === ''));
  assert.ok([...values.values()].every(value => value.length < 10000));
});

test("large reference parser raises image capacity only, never accepts serialized bytes", () => {
  const base = committed('a'.repeat(32)).ref!;
  assert.ok(parseAttachmentRef({ ...base, size: 20 * 1024 * 1024 }));
  assert.equal(parseAttachmentRef({ ...base, size: 20 * 1024 * 1024 + 1 }), null);
  assert.equal(parseAttachmentRef({ ...base, mimeType: 'application/pdf', size: 2 * 1024 * 1024 + 1 }), null);
  assert.equal(parseAttachmentRef({ ...base, size: 10, data: 'PRIVATE_BYTES' }), null);
});
