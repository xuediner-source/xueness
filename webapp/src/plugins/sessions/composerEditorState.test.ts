import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPOSER_DRAFT_STORAGE_KEY_PREFIX, Composer, persistDraft, readPersistedDraft, restoredDraft, type ComposerDraftState } from "./XuenessWorkbenchView";
import {
  COMPOSER_EDITOR_LIMITS, applyEditorSuggestion, contextAfterEditorEdit, deleteEditorAtom,
  editorStateForPlainText, editorStateHasContent, editorStateMatching, insertEditorText,
  navigationText, parseComposerEditorState, renderEditorHtml, retargetEditorText, sendableText,
  type ComposerEditorState,
} from "./composerEditorState";

const mentionDoc = (): ComposerEditorState => parseComposerEditorState({
  version: 1,
  nodes: [
    { type: "text", text: "read " },
    { type: "mention", kind: "file", id: "src/a.ts", label: "a.ts" },
    { type: "text", text: "" },
  ],
})!;

function draftWith(text: string, editorState?: ComposerEditorState): ComposerDraftState {
  return {
    text, goal: false, attachments: [], selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "", attachmentError: "", revision: 1,
    ...(editorState ? { editorState } : {}),
  };
}

test("editor state round-trips mentions and slash commands without putting them in the sendable text twice", () => {
  const mention = mentionDoc();
  assert.equal(sendableText(mention), "read ");
  assert.equal(navigationText(mention).includes("src/a.ts"), false);
  const again = parseComposerEditorState(JSON.parse(JSON.stringify(mention)));
  assert.deepEqual(again, mention);
  const plain = editorStateForPlainText("please /compact the notes");
  assert.ok(plain);
  const slashed = applyEditorSuggestion(plain!, plain!.nodes[0].type === "text" ? 0 : 0, { kind: "command", token: "compact" });
  assert.equal(slashed, null);
  const prompted = editorStateForPlainText("/co");
  const applied = applyEditorSuggestion(prompted!, 3, { kind: "command", token: "compact", label: "Compact" });
  assert.ok(applied);
  assert.equal(sendableText(applied!.state), "/compact ");
  assert.equal(applied!.state.nodes.some(node => node.type === "slash" && node.id === "compact"), true);
  assert.equal(editorStateMatching(sendableText(applied!.state), applied!.state)?.nodes.length, applied!.state.nodes.length);
});

test("accepting a mention keeps the surrounding words and drops an oversized or corrupt document", () => {
  const base = editorStateForPlainText("please @src then stop");
  assert.ok(base);
  const cursor = "please @src".length;
  const applied = applyEditorSuggestion(base!, cursor, { kind: "file", token: "src/a.ts", label: "a.ts" });
  assert.ok(applied);
  assert.equal(sendableText(applied!.state), "please  then stop");
  assert.equal(applied!.state.nodes.some(node => node.type === "mention" && node.id === "src/a.ts"), true);
  assert.equal(parseComposerEditorState({ version: 2, nodes: [] }), null);
  assert.equal(parseComposerEditorState({ version: 1, nodes: [{ type: "mention", kind: "nope", id: "a", label: "a" }] }), null);
  assert.equal(parseComposerEditorState({ version: 1, nodes: [{ type: "slash", id: "has space", label: "x" }] }), null);
  assert.equal(editorStateForPlainText("x".repeat(COMPOSER_EDITOR_LIMITS.maxTextChars + 1)), null);
  const tooMany = {
    version: 1,
    nodes: Array.from({ length: COMPOSER_EDITOR_LIMITS.maxAtomic + 1 }, (_, index) => ({
      type: "mention", kind: "file", id: `f${index}.ts`, label: `f${index}`,
    })),
  };
  assert.equal(parseComposerEditorState(tooMany), null);
  assert.equal(editorStateHasContent(mentionDoc()), true);
  assert.equal(editorStateMatching("other", mentionDoc()), null);
});

