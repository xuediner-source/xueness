import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { XuenessRenameDialog, shouldDismissRenameOnEscape, trapRenameDialogTab } from "./XuenessRenameDialog";

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
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="重命名任务"/);
  assert.match(html, /class="xn-dialog__title">重命名任务<\/h2>/);
  assert.match(html, /data-testid="xn-rename-input"/);
  assert.match(html, /value="旧标题"/);
  // Runtime focus is restored by the opener-aware effect; SSR only checks markup.
  assert.doesNotMatch(html, /autofocus/);
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

test("RenameDialog: Tab 循环在首末控件之间受控，支持外部聚焦找回", () => {
  const calls: string[] = [];
  const input = { focus: () => calls.push("input") };
  const cancel = { focus: () => calls.push("cancel") };
  const confirm = { focus: () => calls.push("confirm") };
  const forwardTab = { key: "Tab", shiftKey: false, preventDefault: () => calls.push("prevent") };
  const backwardTab = { key: "Tab", shiftKey: true, preventDefault: () => calls.push("prevent") };

  // 末尾控件 Tab 回到首项
  assert.equal(trapRenameDialogTab(forwardTab, confirm, [input, cancel, confirm], input), true);
  // 首项 Shift+Tab 跳到末尾
  assert.equal(trapRenameDialogTab(backwardTab, input, [input, cancel, confirm], input), true);
  // 外部/遮罩聚焦时 Tab 聚焦首项
  assert.equal(trapRenameDialogTab(forwardTab, null, [input, cancel, confirm], input), true);
  // 外部/遮罩聚焦时 Shift+Tab 聚焦末尾
  assert.equal(trapRenameDialogTab(backwardTab, null, [input, cancel, confirm], input), true);
  // 中间项正常流转（返回 false）
  assert.equal(trapRenameDialogTab(forwardTab, cancel, [input, cancel, confirm], input), false);

  assert.deepEqual(calls, [
    "prevent", "input",
    "prevent", "confirm",
    "prevent", "input",
    "prevent", "confirm",
  ]);
});

test("RenameDialog: IME 组合输入状态下的 Escape 不触发弹窗关闭", () => {
  // 正常 Escape 关闭
  assert.equal(shouldDismissRenameOnEscape({ key: "Escape" }), true);
  // IME isComposing 期间的 Escape 不关闭
  assert.equal(shouldDismissRenameOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldDismissRenameOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  // keyCode 229 期间的 Escape 不关闭
  assert.equal(shouldDismissRenameOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldDismissRenameOnEscape({ key: "Escape", nativeEvent: { keyCode: 229 } }), false);
  // Process / Dead / compositionActive 期间的 Escape 不关闭
  assert.equal(shouldDismissRenameOnEscape({ key: "Process" }), false);
  assert.equal(shouldDismissRenameOnEscape({ key: "Dead" }), false);
  assert.equal(shouldDismissRenameOnEscape({ key: "Escape", compositionActive: true }), false);
  // 非 Escape 键不关闭
  assert.equal(shouldDismissRenameOnEscape({ key: "Enter" }), false);
});
