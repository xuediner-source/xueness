/** Update HTTP stays unsupported without a desktop bridge, and source check refuses a repo with no origin. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { check, createUpdatesHttp } from "../src/index.ts";

const enabled = (id: string): boolean => id === "updates" || id === "desktop";

describe("updates", () => {
  it("rejects a non-boolean setting and an extra prepare body", () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-updates-`);
    const http = createUpdatesHttp({ stateDir: state, enabled, desktopToken: "token", bridge: { request: () => ({ state: { phase: "idle" } }) } });
    try {
      assert.equal(http.owns("GET", ["api", "workflows"]), false);
      const bare = createUpdatesHttp({ stateDir: state, enabled });
      assert.deepEqual(bare.dispatch("GET", ["api", "updates", "status"], {}, {}), [200, { phase: "unsupported", reason: "应用内更新需使用桌面安装版。", canInstall: false, canDownload: false, installMode: "unsupported" }]);
      assert.deepEqual(http.dispatch("POST", ["api", "updates", "settings"], {}, { autoDownload: 1 }), [400, { error: "expected autoDownload boolean" }]);
      assert.deepEqual(http.dispatch("POST", ["api", "updates", "prepare-install"], {}, { checkOnly: true, extra: 1 }), [400, { error: "expected empty body" }]);
      assert.deepEqual(http.dispatch("POST", ["api", "updates", "download"], {}, { version: "1.2" }), [400, { error: "invalid update version" }]);
      assert.deepEqual(http.dispatch("POST", ["api", "updates", "download"], {}, { version: "1.2.3" }), [200, { phase: "idle" }]);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("does not fetch a repository that has no origin", async () => {
    if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) return;
    const root = mkdtempSync(`${tmpdir()}\\xueness-update-repo-`);
    try {
      assert.equal(spawnSync("git", ["init"], { cwd: root, windowsHide: true }).status, 0);
      writeFileSync(join(root, "README"), "temp");
      await assert.rejects(() => check(root), /origin|checkout|branch|git command failed/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
