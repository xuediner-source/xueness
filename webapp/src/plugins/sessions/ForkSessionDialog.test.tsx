import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForkBoundaryChoices, ForkSessionDialog, shouldDismissForkDialogOnEscape, trapForkDialogTab } from "./ForkSessionDialog";
import type { ForkBoundary } from "../../xuenessWorkbench";

const boundaries: ForkBoundary[] = [
  { token: "opaque-selector-a", turn: 1, endIndex: 4, preview: "Initial request" },
  { token: "opaque-selector-b", turn: 4, endIndex: 18, preview: "Follow-up question" },
];

test("fork boundary choices display server turn numbers and previews without exposing selector or message index", () => {
  const html = renderToStaticMarkup(<ForkBoundaryChoices boundaries={boundaries} selectedToken="opaque-selector-b" onSelect={() => undefined} />);
  assert.match(html, /第 1 轮结束/);
  assert.match(html, /第 4 轮结束/);
  assert.match(html, /Initial request/);
  assert.match(html, /Follow-up question/);
  assert.match(html, /aria-checked="true"/);
  assert.doesNotMatch(html, /opaque-selector-[ab]|endIndex|>4<|>18</);
});

test("fork dialog asks the user to select a safe boundary and supports an optional title", () => {
  const html = renderToStaticMarkup(<ForkSessionDialog open sourceId="session-1" sourceTitle="Research" onCancel={() => undefined} onFork={() => undefined} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /分叉会话/);
  assert.match(html, /新会话标题（可选）/);
  assert.match(html, /待审批操作与旧会话的审批状态不会复制/);
  assert.match(html, /不会自动调用模型或工具/);
});

test("fork dialog traps Tab at both boundaries and handles focus outside the dialog", () => {
  const calls: string[] = [];
  const first = { focus: () => calls.push("first") };
  const middle = { focus: () => calls.push("middle") };
  const last = { focus: () => calls.push("last") };
  const dialog = { focus: () => calls.push("dialog") };
  const forwardTab = { key: "Tab", shiftKey: false, preventDefault: () => calls.push("prevent") };
  const backwardTab = { key: "Tab", shiftKey: true, preventDefault: () => calls.push("prevent") };

  // Tab from last wraps to first
  assert.equal(trapForkDialogTab(forwardTab, last, [first, middle, last], dialog), true);
  // Shift+Tab from first wraps to last
  assert.equal(trapForkDialogTab(backwardTab, first, [first, middle, last], dialog), true);
  // Outside focus with Tab goes to first
  assert.equal(trapForkDialogTab(forwardTab, null, [first, middle, last], dialog), true);
  // Outside focus with Shift+Tab goes to last
  assert.equal(trapForkDialogTab(backwardTab, null, [first, middle, last], dialog), true);
  // Empty items focuses fallback container
  assert.equal(trapForkDialogTab(forwardTab, null, [], dialog), true);
  // Middle items let browser handle tab naturally
  assert.equal(trapForkDialogTab(forwardTab, middle, [first, middle, last], dialog), false);
  assert.equal(trapForkDialogTab(backwardTab, middle, [first, middle, last], dialog), false);

  assert.deepEqual(calls, [
    "prevent", "first",
    "prevent", "last",
    "prevent", "first",
    "prevent", "last",
    "prevent", "dialog",
  ]);
});

test("fork dialog Escape dismissal guards against IME composition and busy state", () => {
  // Normal Escape dismisses dialog
  assert.equal(shouldDismissForkDialogOnEscape({ key: "Escape" }, false), true);
  // Escape while busy is ignored
  assert.equal(shouldDismissForkDialogOnEscape({ key: "Escape" }, true), false);
  // Escape while composing IME is ignored
  assert.equal(shouldDismissForkDialogOnEscape({ key: "Escape", isComposing: true }, false), false);
  // Escape with keyCode 229 (IME composition) is ignored
  assert.equal(shouldDismissForkDialogOnEscape({ key: "Escape", keyCode: 229 }, false), false);
  // Non-Escape key is ignored
  assert.equal(shouldDismissForkDialogOnEscape({ key: "Enter" }, false), false);
});
