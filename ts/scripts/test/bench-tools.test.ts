import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pythonUnavailableReason } from "../../test-support/python-oracle.ts";
import { runPythonBench } from "../bench/python-side.ts";
import { formatReport, runToolBench } from "../bench/tools-bench.ts";
import { buildWorkspace } from "../bench/workspace.ts";

describe("Xueness-bench tools", { skip: process.platform === "win32" ? "POSIX commands" : false }, () => {
  it("passes every P0 check through the bridge and times every tool", async () => {
    const report = await runToolBench({ files: 60, deps: 120, iterations: 1, python: false });
    assert.deepEqual(report.checks.filter((row) => !row.pass), []);
    assert.deepEqual(report.checks.map((row) => row.id), ["crlf", "gbk", "ignore", "missing", "timeout"]);
    assert.deepEqual(report.speed.map((row) => row.id), ["glob", "grep_literal", "grep_regex", "read", "edit", "exec", "classify", "bridge"]);
    for (const row of report.speed) assert.ok(Number.isFinite(row.value), row.id);
    assert.deepEqual(report.python, { skipped: "--no-python" });
    assert.match(formatReport(report), /^Xueness-bench tools/);
  });

  it("shows the P0 problems in the Python handlers on the same workspace", { skip: pythonUnavailableReason() ?? false }, () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-bench-py-"));
    try {
      buildWorkspace(root, { files: 60, deps: 120 });
      const { result, reason } = runPythonBench(root, 1);
      assert.equal(reason, null);
      const failing = Object.entries(result?.checks ?? {}).filter(([, check]) => !check.pass).map(([id]) => id);
      assert.deepEqual(failing, ["crlf", "gbk", "ignore", "timeout"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
