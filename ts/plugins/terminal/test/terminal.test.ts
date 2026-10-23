/** Terminal HTTP refuses remote sessions and opens nothing unless asked. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Broker, createTerminalHttp } from "../src/index.ts";

describe("terminal", () => {
  it("keeps remote sessions and incomplete opens off the broker", async () => {
    const broker = new Broker();
    const http = createTerminalHttp({
      enabled: true, broker, allowedRoot: (root) => root, defaultShell: () => undefined,
      store: { load: async (sid: string) => sid === "remote" ? { id: sid, root: "C:\\ws", remote_connection: null } : { id: sid, root: "C:\\ws" } },
    });
    try {
      assert.equal(http.owns("GET", ["api", "remote"]), false);
      assert.equal(http.owns("GET", ["api", "workflows"]), false);
      const denied = await createTerminalHttp({ enabled: false, broker, allowedRoot: (root) => root, store: { load: () => ({}) } }).dispatch("GET", ["api", "terminals", "shells"], {}, {});
      assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: terminal", plugin: "terminal" }]);
      assert.equal(Object.hasOwn(denied?.[1] as object, "code"), false);
      assert.deepEqual(await http.dispatch("POST", ["api", "terminals"], {}, {}), [400, { error: "invalid terminal operation or unavailable workspace" }]);
      assert.equal(broker.openCount(), 0);
      assert.deepEqual(await http.dispatch("POST", ["api", "terminals"], {}, { open: true, session_id: "remote" }), [409, { error: "remote terminals require a scoped remote adapter", error_code: "remote_terminal_unavailable" }]);
      assert.equal(broker.openCount(), 0);
      const shells = await http.dispatch("GET", ["api", "terminals", "shells"], {}, {});
      assert.equal(shells?.[0], 200);
      assert.ok(Array.isArray((shells?.[1] as { shells: unknown[] }).shells));
    } finally { broker.close(); }
  });
});
