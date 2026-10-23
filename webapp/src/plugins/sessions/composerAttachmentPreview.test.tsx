import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { setLocale, t } from "../../i18n";
import { Composer, persistDraft, type ComposerDraftState } from "./XuenessWorkbenchView";
import { persistedAttachmentFields, type ComposerAttachment } from "./composerAttachmentRef";
import { attachmentPreviewKind, canRequestAttachmentPreview, type AttachmentPreview } from "./composerAttachmentPreview";
import { previewText } from "./composerAttachmentPreviewModel";
import {
  AttachmentPreviewBody, AttachmentPreviewDialog, loadAttachmentPreview, parseAttachmentPreview,
} from "./composerAttachmentPreviewDialog";

async function renderReady(node: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}

const token = (digit: string) => digit.repeat(32);

function imagePreview(id: string, data = "iVBORw0KGgo="): AttachmentPreview {
  const preview = parseAttachmentPreview({
    id, name: "shot.png", mimeType: "image/png", size: 8, kind: "image", truncated: false, data,
  });
  if (!preview) throw new Error("expected image preview");
  return preview;
}

test("preview parser accepts authorized media and drops urls, bytes on text, and mismatched kinds", () => {
  const id = token("a");
  const image = imagePreview(id);
  assert.equal(image.kind, "image");
  assert.equal(image.data, "iVBORw0KGgo=");
  assert.equal(attachmentPreviewKind("video/webm"), "video");
  assert.equal(attachmentPreviewKind("text/markdown"), "text");
  assert.equal(attachmentPreviewKind("application/octet-stream"), "file");

  const text = parseAttachmentPreview({
    id, name: "note.txt", mimeType: "text/plain", size: 5, kind: "text", truncated: false, text: "hello",
  });
  assert.equal(text?.text, "hello");
  assert.equal(text?.data, undefined);

  const excerpt = "a".repeat(2000);
  const truncated = parseAttachmentPreview({
    id, name: "note.txt", mimeType: "text/plain", size: 2001, kind: "text", truncated: true, text: excerpt,
  });
  assert.equal(truncated?.truncated, true);
  assert.equal(parseAttachmentPreview({
    id, name: "note.txt", mimeType: "text/plain", size: 2000, kind: "text", truncated: true, text: excerpt,
  }), null);
  assert.equal(parseAttachmentPreview({ ...image, url: "https://evil.example/shot.png" }), null);
  assert.equal(parseAttachmentPreview({ ...image, text: "hidden" }), null);
  assert.equal(parseAttachmentPreview({
    id, name: "note.txt", mimeType: "text/plain", size: 4, kind: "text", truncated: false, text: "text", data: "abcd",
  }), null);
  assert.equal(parseAttachmentPreview({
    id, name: "shot.png", mimeType: "image/png", size: 8, kind: "file", truncated: false, data: image.data,
  }), null);
  assert.equal(parseAttachmentPreview({
    id, name: "page.pdf", mimeType: "application/pdf", size: 8, kind: "pdf", truncated: true, data: image.data,
  }), null);
});

test("a disabled composer does not request a preview, and preview bytes stay out of draft storage", async () => {
  const id = token("b");
  const ref = {
    id, token: id, name: "shot.png", mimeType: "image/png", size: 8, origin: "paste" as const, source: "upload" as const,
  };
  const attachment: ComposerAttachment = { name: "shot.png", mimeType: "image/png", data: "", ref };
  const inlineOnly: ComposerAttachment = { name: "local.txt", mimeType: "text/plain", data: "LOCAL" };
  assert.equal(canRequestAttachmentPreview(false, "/ws", attachment), false);
  assert.equal(canRequestAttachmentPreview(true, "", attachment), false);
  assert.equal(canRequestAttachmentPreview(true, "/ws", inlineOnly), false);
  assert.equal(canRequestAttachmentPreview(true, "/ws", attachment), true);

  let fetches = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(loadAttachmentPreview({ enabled: false, root: "/ws", id }), /invalid attachment/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previous;
  }

  const preview = imagePreview(id);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const draft: ComposerDraftState = {
    text: "keep", goal: false, selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "", attachmentError: "", revision: 1,
    attachments: [{ ...attachment, data: preview.data ?? "" }],
  };
  persistDraft("ws", "session", draft, storage);
  const stored = [...values.values()].join("\n");
  assert.equal(stored.includes(preview.data ?? "missing"), false);
  assert.equal(JSON.stringify(persistedAttachmentFields(draft.attachments)).includes(preview.data ?? "missing"), false);
});

