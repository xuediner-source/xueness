import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/**
 * Command-node execution: exit status, log capture and capping, cancellation,
 * timeout, and the workspace-lease refusals (Python `_execute` command branch
 * plus `windows.py`). Every argv is `node -e ...` so the tests are portable.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { executeCommandNode, LOG_LIMIT, type RunControl } from "../src/execute-command.ts";
import { WorkflowStore } from "../src/store.ts";
import type { Row } from "../src/plan.ts";

const WID = "a".repeat(32);
const NODE = "build";

/** A store with one running record whose single command node runs `argv`. */
function fixture(argv: string[], options: { cwd?: string; timeout?: number } = {}): { store: WorkflowStore; record: Row; spec: Row; root: string; cleanup: () => void } {
  const state = mkdtempSync(join(tmpdir(), "xueness-command-state-"));
  const root = mkdtempSync(join(tmpdir(), "xueness-command-workspace-"));
  const store = new WorkflowStore(state);
  const record: Row = {
    id: WID, root, control: "run", status: "running",
    plan: { name: "test", concurrency: 1, nodes: [] },
    nodes: { [NODE]: { status: "running", attempts: 1 } },
  };
  store.save(record);
  const spec: Row = { id: NODE, kind: "command", needs: [], argv, cwd: options.cwd ?? ".", timeout: options.timeout ?? 300 };
  return { store, record, spec, root, cleanup: () => { rmSync(state, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

function controlOf(overrides: Partial<RunControl> = {}): RunControl {
  return { control: () => "run", ownerGone: () => false, ...overrides };
}

/**
 * A directory link at `path`, which `lstat` reports as a symbolic link — the
 * condition the lease guards read. Windows only lets a privileged process
 * create a real symlink, but a junction needs no privilege and reports the same.
 */
function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** True once `pid` no longer exists. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("executeCommandNode", () => {
  it("completes a successful command and logs its stdout", async () => {
    const f = fixture([process.execPath, "-e", "process.stdout.write('hello-log')"]);
    try {
      const result = await executeCommandNode(f.store, f.record, f.spec, controlOf());
      assert.equal(result.status, "completed");
      assert.equal(result.exit_code, 0);
      assert.equal(result.error, "");
      assert.equal(result.log_capped, false);
      assert.equal(typeof result.duration, "number");
      assert.ok((result.duration as number) >= 0);
      assert.match(readFileSync(f.store.path(WID, "." + NODE + ".log"), "utf8"), /hello-log/);
      // The pid is on the row before the command streams, so it is still there.
      assert.equal(typeof (f.store.load(WID).nodes as Record<string, Row>)[NODE]!.pid, "number");
    } finally {
      f.cleanup();
    }
  });

  it("reports a failing command with its exit code", async () => {
    const f = fixture([process.execPath, "-e", "process.exit(7)"]);
    try {
      const result = await executeCommandNode(f.store, f.record, f.spec, controlOf());
      assert.equal(result.status, "failed");
      assert.equal(result.exit_code, 7);
      assert.equal(result.error, "");
    } finally {
      f.cleanup();
    }
  });

  it("cancels a running command and kills its process", async () => {
    const f = fixture([process.execPath, "-e", "setTimeout(() => {}, 60000); process.stdout.write(String(process.pid))"]);
    let pid = 0;
    try {
      const deadline = Date.now() + 10000;
      const pending = executeCommandNode(f.store, f.record, f.spec, controlOf({
        control: () => (Date.now() > deadline - 9500 ? "cancel" : "run"),
      }));
      while (Date.now() < deadline) {
        const value = (f.store.load(WID).nodes as Record<string, Row>)[NODE]!.pid;
        if (typeof value === "number") { pid = value; break; }
        await new Promise((done) => setTimeout(done, 25));
      }
      const result = await pending;
      assert.equal(result.status, "cancelled");
      assert.equal(result.error, "cancelled");
      assert.ok(pid > 0, "the node row must record the child pid");
      const stop = Date.now() + 5000;
      while (!gone(pid) && Date.now() < stop) await new Promise((done) => setTimeout(done, 25));
      assert.ok(gone(pid), `child ${pid} must be gone after cancellation`);
    } finally {
      f.cleanup();
    }
  });

  it("fails a command that outruns its timeout", async () => {
    const f = fixture([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { timeout: 0.3 });
    try {
      const result = await executeCommandNode(f.store, f.record, f.spec, controlOf());
      assert.equal(result.status, "failed");
      assert.equal(result.error, "timeout");
      assert.ok((result.duration as number) >= 0.3);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a symlinked lease file", async () => {
    const f = fixture([process.execPath, "-e", "0"]);
    try {
      const leases = join(f.store.directory, ".workspaces");
      mkdirSync(leases, { recursive: true });
      const key = createHash("sha256").update(f.root, "utf8").digest("hex");
      directoryLink(f.root, join(leases, key));
      await assert.rejects(
        executeCommandNode(f.store, f.record, f.spec, controlOf()),
        (error: unknown) => error instanceof PyValueError && error.message === "invalid workspace lease",
      );
    } finally {
      f.cleanup();
    }
  });

  it("refuses a symlinked lease directory", async () => {
    const f = fixture([process.execPath, "-e", "0"]);
    try {
      directoryLink(f.root, join(f.store.directory, ".workspaces"));
      await assert.rejects(
        executeCommandNode(f.store, f.record, f.spec, controlOf()),
        (error: unknown) => error instanceof PyValueError && error.message === "invalid workspace lease directory",
      );
    } finally {
      f.cleanup();
    }
  });

  it("does not mark a small log as capped", async () => {
    const f = fixture([process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"]);
    try {
      const result = await executeCommandNode(f.store, f.record, f.spec, controlOf());
      assert.equal(result.status, "completed");
      assert.equal(result.log_capped, false);
      const log = f.store.path(WID, "." + NODE + ".log");
      assert.ok(existsSync(log));
      assert.equal(readFileSync(log).length, 4096);
      assert.ok(4096 < LOG_LIMIT);
    } finally {
      f.cleanup();
    }
  });
});
