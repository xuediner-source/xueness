/** Dry-run stays off, and call-budget owns only its own path. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { beforeToolExecution, createToolsHttp, reserve } from "../src/index.ts";

const SID = "ab".repeat(16);

describe("tools", () => {
  it("does not deny while dry-run is off and does not own other tools paths", async () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-tools-`);
    const workspace = join(state, "ws");
    mkdirSync(workspace, { recursive: true });
    const root = realpathSync(workspace);
    const previous = process.env.XUENESS_TOOLS_DRY_RUN;
    delete process.env.XUENESS_TOOLS_DRY_RUN;
    try {
      assert.equal(beforeToolExecution({ tool: "exec", state_dir: state, mutating: true, args: { argv: ["git", "status"] } }), null);
      const http = createToolsHttp({
        stateDir: state, enabled: true, allowedRoots: () => [root],
        store: { load: async (sid: string) => sid === SID ? { id: sid, root, messages: [] } : Promise.reject(Object.assign(new Error("missing"), { name: "FileNotFoundError" })) },
      });
      assert.equal(http.owns("GET", ["api", "tools"]), false);
      assert.equal(await http.dispatch("GET", ["api", "tools"], {}), null);
      const denied = await createToolsHttp({ stateDir: state, enabled: false, store: null }).dispatch("GET", ["api", "tools", "call-budget"], { session: [SID] });
      assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: tools", plugin: "tools" }]);
      assert.equal(Object.hasOwn(denied?.[1] as object, "code"), false);
      assert.deepEqual(await http.dispatch("GET", ["api", "tools", "call-budget"], { session: ["a", "b"] }), [400, { error: "expected one session id" }]);
      assert.deepEqual(await http.dispatch("POST", ["api", "tools", "call-budget"], { session: [SID] }), [405, { error: "method not allowed" }]);
      assert.deepEqual(await http.dispatch("GET", ["api", "tools", "call-budget"], { session: [SID] }), [200, { enabled: false }]);
      assert.equal(reserve(state, { id: SID, messages: [] }, "call-1"), null);
    } finally {
      if (previous === undefined) delete process.env.XUENESS_TOOLS_DRY_RUN;
      else process.env.XUENESS_TOOLS_DRY_RUN = previous;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("refuses a mutating tool when the environment override is on", () => {
    const previous = process.env.XUENESS_TOOLS_DRY_RUN;
    process.env.XUENESS_TOOLS_DRY_RUN = "on";
    try {
      const decision = beforeToolExecution({ tool: "web_search", state_dir: null, gate: "web_search", mutating: true }) as { decision: string };
      assert.equal(decision.decision, "deny");
    } finally {
      if (previous === undefined) delete process.env.XUENESS_TOOLS_DRY_RUN;
      else process.env.XUENESS_TOOLS_DRY_RUN = previous;
    }
  });
});
