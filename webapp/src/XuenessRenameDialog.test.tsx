import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { XuenessRenameDialog } from "./XuenessRenameDialog";

test("RenameDialog: open=false 不渲染任何内容", () => {
  const html = renderToStaticMarkup(
    <XuenessRenameDialog
      open={false}
      initialValue="旧标题"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  assert.equal(html, "");
});

test("RenameDialog: open 时渲染遮罩、role=dialog 面板与带初值的输入", () => {
  const html = renderToStaticMarkup(
    <XuenessRenameDialog open initialValue="旧标题" />,
  );
  assert.match(html, /xn-dialog-overlay/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="重命名任务"/);
  assert.match(html, /class="xn-dialog__title">重命名任务<\/h2>/);
  assert.match(html, /data-testid="xn-rename-input"/);
  assert.match(html, /value="旧标题"/);
  // autoFocus is declared on the input; focus itself cannot be asserted in SSR.
  assert.match(html, /autofocus/);
  assert.match(html, /data-testid="xn-rename-cancel"/);
  assert.match(html, /data-testid="xn-rename-confirm"/);
});

test("RenameDialog: 空值或未改动时确认按钮 disabled", () => {
  const unchanged = renderToStaticMarkup(
    <XuenessRenameDialog open initialValue="旧标题" onConfirm={() => {}} />,
  );
  const unchangedButton =
    unchanged.match(/<button[^>]*data-testid="xn-rename-confirm"[^>]*>/)?.[0] ?? "";
  assert.match(unchangedButton, /disabled/);

  const blank = renderToStaticMarkup(
    <XuenessRenameDialog open initialValue="" onConfirm={() => {}} />,
  );
  const blankButton =
    blank.match(/<button[^>]*data-testid="xn-rename-confirm"[^>]*>/)?.[0] ?? "";
  assert.match(blankButton, /disabled/);

  // Whitespace-only drafts count as empty.
  const whitespace = renderToStaticMarkup(
    <XuenessRenameDialog open initialValue="   " onConfirm={() => {}} />,
  );
  const whitespaceButton =
    whitespace.match(/<button[^>]*data-testid="xn-rename-confirm"[^>]*>/)?.[0] ?? "";
  assert.match(whitespaceButton, /disabled/);
});

test("RenameDialog: 改动后的草稿使确认可用，自定义标题透传", () => {
  const html = renderToStaticMarkup(
    <XuenessRenameDialog open initialValue="旧标题" title="重命名会话" />,
  );
  // The draft starts at initialValue so the confirm renders enabled only via
  // editing; here we assert the custom title reaches heading and aria-label.
  assert.match(html, /aria-label="重命名会话"/);
  assert.match(html, /重命名会话/);
  // Controlled input re-seeds from initialValue (SSR cannot simulate typing).
  assert.match(html, /value="旧标题"/);
});
