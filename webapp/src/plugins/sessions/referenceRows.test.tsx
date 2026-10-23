import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineRow } from "../../xuenessWorkbench";
import { ZCodeConversation } from "./ZCodeConversation";
import { ReferenceRowView } from "./referenceRowView";
import { clipMountedPreview, projectReferenceRows, referencePreviewAllowed } from "./referenceRows";

const directive = ':xueness-file{path="docs/note.md" lines="1-2" purpose="说明"}';
const text = `见 ${directive} 结束`;
const start = text.indexOf(directive);
const end = start + directive.length;
const assistant: TimelineRow = { kind: "assistant", seq: 2, turnId: "turn-1", text, messageId: "m1" };

function journal(filesBody = false) {
  return {
    message_references: [{
      message_id: "m1",
      message_index: 1,
      replacements: [{ start, end, text: filesBody ? " " : "说明 (docs/note.md:1-2)" }],
      references: [
        { kind: "citation", path: "docs/note.md", label: "说明", start_line: 1, end_line: 2, text: "SECRET-BODY" },
        { kind: "preview", path: "docs/note.md", label: "说明", start_line: 1, end_line: 2, content: "SECRET-BODY" },
        { kind: "preview", path: "../secret.txt", label: "越界", text: "SECRET-BODY" },
      ],
    }],
  };
}

test("projectReferenceRows mounts bounded rows and drops file bodies", () => {
  const projected = projectReferenceRows([assistant], journal(true), { filesEffective: true });
  assert.deepEqual(projected.map(row => row.kind), ["assistant", "citation", "preview"]);
  assert.equal(JSON.stringify(projected).includes("SECRET-BODY"), false);
  assert.equal(JSON.stringify(projected).includes("../secret.txt"), false);
  const shown = projected[0];
  assert.equal(shown.kind, "assistant");
  if (shown.kind === "assistant") assert.equal(shown.displayText, "见   结束");
  assert.deepEqual(projectReferenceRows(projected, journal(true), { filesEffective: true }), projected);
});

test("files disabled keeps a plain label and does not create preview rows", () => {
  const projected = projectReferenceRows([assistant], journal(false), { filesEffective: false });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].kind, "assistant");
  if (projected[0].kind === "assistant") assert.equal(projected[0].displayText, "见 说明 (docs/note.md:1-2) 结束");
  const ignored = projectReferenceRows([assistant], {
    message_references: [{ message_id: "m1", replacements: [{ start: 0, end: 2, text: " " }], references: [] }],
  }, { filesEffective: false });
  assert.equal(ignored[0].kind === "assistant" && ignored[0].displayText, undefined);
});

test("preview mount is refused unless sessions and files are both effective", () => {
  assert.equal(referencePreviewAllowed("docs/note.md", new Set(["sessions", "files"])), true);
  assert.equal(referencePreviewAllowed("docs/note.md", new Set(["sessions"])), false);
  assert.equal(referencePreviewAllowed("docs/note.md", undefined), false);
  assert.equal(referencePreviewAllowed("../secret.txt", new Set(["sessions", "files"])), false);
  assert.equal(referencePreviewAllowed("/etc/passwd", new Set(["sessions", "files"])), false);
});

test("mounted preview clips to the requested window and rejects foreign bodies", () => {
  const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
  const clipped = clipMountedPreview({ path: "docs/note.md", text: lines }, "docs/note.md", { startLine: 2, endLine: 4 });
  assert.equal(clipped?.text, "line-2\nline-3\nline-4");
  assert.equal(clipMountedPreview({ path: "other.md", text: "SECRET-BODY" }, "docs/note.md"), null);
  assert.equal(clipMountedPreview({ path: "docs/note.md", text: "", image: "data:text/html;base64,SECRET" }, "docs/note.md")?.image, undefined);
  const image = "data:image/png;base64,aaaa";
  assert.equal(clipMountedPreview({ path: "docs/note.md", text: "ignored", image }, "docs/note.md")?.image, image);
});

test("conversation rows render citations and degrade previews without fetching", () => {
  const loader = () => { throw new Error("must not fetch"); };
  const citation: TimelineRow = {
    kind: "citation", seq: 2.01, turnId: "turn-1", path: "docs/note.md", label: "说明", anchorRole: "assistant", startLine: 1, endLine: 2,
  };
  const preview: TimelineRow = {
    kind: "preview", seq: 2.02, turnId: "turn-1", path: "docs/note.md", label: "说明", anchorRole: "assistant",
  };
  const artifact: TimelineRow = {
    kind: "artifact", seq: 2.03, turnId: "turn-1", path: "docs/note.md", label: "纪要", anchorRole: "assistant", sizeBytes: 12,
  };
  const plain = renderToStaticMarkup(<ReferenceRowView row={preview} sessionId="s1" effectivePluginIds={new Set(["sessions"])} loadPreview={loader} />);
  assert.match(plain, /data-reference-mode="plain"/);
  assert.doesNotMatch(plain, /data-reference-mode="mounted"/);
  const mounted = renderToStaticMarkup(<ReferenceRowView row={preview} sessionId="s1" effectivePluginIds={new Set(["sessions", "files"])} loadPreview={loader} />);
  assert.match(mounted, /data-reference-mode="mounted"/);
  assert.match(mounted, /正在读取预览/);
  assert.doesNotMatch(mounted, /SECRET-BODY/);
  const closed = renderToStaticMarkup(<ReferenceRowView row={artifact} sessionId="s1" effectivePluginIds={new Set(["sessions", "files"])} loadPreview={loader} />);
  assert.match(closed, /data-reference-mode="artifact"/);
  assert.match(closed, /12 字节/);
  assert.doesNotMatch(closed, /正在读取预览/);
  const html = renderToStaticMarkup(<ZCodeConversation sessionId="s1" rows={[assistant, citation, preview, artifact]} effectivePluginIds={new Set(["sessions"])} />);
  assert.match(html, /data-reference-kind="citation"/);
  assert.match(html, /data-reference-mode="plain"/);
  assert.match(html, /docs\/note.md:1-2/);
  assert.doesNotMatch(html, /data-reference-mode="mounted"/);
});
