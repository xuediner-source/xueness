/**
 * The Windows job object holding this host's exec children. `taskkill /T /F`
 * only walks the tree at kill time and never runs when the host dies without
 * reaching its exit hook; `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is the kernel's
 * answer to that case, which is what the last test covers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { hostWindowsJob } from "../src/windows-job.ts";

const windows = process.platform === "win32" ? false : "Windows job objects";
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitFor = async (check: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return true;
    await new Promise((ready) => setTimeout(ready, 50));
  }
  return check();
};
const readPid = (path: string): number | null => {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
};

/** A Node one-liner that keeps running until killed. */
const sleeper = "setTimeout(() => {}, 120000)";

describe("Windows job object", () => {
  it("creates the host job and assigns a spawned child to it", { skip: windows }, async () => {
    const job = hostWindowsJob();
    assert.ok(job, "the host job is created on Windows");
    const child = spawn(process.execPath, ["-e", sleeper], { stdio: "ignore", windowsHide: true });
    assert.ok(child.pid);
    try {
      assert.equal(job.assign(child.pid), true, "the child is assigned to the job");
      assert.equal(job.contains(child.pid), true, "the child reports as a job member");
    } finally {
      child.kill("SIGKILL");
    }
    await waitFor(() => !alive(child.pid!));
  });

  it("puts a grandchild in the job by inheritance, not by assignment", { skip: windows }, async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-job-inherit-"));
    const pidFile = join(base, "grandchild.pid");
    // The child process itself starts the grandchild, so membership can only
    // come from inheritance: the host never sees the grandchild's pid.
    const script = [
      `const { spawn } = require("node:child_process");`,
      `const { writeFileSync } = require("node:fs");`,
      `const g = spawn(process.execPath, ["-e", ${JSON.stringify(sleeper)}], { stdio: "ignore", windowsHide: true });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      `setTimeout(() => {}, 120000);`,
    ].join("\n");
    const job = hostWindowsJob();
    assert.ok(job);
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true });
    assert.ok(child.pid);
    try {
      assert.equal(job.assign(child.pid), true, "the child joins the job");
      assert.equal(await waitFor(() => readPid(pidFile) !== null), true, "the child started the grandchild");
      const grandchild = readPid(pidFile)!;
      try {
        assert.equal(await waitFor(() => job.contains(grandchild)), true, "the grandchild inherits the job");
      } finally {
        try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ }
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("ends the child when the host dies without running its exit hook", { skip: windows }, async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-job-host-"));
    const pidFile = join(base, "child.pid");
    // The helper creates the job, spawns a long-lived child, records its pid and
    // then waits to be killed: no exit hook, no taskkill, just a dying host.
    const helper = join(base, "host.mjs");
    writeFileSync(helper, [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      // ESM specifiers are URLs: a bare Windows path would be rejected by the loader.
      `import { hostWindowsJob } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "windows-job.ts")).href)};`,
      `const job = hostWindowsJob();`,
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(sleeper)}], { stdio: "ignore", windowsHide: true });`,
      `job.assign(child.pid);`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      `setTimeout(() => {}, 120000);`,
    ].join("\n"));
    const host = spawn(process.execPath, [helper], { stdio: "ignore", windowsHide: true });
    assert.ok(host.pid);
    try {
      assert.equal(await waitFor(() => readPid(pidFile) !== null), true, "the helper recorded its child");
      const childPid = readPid(pidFile)!;
      assert.equal(alive(childPid), true, "the child runs before the host dies");
      // SIGKILL: the host never reaches an exit handler, so only the job can act.
      host.kill("SIGKILL");
      assert.equal(await waitFor(() => !alive(childPid)), true, "closing the job handle ended the child");
    } finally {
      host.kill("SIGKILL");
      rmSync(base, { recursive: true, force: true });
    }
  });
});