test("backspace removes only the atomic node and appended text keeps it", () => {
  const state = mentionDoc();
  const pill = navigationText(state).indexOf("\uFFFC");
  // The caret still inside the leading text deletes a character, not the mention.
  assert.equal(deleteEditorAtom(state, pill, "backspace"), null);
  const afterMention = pill + 1;
  const deleted = deleteEditorAtom(state, afterMention, "backspace");
  assert.ok(deleted);
  assert.equal(deleted!.removed.type, "mention");
  assert.equal(sendableText(deleted!.state), "read ");
  assert.equal(editorStateForPlainText(sendableText(deleted!.state))?.nodes.every(node => node.type === "text"), true);
  const trailed = parseComposerEditorState({
    version: 1,
    nodes: [
      { type: "text", text: "read " },
      { type: "mention", kind: "file", id: "src/a.ts", label: "a.ts" },
      { type: "text", text: " more" },
    ],
  })!;
  assert.equal(deleteEditorAtom(trailed, navigationText(trailed).length, "backspace"), null);
  const removedFromTrail = deleteEditorAtom(trailed, navigationText(trailed).indexOf("\uFFFC") + 1, "backspace");
  assert.equal(removedFromTrail?.removed.type, "mention");
  assert.equal(sendableText(removedFromTrail!.state), "read  more");
  const grown = retargetEditorText(state, "read \n\nmore");
  assert.ok(grown);
  assert.equal(sendableText(grown!), "read \n\nmore");
  assert.equal(grown!.nodes.some(node => node.type === "mention"), true);
  const replaced = retargetEditorText(state, "unrelated");
  assert.equal(replaced?.nodes.some(node => node.type === "mention"), false);
  assert.equal(sendableText(replaced!), "unrelated");
  const context = contextAfterEditorEdit(
    { files: ["src/a.ts", "keep.ts"], sessions: [], skills: [], plugins: [] },
    state,
    deleted!.state,
  );
  assert.deepEqual(context.files, ["keep.ts"]);
});

test("newline insertion stays inside the text run and html escapes labels", () => {
  const state = editorStateForPlainText("ab")!;
  const inserted = insertEditorText(state, 1, "\n");
  assert.equal(sendableText(inserted!.state), "a\nb");
  const html = renderEditorHtml(parseComposerEditorState({
    version: 1,
    nodes: [{ type: "mention", kind: "file", id: "a.ts", label: "a<b>" }],
  })!);
  assert.match(html, /data-editor-node="mention"/);
  assert.match(html, /a&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test("draft storage keeps a bounded editor beside attachment refs and drops corrupt state", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const state = mentionDoc();
  persistDraft("ws", "session", {
    ...draftWith(sendableText(state), state),
    attachments: [{ name: "shot.png", mimeType: "image/png", data: "", ref: {
      id: "b".repeat(32), token: "b".repeat(32), name: "shot.png", mimeType: "image/png", size: 4, origin: "paste", source: "upload",
    } }],
  }, storage);
  const stored = readPersistedDraft("ws", "session", storage);
  assert.equal(stored?.editorState?.nodes.some(node => node.type === "mention" && node.id === "src/a.ts"), true);
  assert.equal(stored?.attachmentRefs?.[0]?.id, "b".repeat(32));
  assert.doesNotMatch([...values.values()].join("\n"), /PRIVATE|data:/);
  const restored = restoredDraft(stored!);
  assert.equal(restored.editorState?.nodes.some(node => node.type === "mention"), true);
  assert.equal(restored.attachments[0]?.ref?.id, "b".repeat(32));
  persistDraft("ws", "broken", {
    ...draftWith("keep me"),
    editorState: { version: 1, nodes: [{ type: "bogus" }] } as unknown as ComposerEditorState,
  }, storage);
  assert.equal(readPersistedDraft("ws", "broken", storage)?.editorState, undefined);
  assert.equal(readPersistedDraft("ws", "broken", storage)?.text, "keep me");
  storage.setItem(`${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent("ws")}`, JSON.stringify({
    version: 1,
    scopes: { bad: { text: "still here", editorState: { version: 1, nodes: [{ type: "nope" }] } } },
  }));
  assert.equal(readPersistedDraft("ws", "bad", storage)?.text, "still here");
  assert.equal(readPersistedDraft("ws", "bad", storage)?.editorState, undefined);
});

test("structured editor mounts only for atomic drafts while sessions rich composer is on", () => {
  const state = mentionDoc();
  const store = { current: new Map([["ws:session", draftWith(sendableText(state), state)]]) };
  const rich = renderToStaticMarkup(createElement(Composer, { richComposer: true, draftStore: store, draftKey: "session", workspaceKey: "ws" }));
  assert.match(rich, /data-editor="tokens"/);
  assert.match(rich, /data-testid="composer-editor"/);
  assert.match(rich, /data-mention-id="src\/a.ts"/);
  assert.doesNotMatch(rich, /<textarea/);
  const plain = renderToStaticMarkup(createElement(Composer, { richComposer: true, defaultValue: "/dep", commands: [{ id: "deploy", description: "ship" }] }));
  assert.match(plain, /<textarea[^>]*class="xn-composer__input"/);
  assert.match(plain, /data-editor="text"/);
  assert.match(plain, /data-testid="composer-suggestion-command-deploy"/);
  assert.doesNotMatch(plain, /data-testid="composer-editor"/);
  const disabled = renderToStaticMarkup(createElement(Composer, {
    richComposer: false, draftStore: store, draftKey: "session", workspaceKey: "ws",
  }));
  assert.match(disabled, /<textarea[^>]*class="xn-composer__input"/);
  assert.match(disabled, /data-editor="textarea"/);
  assert.doesNotMatch(disabled, /data-testid="composer-editor"/);
  assert.doesNotMatch(disabled, /data-mention-id=/);
});
