/** Diagnostics prefix, cutoff rules, and settled-log cleanup. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDiagnosticsHttp } from "../src/index.ts";

const NOW = 1_700_000_000;
const OLD = "a".repeat(32);
const LIVE = "b".repeat(32);

describe("diagnostics", () => {
  it("owns the prefix, rejects a bad cutoff, and deletes only a settled log", async () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-diagnostics-"));
    const workflows = join(state, "workflows");
    mkdirSync(workflows);
    writeFileSync(join(workflows, `${OLD}.json`), JSON.stringify({ id: OLD, status: "completed", updated_at: NOW - 10 * 86400 }));
    writeFileSync(join(workflows, `${OLD}.worker.log`), "old");
    writeFileSync(join(workflows, `${LIVE}.json`), JSON.stringify({ id: LIVE, status: "running", updated_at: NOW - 10 * 86400 }));
    writeFileSync(join(workflows, `${LIVE}.worker.log`), "live");
    const http = createDiagnosticsHttp({
      stateDir: state, enabled: true, now: () => NOW,
      store: { list: () => [{ status: "completed" }, {}] },
      catalog: () => [{ id: "diagnostics", effective: true, version: "1.0.0" }],
    });
    try {
      assert.equal(http.owns("GET", ["api", "workflows"]), false);
      assert.equal(await http.dispatch("GET", ["api", "workflows"], {}, {}), null);
      const denied = await createDiagnosticsHttp({ stateDir: state, enabled: false, store: { list: () => [] } }).dispatch("GET", ["api", "diagnostics"], {}, {});
      assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: diagnostics", plugin: "diagnostics" }]);
      assert.equal(Object.hasOwn(denied?.[1] as object, "code"), false);
      assert.deepEqual(await http.dispatch("POST", ["api", "diagnostics", "cleanup"], {}, { confirmed: 1, olderThanDays: 1 }), [400, { error: "confirmed cutoff required" }]);
      assert.deepEqual(await http.dispatch("POST", ["api", "diagnostics", "cleanup"], {}, { confirmed: true, olderThanDays: true }), [400, { error: "confirmed cutoff required" }]);
      assert.deepEqual(await http.dispatch("POST", ["api", "diagnostics", "cleanup"], {}, { confirmed: true, olderThanDays: 0 }), [400, { error: "confirmed cutoff required" }]);
      const cleaned = await http.dispatch("POST", ["api", "diagnostics", "cleanup"], {}, { confirmed: true, olderThanDays: 1 });
      assert.deepEqual(cleaned, [200, { removedLogs: 1 }]);
      const report = await http.dispatch("GET", ["api", "diagnostics", "export"], {}, {});
      assert.equal(report?.[0], 200);
      const body = report?.[1] as { schema: string; redacted: boolean; sessions: Record<string, number> };
      assert.equal(body.schema, "xueness.diagnostics.v1");
      assert.equal(body.redacted, true);
      assert.equal(body.sessions.completed, 1);
      assert.equal(body.sessions.unknown, 1);
      assert.deepEqual(await http.dispatch("POST", ["api", "diagnostics", "runtime"], {}, {}), [405, { error: "method not allowed" }]);
      assert.deepEqual(await http.dispatch("GET", ["api", "diagnostics", "nope"], {}, {}), [405, { error: "method not allowed" }]);
      const runtime = await http.dispatch("GET", ["api", "diagnostics", "runtime"], {}, {});
      assert.equal(runtime?.[0], 200);
      assert.equal((runtime?.[1] as { gpu: { available: boolean; reason: string } }).gpu.reason, "GPU 内存遥测不可用于本地运行时采样。");
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});
