/**
 * F05.05 — the cross-platform execution adaptation matrix.
 *
 * `executionPlatformMatrix` states the documented capability differences of
 * Linux, macOS and Windows; `probeExecutionPlatform` runs targeted live
 * probes on this machine so the matrix is verified against reality: the
 * default shell really runs, a POSIX process group really dies as a group,
 * and the Windows host job object (crash cleanup) is really in place.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executionPlatformMatrix, probeExecutionPlatform } from "../src/index.ts";
import { defaultShell } from "../src/exec.ts";
import { nodePty } from "../src/pty.ts";
import { hostWindowsJob } from "../src/windows-job.ts";

describe("execution platform matrix", () => {
  it("documents the three platforms' capability differences", () => {
    const linux = executionPlatformMatrix("linux");
    const darwin = executionPlatformMatrix("darwin");
    assert.deepEqual(linux, {
      platform: "linux", shell: "posix", envCaseInsensitive: false, processGroups: true, treeKill: "process-group", crashCleanup: "exit-hook",
    });
    assert.deepEqual({ ...darwin, platform: linux.platform }, linux, "macOS and Linux share the POSIX matrix");
    assert.deepEqual(executionPlatformMatrix("win32"), {
      platform: "win32", shell: "powershell", envCaseInsensitive: true, processGroups: false, treeKill: "taskkill", crashCleanup: "job-object",
    });
    const windows = executionPlatformMatrix("win32");
    assert.equal(executionPlatformMatrix(process.platform).shell, process.platform === "win32" ? "powershell" : "posix");
    assert.notEqual(windows.treeKill, linux.treeKill, "Windows kills trees with taskkill, not groups");
    assert.notEqual(windows.crashCleanup, linux.crashCleanup, "only Windows keeps a job object for host crashes");
  });

  it("matches the default shell the exec tool uses", () => {
    const shell = defaultShell();
    assert.equal(executionPlatformMatrix().shell === "powershell", /powershell/i.test(shell[0] ?? ""));
    assert.equal(shell.length >= 2, true);
  });

  it("probes this machine: the shell runs, groups die as groups, crash cleanup matches the platform", { timeout: 60_000 }, async () => {
    // CI Windows can cold-start PowerShell under a busy full-suite runner.
    // Keep the exact argv, exit status and output assertions; allow startup headroom.
    const probes = await probeExecutionPlatform({ timeoutMs: 25_000 });
    assert.equal(probes.platform, process.platform);
    assert.deepEqual(probes.shell.argv.slice(0, -1), defaultShell(), "the probe runs the default shell itself");
    assert.equal(probes.shell.ok, true, `default shell probe failed: ${probes.shell.output}`);
    assert.match(probes.shell.output, /probe-ok/);
    if (process.platform === "win32") {
      assert.equal(probes.groupKill, null, "the group probe does not apply on Windows");
      assert.equal(probes.jobObject, hostWindowsJob() !== null, "the job object probe reports the live host job");
      assert.equal(executionPlatformMatrix().crashCleanup, "job-object");
    } else {
      assert.equal(probes.groupKill, true, "SIGTERM to the child's group must kill the grandchild too");
      assert.equal(probes.jobObject, null, "there is no job object off Windows");
      assert.equal(executionPlatformMatrix().crashCleanup, "exit-hook");
    }
    assert.equal(probes.pty, nodePty() !== null, "the PTY probe reflects the loaded backend");
  });
});
