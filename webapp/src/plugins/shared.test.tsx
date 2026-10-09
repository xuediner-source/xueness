import test from "node:test";
import assert from "node:assert/strict";
import { shouldDismissModalOnEscape } from "./shared";
import { isImeComposingEvent } from "../xuenessShortcutDisplay";

test("modal Escape preserves IME confirmation and pending destructive actions", () => {
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }), true);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  // React 合成事件中 isComposing 为 false 但原生事件仍处于 composing 态
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", isComposing: false, nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", compositionActive: true }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }, true), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Enter" }), false);
});

test("isImeComposingEvent detects full matrix of IME signals", () => {
  assert.equal(isImeComposingEvent(null), false);
  assert.equal(isImeComposingEvent({}), false);
  assert.equal(isImeComposingEvent({ isComposing: true }), true);
  assert.equal(isImeComposingEvent({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeComposingEvent({ keyCode: 229 }), true);
  assert.equal(isImeComposingEvent({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isImeComposingEvent({ key: "Process" }), true);
  assert.equal(isImeComposingEvent({ key: "Dead" }), true);
  assert.equal(isImeComposingEvent({ compositionActive: true }), true);
  assert.equal(isImeComposingEvent({ isComposing: false, keyCode: 13, key: "Enter" }), false);
});
