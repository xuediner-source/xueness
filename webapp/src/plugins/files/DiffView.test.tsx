import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, buildUnifiedLineDiff, groupUnifiedDiffContext } from "./DiffView";

test("unified diff pairs unchanged lines and reports old/new line numbers", () => {
  const diff = buildUnifiedLineDiff("alpha\nkeep\nold\nend", "alpha\nkeep\nnew\nend");
  assert.deepEqual(diff.lines.map(line => [line.kind, line.oldLine, line.newLine, line.text]), [
    ["context", 1, 1, "alpha"],
    ["context", 2, 2, "keep"],
    ["remove", 3, null, "old"],
    ["add", null, 3, "new"],
    ["context", 4, 4, "end"],
  ]);
  assert.equal(diff.simplified, false);
  assert.equal(diff.truncated, false);
});

test("unified diff reports a trailing newline change on an empty file", () => {
  const diff = buildUnifiedLineDiff("", "\n");
  assert.deepEqual(diff.lines.map(line => [line.kind, line.newLine, line.text]), [["add", 1, ""]]);
  assert.equal(diff.newlineMismatch, true);

  const html = renderToStaticMarkup(<DiffView changeSet={{ source: "session-journal", changes: [
    { path: "empty.txt", kind: "edit", ok: true, old: "", new: "\n" },
  ] }} />);
  assert.match(html, /data-testid="diff-newline-change"/);
  assert.doesNotMatch(html, /No text line changes were found|未发现文本行差异/);
});

test("distant unchanged context is grouped behind native disclosure details", () => {
  const oldText = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`).join("\n");
  const newText = oldText.replace("line-12", "changed-12");
  const diff = buildUnifiedLineDiff(oldText, newText);
  const blocks = groupUnifiedDiffContext(diff.lines, 2);
  assert.ok(blocks.some(block => block.kind === "unchanged" && block.lines.length > 2));

  const html = renderToStaticMarkup(<DiffView changeSet={{ source: "session-journal", changes: [
    { path: "src/example.ts", kind: "edit", ok: true, old: oldText, new: newText },
  ] }} />);
  assert.match(html, /<details>/);
  assert.match(html, /Show \d+ unchanged lines|显示 \d+ 行未变内容/);
  assert.match(html, /aria-label="旧行 3"/);
  assert.match(html, /aria-label="新行 3"/);
  assert.match(html, /data-diff-line="remove"/);
  assert.match(html, /data-diff-line="add"/);
});

test("large inputs stay within the diff work and rendered line budgets", () => {
  const oldText = Array.from({ length: 1_201 }, (_, index) => `before-${index}`).join("\n");
  const newText = Array.from({ length: 1_201 }, (_, index) => `after-${index}`).join("\n");
  const diff = buildUnifiedLineDiff(oldText, newText);
  assert.equal(diff.simplified, true);
  assert.equal(diff.truncated, true);
  assert.ok(diff.lines.length <= 2 * 1_200);
});

test("DiffView keeps journal provenance and presents additions without mutation controls", () => {
  const html = renderToStaticMarkup(<DiffView changeSet={{ source: "session-journal", changes: [
    { path: "new.txt", kind: "write", ok: false, content: "first\nsecond" },
  ] }} />);
  assert.match(html, /来自会话记录，不是当前磁盘差异/);
  assert.match(html, /new\.txt/);
  assert.match(html, /data-diff-line="add"/);
  assert.match(html, /first/);
  assert.match(html, /second/);
  assert.doesNotMatch(html, /接受|还原|Accept|Revert/);
});
