import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setup } from "./support.ts";

describe("guarded one-time approvals", () => {
  it("rejects persistent approver updates and accepts an empty remember list as once", async () => {
    let count = 0;
    const s = await setup({
      settings: {
        mode: "guarded",
        guarded: (request) => request.kind === "exec" && /\brm\s+-r\b/.test(request.subject)
          ? { ruleId: "guarded.remove-tree", message: "needs one-time approval" }
          : null,
      },
      approver: () => {
        count += 1;
        if (count === 1) return { behavior: "allow", permissionUpdates: ["exec(rm *)"] } as unknown as { behavior: "allow" };
        return { behavior: "allow", remember: count === 2 ? ["exec(rm *)"] : [] };
      },
    });
    const sentinel = join(s.workspace, "sentinel.txt");
    writeFileSync(sentinel, "keep until a one-time approval\n");
    const rejected = await s.bridge.call({ id: "g1", name: "exec", input: { command: "rm -r sentinel.txt" } });
    assert.deepEqual([rejected.error?.code, rejected.data], ["permission_denied", { reason: "guarded_once_only" }]);
    assert.equal(existsSync(sentinel), true, "a persistent approver answer does not execute the command");
    assert.deepEqual(s.permissions.rememberedRules, []);

    const remembered = await s.bridge.call({ id: "g2", name: "exec", input: { command: "rm -r sentinel.txt" } });
    assert.deepEqual([remembered.error?.code, remembered.data], ["permission_denied", { reason: "guarded_once_only" }]);
    assert.equal(existsSync(sentinel), true, "a non-empty remember answer does not execute the command");
    assert.deepEqual(s.permissions.rememberedRules, []);

    const approved = await s.bridge.call({ id: "g3", name: "exec", input: { command: "rm -r sentinel.txt" } });
    assert.equal(approved.ok, true);
    assert.equal(existsSync(sentinel), false, "an empty remember list is treated as one-time approval");
    assert.deepEqual(s.permissions.rememberedRules, []);
    await s.close();
  });
});
