/** ApplyPatch touches several files: every path is resolved and authorized on its own. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setup } from "./support.ts";

const patch = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

describe("apply_patch through the bridge", () => {
  it("refuses the whole patch when a deny rule covers any touched path", async () => {
    const s = await setup({ settings: { mode: "yolo", deny: ["edit(secrets/**)"] } });
    writeFileSync(join(s.workspace, "a.txt"), "a\n");
    const result = await s.bridge.call({ id: "p1", name: "apply_patch", input: { patch_text: patch("*** Update File: a.txt\n@@\n-a\n+A\n*** Add File: ./secrets/../secrets/k.txt\n+leak") } });
    assert.deepEqual([result.error?.code, result.data], ["permission_denied", { reason: "denied_by_rule", rule: "edit(secrets/**)" }]);
    assert.equal(readFileSync(join(s.workspace, "a.txt"), "utf8"), "a\n");
    assert.equal(existsSync(join(s.workspace, "secrets")), false);
    const moved = await s.bridge.call({ id: "p2", name: "apply_patch", input: { patch_text: patch("*** Update File: a.txt\n*** Move to: secrets/a.txt\n@@\n-a\n+A") } });
    assert.equal(moved.error?.code, "permission_denied");
    assert.equal(readFileSync(join(s.workspace, "a.txt"), "utf8"), "a\n");
    await s.close();
  });

  it("rejects a path outside the workspace or through an escaping link before asking", async () => {
    let asked = 0;
    const s = await setup({ approver: async () => { asked += 1; return { behavior: "allow" }; } });
    symlinkSync(tmpdir(), join(s.workspace, "out"), process.platform === "win32" ? "junction" : "dir");
    for (const target of ["../x.txt", "out/x.txt"]) {
      const result = await s.bridge.call({ id: `o-${target}`, name: "apply_patch", input: { patch_text: patch(`*** Add File: ok.txt\n+1\n*** Add File: ${target}\n+2`) } });
      assert.equal(result.error?.code, "path_outside_workspace", target);
    }
    assert.equal(asked, 0);
    assert.equal(existsSync(join(s.workspace, "ok.txt")), false);
    const bad = await s.bridge.call({ id: "b1", name: "apply_patch", input: { patch_text: "nope" } });
    assert.equal(bad.error?.code, "apply_patch_invalid_patch");
    await s.close();
  });

  it("asks for each path in default mode and applies once all are approved", async () => {
    const subjects: string[] = [];
    const s = await setup({ approver: async (request) => { subjects.push(String((request as { subject?: unknown }).subject)); return { behavior: "allow" }; } });
    const result = await s.bridge.call({ id: "m1", name: "apply_patch", input: { patch_text: patch("*** Add File: one.txt\n+1\n*** Add File: two.txt\n+2") } });
    assert.equal(result.ok, true, result.output);
    assert.deepEqual(subjects, ["one.txt", "two.txt"]);
    await s.close();
  });
});
