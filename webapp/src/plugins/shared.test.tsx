import test from "node:test";
import assert from "node:assert/strict";
import { shouldDismissModalOnEscape } from "./shared";

test("modal Escape preserves IME confirmation and pending destructive actions", () => {
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }), true);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Escape" }, true), false);
  assert.equal(shouldDismissModalOnEscape({ key: "Enter" }), false);
});