test("preview markup renders media from the response and escapes text", () => {
  const id = token("c");
  const image = imagePreview(id);
  const imageHtml = renderToStaticMarkup(createElement(AttachmentPreviewBody, { preview: image }));
  assert.match(imageHtml, /data-testid="composer-attachment-preview-image"/);
  assert.match(imageHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(imageHtml, /https?:/);

  const script = "<img src=x onerror=alert(1)>";
  const textHtml = renderToStaticMarkup(createElement(AttachmentPreviewBody, { preview: {
    id, name: "note.txt", mimeType: "text/plain", size: script.length, kind: "text", truncated: false, text: script,
  } }));
  assert.match(textHtml, /data-testid="composer-attachment-preview-text"/);
  assert.match(textHtml, /&lt;img/);
  assert.doesNotMatch(textHtml, /<img/);

  const fileHtml = renderToStaticMarkup(createElement(AttachmentPreviewBody, { preview: {
    id, name: "blob.bin", mimeType: "application/octet-stream", size: 4, kind: "file", truncated: false,
  } }));
  assert.match(fileHtml, /data-testid="composer-attachment-preview-file"/);
  assert.match(fileHtml, /此文件没有内嵌预览/);
  assert.doesNotMatch(fileHtml, /data:/);
});

test("rich composer offers preview only for a committed ref and does not embed bytes", async () => {
  const id = token("d");
  const ref = {
    id, token: id, name: "shot.png", mimeType: "image/png", size: 8, origin: "drop" as const, source: "upload" as const,
  };
  const draft: ComposerDraftState = {
    text: "hello", goal: false, selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "", attachmentError: "", revision: 1,
    attachments: [{ name: "shot.png", mimeType: "image/png", data: "", ref }],
  };
  const store = { current: new Map<string, ComposerDraftState>([["ws:one", draft]]) };
  const rich = await renderReady(createElement(Composer, {
    richComposer: true, attachmentRoot: "/ws", attachmentSessionId: "s", draftStore: store,
    draftKey: "one", workspaceKey: "ws",
  }));
  assert.match(rich, /data-testid="composer-attachment-preview"/);
  assert.match(rich, /data-preview-kind="image"/);
  assert.match(rich, /data-rich-composer="true"/);
  assert.doesNotMatch(rich, /data:image/);
  assert.doesNotMatch(rich, /composer-attachment-preview-dialog/);

  const inline: ComposerDraftState = {
    ...draft,
    attachments: [{ name: "local.txt", mimeType: "text/plain", data: "LOCAL_BYTES" }],
  };
  const inlineStore = { current: new Map<string, ComposerDraftState>([["ws:one", inline]]) };
  const inlineHtml = await renderReady(createElement(Composer, {
    richComposer: true, attachmentRoot: "/ws", draftStore: inlineStore, draftKey: "one", workspaceKey: "ws",
  }));
  assert.doesNotMatch(inlineHtml, /composer-attachment-preview"/);
  assert.doesNotMatch(inlineHtml, /LOCAL_BYTES/);

  const plainStore = { current: new Map<string, ComposerDraftState>([["ws:one", draft]]) };
  const plain = renderToStaticMarkup(createElement(Composer, {
    richComposer: false, attachmentRoot: "/ws", draftStore: plainStore, draftKey: "one", workspaceKey: "ws",
  }));
  assert.match(plain, /data-rich-composer="false"/);
  assert.doesNotMatch(plain, /composer-attachment-preview"/);
  assert.match(plain, /data-testid="composer-attachment-chip"/);
});

test("preview dialog and renderer load only when a preview opens", () => {
  const root = resolve(process.cwd(), "src/plugins/sessions");
  const workbench = readFileSync(resolve(root, "XuenessWorkbenchView.tsx"), "utf8");
  const chip = readFileSync(resolve(root, "composerAttachmentPreview.tsx"), "utf8");
  const dialog = readFileSync(resolve(root, "composerAttachmentPreviewDialog.tsx"), "utf8");
  assert.doesNotMatch(workbench, /composerAttachmentPreviewDialog/);
  assert.doesNotMatch(workbench, /from\s+["']\.\/composerAttachmentPreviewDialog["']/);
  assert.doesNotMatch(workbench, /from\s+["']\.\/composerAttachmentPreview["']/);
  assert.doesNotMatch(workbench, /composerAttachmentPreviewModel|attachmentPreviewKind|data-preview-kind|composer-attachment-preview/);
  assert.match(workbench, /import\(\s*["']\.\/composerAttachmentPreview["']\s*\)/);
  assert.doesNotMatch(chip, /from\s+["']\.\/composerAttachmentPreviewDialog["']/);
  assert.match(chip, /import\(\s*["']\.\/composerAttachmentPreviewDialog["']\s*\)/);
  assert.doesNotMatch(chip, /parseAttachmentPreview|loadAttachmentPreview|composer-attachment-preview-dialog/);
  assert.doesNotMatch(dialog, /from\s+["']\.\/composerAttachmentPreview["']/);
  assert.match(dialog, /export function parseAttachmentPreview/);
  assert.match(dialog, /export function AttachmentPreviewBody/);
  setLocale("en");
  try {
    assert.equal(previewText("预览附件：{0}", ["shot.png"]), "Preview attachment: shot.png");
    assert.equal(previewText("关闭预览"), "Close preview");
    assert.equal(t("关闭预览"), "关闭预览");
    assert.equal(t("预览附件：{0}"), "预览附件：{0}");
  } finally {
    setLocale("zh");
  }

  const html = renderToStaticMarkup(createElement(AttachmentPreviewDialog, {
    name: "shot.png", root: "/ws", id: token("e"), onClose: () => {},
  }));
  assert.match(html, /data-testid="composer-attachment-preview-dialog"/);
  assert.match(html, /data-preview-state="loading"/);
  assert.match(html, /shot\.png/);
  assert.doesNotMatch(html, /data:/);
  assert.doesNotMatch(html, /https?:/);
});

test("over-limit image preview fails closed without a byte request", async () => {
  setLocale('en');
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error('no request allowed'); }) as typeof fetch;
  try {
    await assert.rejects(loadAttachmentPreview({ enabled: true, root: '/ws', id: 'a'.repeat(32),
      mimeType: 'image/png', size: 20 * 1024 * 1024 + 1 }), /still ready to send/);
    assert.equal(requests, 0);
    const html = renderToStaticMarkup(createElement(AttachmentPreviewDialog, { name: 'large.png', root: '/ws',
      id: 'a'.repeat(32), mimeType: 'image/png', size: 20 * 1024 * 1024 + 1, onClose: () => {} }));
    assert.match(html, /still ready to send/);
    assert.match(html, /data-preview-state="error"/);
    assert.doesNotMatch(html, /base64,/);
  } finally { globalThis.fetch = previous; setLocale('zh'); }
});
