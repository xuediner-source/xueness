import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldDismissModalOnEscape } from "../shared";
import { FullAccessConfirmationDialog, requiresYoloConfirmation } from "./FullAccessConfirmationDialog";

test("full-access confirmation states exactly which boundaries remain", () => {
  const closed = renderToStaticMarkup(
    <FullAccessConfirmationDialog open={false} onCancel={() => {}} onConfirm={() => {}} />,
  );
  assert.equal(closed, "");

  const html = renderToStaticMarkup(
    <FullAccessConfirmationDialog open onCancel={() => {}} onConfirm={() => {}} />,
  );
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /跳过常规的单项工具审批/);
  assert.match(html, /内置文件工具仍受工作区路径边界限制/);
  assert.match(html, /本地命令以当前操作系统账户运行/);
  assert.match(html, /可能访问工作区外文件/);
  assert.match(html, /公网 HTTPS/);
  assert.match(html, /远程 SSH 命令仍需单独确认/);
  assert.match(html, /操作系统权限仍适用/);
  assert.match(html, /data-testid="full-access-cancel"/);
  assert.match(html, /data-testid="full-access-confirm"/);
  assert.doesNotMatch(html, /autofocus/i);
});

test("only a new or unacknowledged yolo choice needs confirmation", () => {
  assert.equal(requiresYoloConfirmation("build", "yolo", false), true);
  assert.equal(requiresYoloConfirmation("plan", "yolo", true), true);
  assert.equal(requiresYoloConfirmation("yolo", "yolo", true), false);
  assert.equal(requiresYoloConfirmation("yolo", "yolo", false), true);
  assert.equal(requiresYoloConfirmation("build", "edit", false), false);
});

test("Escape dismisses the modal only after IME composition has finished", () => {
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }), true);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Enter" }), false);
});
