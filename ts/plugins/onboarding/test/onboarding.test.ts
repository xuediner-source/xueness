/** Desktop onboarding flag. Only `/api/onboarding/desktop` is owned. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { createOnboardingHttp } from "../src/index.ts";

const PATH = ["api", "onboarding", "desktop"] as const;

describe("onboarding", () => {
  it("requires the desktop host and an exact completed true", () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-onboarding-`);
    const enabled = (id: string): boolean => id === "onboarding" || id === "desktop";
    try {
      const bare = createOnboardingHttp({ stateDir: state, enabled, desktop: false });
      assert.deepEqual(bare.dispatch("GET", PATH, {}, null), [403, { error: "desktop host required" }]);
      const noDesktopPlugin = createOnboardingHttp({ stateDir: state, enabled: (id) => id === "onboarding", desktop: true });
      assert.deepEqual(noDesktopPlugin.dispatch("GET", PATH, {}, null), [403, { error: "desktop plugin unavailable", plugin: "desktop" }]);
      const http = createOnboardingHttp({ stateDir: state, enabled, desktop: true });
      assert.deepEqual(http.dispatch("GET", PATH, {}, null), [200, { completed: false, version: 1 }]);
      assert.deepEqual(http.dispatch("POST", PATH, {}, { completed: 1 }), [400, { error: "expected completed true only" }]);
      assert.deepEqual(http.dispatch("PUT", PATH, {}, { completed: true }), [405, { error: "method not allowed" }]);
      assert.deepEqual(http.dispatch("POST", PATH, {}, { completed: true }), [200, { completed: true, version: 1 }]);
      assert.deepEqual(http.dispatch("GET", PATH, {}, null), [200, { completed: true, version: 1 }]);
      assert.equal(http.owns("GET", ["api", "onboarding"]), false);
      assert.equal(http.dispatch("GET", ["api", "onboarding"], {}, null), null);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("uses the kernel disabled body and no code field", () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-onboarding-`);
    try {
      const http = createOnboardingHttp({ stateDir: state, enabled: () => false, desktop: true });
      const denied = http.dispatch("GET", PATH, {}, null);
      assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: onboarding", plugin: "onboarding" }]);
      assert.equal(Object.hasOwn(denied?.[1] as object, "code"), false);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});
