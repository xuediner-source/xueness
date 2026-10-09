import test from "node:test";
import assert from "node:assert/strict";
import { submissionNeedsFullAccessConfirmation } from "./useRunPermissionConfirmation";
import { mergeRunChoices, type RunChoices } from "../../xuenessBridge";

const base: RunChoices = { provider: "real", mode: "build", permission_mode: "build" };
test("loading an existing full-access session does not grant the next draft full access", () => {
  const loaded = mergeRunChoices(base, { permission_mode: "yolo" });
  assert.equal(submissionNeedsFullAccessConfirmation(loaded, "yolo"), false);
  assert.equal(submissionNeedsFullAccessConfirmation(loaded), true);
});
test("explicit confirmation carries through submission; other modes do not prompt", () => {
  assert.equal(submissionNeedsFullAccessConfirmation({ ...base, permission_mode: "yolo", acknowledge_yolo: true }), false);
  for (const permission_mode of ["build", "plan", "edit"] as const) {
    assert.equal(submissionNeedsFullAccessConfirmation({ ...base, permission_mode }), false);
  }
});
