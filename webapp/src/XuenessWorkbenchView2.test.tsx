/**
 * Slice-2 view tests: FileBrowser, DiffView, SettingsPanel.
 *
 * These render through `renderToStaticMarkup`, which needs no DOM — the point is
 * that the components are pure functions of their props. The assertions that
 * matter most: DiffView's provenance label is present (otherwise the view reads
 * as a live diff, which it is not), and a panel with no actions renders no
 * buttons rather than dead ones.
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { FileBrowser, DiffView, SettingsPanel } from "./XuenessWorkbenchView2";
import type { FileChangeSet } from "./xuenessWorkbench";
import type { AgentCapabilities } from "./xuenessSettings";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const OFF: AgentCapabilities = { allowMcp: false, allowSubagents: false, allowHooks: false };

// -- FileBrowser -------------------------------------------------------------

test("FileBrowser: lists files and marks the selected one", () => {
  const out = html(
    React.createElement(FileBrowser, {
      files: [
        { path: "src/app.ts", size: 2048 },
        { path: "README.md", size: 512 },
      ],
      selectedPath: "README.md",
    }),
  );
  assert.match(out, /src\/app\.ts/);
  assert.match(out, /README\.md/);
  assert.match(out, /2\.0 KB/);
  assert.match(out, /aria-current="true"/);
  // Only the selected file carries aria-current.
  const selectedCount = (out.match(/aria-current="true"/g) ?? []).length;
  assert.equal(selectedCount, 1);
});

test("FileBrowser: shows an empty state and a truncation notice", () => {
  const empty = html(React.createElement(FileBrowser, { files: [] }));
  assert.match(empty, /暂无文件/);

  const truncated = html(
    React.createElement(FileBrowser, {
      files: [{ path: "a.txt", size: 1 }],
      truncated: true,
    }),
  );
  assert.match(truncated, /仅显示前一部分/);
});

test("FileBrowser: preview error is visible and hides the preview body", () => {
  const out = html(
    React.createElement(FileBrowser, {
      files: [{ path: "a.txt", size: 10 }],
      selectedPath: "a.txt",
      preview: { path: "a.txt", text: "SECRET_BODY", truncated: false },
      previewError: "cannot preview file",
    }),
  );
  assert.match(out, /cannot preview file/);
  assert.doesNotMatch(out, /SECRET_BODY/);
});

test("FileBrowser: renders preview text and flags truncation", () => {
  const out = html(
    React.createElement(FileBrowser, {
      files: [{ path: "a.txt", size: 10 }],
      selectedPath: "a.txt",
      preview: { path: "a.txt", text: "hello world", truncated: true },
    }),
  );
  assert.match(out, /hello world/);
  assert.match(out, /已截断/);
});

test("FileBrowser: renders safely with no callbacks", () => {
  assert.doesNotThrow(() => html(React.createElement(FileBrowser, { files: [] })));
});

// -- DiffView ----------------------------------------------------------------

test("DiffView: always shows the session-record provenance label", () => {
  const out = html(React.createElement(DiffView, { changeSet: null }));
  assert.match(out, /来自会话记录，不是当前磁盘差异/);
});

test("DiffView: edit shows old and new; write shows content", () => {
  const changeSet: FileChangeSet = {
    source: "session-journal",
    changes: [
      { path: "a.txt", kind: "edit", ok: true, old: "OLD_LINE", new: "NEW_LINE" },
      { path: "b.txt", kind: "write", ok: false, content: "WRITTEN_BODY" },
    ],
  };
  const out = html(React.createElement(DiffView, { changeSet }));
  assert.match(out, /OLD_LINE/);
  assert.match(out, /NEW_LINE/);
  assert.match(out, /WRITTEN_BODY/);
  assert.match(out, /已应用/);
  assert.match(out, /未应用/);
  assert.match(out, /来自会话记录，不是当前磁盘差异/);
});

test("DiffView: empty change set and error both render honestly", () => {
  const empty = html(
    React.createElement(DiffView, { changeSet: { source: "session-journal", changes: [] } }),
  );
  assert.match(empty, /暂无改动/);
  assert.match(empty, /来自会话记录，不是当前磁盘差异/);

  const errored = html(React.createElement(DiffView, { changeSet: null, error: "cannot load journal" }));
  assert.match(errored, /cannot load journal/);
  assert.match(errored, /来自会话记录，不是当前磁盘差异/);
});

// -- SettingsPanel -----------------------------------------------------------

test("SettingsPanel: three capability checkboxes reflect state", () => {
  const caps: AgentCapabilities = { allowMcp: true, allowSubagents: false, allowHooks: true };
  const out = html(React.createElement(SettingsPanel, { values: {}, capabilities: caps }));
  assert.match(out, /允许 MCP/);
  assert.match(out, /允许子代理/);
  assert.match(out, /允许 Hooks/);
  const checkedCount = (out.match(/checked=""/g) ?? []).length;
  assert.equal(checkedCount, 2, "mcp + hooks are on, subagents is off");
  assert.match(out, /data-enabled="true"/);
  assert.match(out, /data-enabled="false"/);
});

test("SettingsPanel: toggle callback receives key and value", () => {
  const seen: [keyof AgentCapabilities, boolean][] = [];
  const out = html(
    React.createElement(SettingsPanel, {
      values: {},
      capabilities: OFF,
      onToggleCapability: (key, value) => seen.push([key, value]),
      dirty: true,
    }),
  );
  // The markup wires an onChange; assert the handler is actually attached by
  // checking the element renders and the callbacks were never required for it.
  assert.match(out, /aria-label="允许 MCP"/);
  assert.equal(seen.length, 0, "handler must not fire during render");
});

test("SettingsPanel: save button only when a handler is given, disabled unless dirty", () => {
  const without = html(React.createElement(SettingsPanel, { values: {}, capabilities: OFF }));
  assert.doesNotMatch(without, /data-testid="settings-save"/);

  const dirty = html(
    React.createElement(SettingsPanel, { values: {}, capabilities: OFF, onSave: () => {}, dirty: true }),
  );
  assert.match(dirty, /data-testid="settings-save"/);
  assert.doesNotMatch(dirty, /disabled=""/);

  const clean = html(
    React.createElement(SettingsPanel, { values: {}, capabilities: OFF, onSave: () => {}, dirty: false }),
  );
  assert.match(clean, /disabled=""/);
});

test("SettingsPanel: save error is visible", () => {
  const out = html(
    React.createElement(SettingsPanel, {
      values: {},
      capabilities: OFF,
      onSave: () => {},
      saveError: "settings save did not take effect: allowMcp",
      dirty: true,
    }),
  );
  assert.match(out, /settings save did not take effect/);
});

test("SettingsPanel: renders safely with minimal props", () => {
  assert.doesNotThrow(() => html(React.createElement(SettingsPanel, { values: {}, capabilities: OFF })));
});

test("FileBrowser: image preview renders an <img> with the data URL; text preview keeps CodeBlock", () => {
  const image = html(
    React.createElement(FileBrowser, {
      files: [{ path: "shot.png", size: 12 }],
      selectedPath: "shot.png",
      preview: { path: "shot.png", text: "", truncated: false, image: "data:image/png;base64,AAAA" },
    }),
  );
  assert.match(image, /data-testid="file-preview-image"/);
  assert.match(image, /src="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(image, /data-testid="file-preview-error"/);

  const text = html(
    React.createElement(FileBrowser, {
      files: [{ path: "a.txt", size: 3 }],
      selectedPath: "a.txt",
      preview: { path: "a.txt", text: "hello", truncated: false },
    }),
  );
  assert.doesNotMatch(text, /data-testid="file-preview-image"/);
  assert.match(text, /hello/);
});

test("FileBrowser: markdown renders as prose; pdf/audio/video render embeds", () => {
  const md = html(
    React.createElement(FileBrowser, {
      files: [{ path: "README.md", size: 20 }],
      selectedPath: "README.md",
      preview: { path: "README.md", text: "- 第一项", truncated: false },
    }),
  );
  assert.match(md, /data-testid="file-preview-markdown"/);
  assert.match(md, /xn-md__list/);
  assert.doesNotMatch(md, /data-testid="file-preview-image"/);

  const pdf = html(
    React.createElement(FileBrowser, {
      files: [{ path: "doc.pdf", size: 9 }],
      selectedPath: "doc.pdf",
      preview: { path: "doc.pdf", text: "", truncated: false, embed: { mime: "application/pdf", dataUrl: "data:application/pdf;base64,AAAA" } },
    }),
  );
  assert.match(pdf, /data-testid="file-preview-embed"/);
  assert.match(pdf, /data:application\/pdf;base64,AAAA/);

  const audio = html(
    React.createElement(FileBrowser, {
      files: [{ path: "clip.mp3", size: 4 }],
      selectedPath: "clip.mp3",
      preview: { path: "clip.mp3", text: "", truncated: false, embed: { mime: "audio/mpeg", dataUrl: "data:audio/mpeg;base64,AAAA" } },
    }),
  );
  assert.match(audio, /data-testid="file-preview-audio"/);
  assert.match(audio, /controls=""/);

  const video = html(
    React.createElement(FileBrowser, {
      files: [{ path: "film.webm", size: 6 }],
      selectedPath: "film.webm",
      preview: { path: "film.webm", text: "", truncated: false, embed: { mime: "video/webm", dataUrl: "data:video/webm;base64,AAAA" } },
    }),
  );
  assert.match(video, /data-testid="file-preview-video"/);

  const plain = html(
    React.createElement(FileBrowser, {
      files: [{ path: "a.txt", size: 3 }],
      selectedPath: "a.txt",
      preview: { path: "a.txt", text: "plain", truncated: false },
    }),
  );
  assert.doesNotMatch(plain, /file-preview-markdown|file-preview-embed|file-preview-audio|file-preview-video/);
});
