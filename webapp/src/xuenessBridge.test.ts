import test from "node:test";
import assert from "node:assert/strict";
import { getRunChoices, mergeRunChoices, setRunChoices, type RunChoices } from "./xuenessBridge";

const baseline: RunChoices = { provider: "real", mode: "build", permission_mode: "build", browser: false };

test("changing providers clears a runtime override, while restoring a session can set it explicitly", () => {
  const current: RunChoices = { ...baseline, provider_id: "provider-a", runtime_profile: "lightweight" };
  assert.equal(mergeRunChoices(current, { provider_id: "provider-b" }).runtime_profile, undefined);
  assert.equal(mergeRunChoices(current, { runtime_profile: "standard" }).runtime_profile, "standard");
  assert.equal(mergeRunChoices(current, { provider_id: "provider-b", runtime_profile: "lightweight" }).runtime_profile, "lightweight");
});

test("run choices validate and retain the explicit profile through the browser bridge", () => {
  try {
    const selected: RunChoices = { ...baseline, provider_id: "local", runtime_profile: "standard" };
    setRunChoices(selected);
    assert.equal(getRunChoices().runtime_profile, "standard");
    assert.throws(() => setRunChoices({ ...selected, runtime_profile: "tiny" as RunChoices["runtime_profile"] }), /runtime profile/);
  } finally {
    setRunChoices(baseline);
  }
});
