import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolBridge, type ApprovalAnswer, type ApprovalRequest } from "@xueness/tool-bridge";
import { setup } from "./support.ts";

describe("tool bridge permissions", () => {
  it("runs reads at once and returns an ask as approval_required until that call is approved", async () => {
    const s = await setup();
    writeFileSync(join(s.workspace, "a.txt"), "hello\n");
    const read = await s.bridge.call({ id: "r1", name: "read", input: { path: "a.txt" } });
    assert.equal(read.ok, true);
    const write = { id: "w1", name: "write", input: { path: "notes/b.txt", content: "new\n" } };
    const asked = await s.bridge.call(write);
    assert.equal(asked.error?.code, "approval_required");
    assert.equal(asked.user_reason, "等待你批准工具调用；批准后继续。");
    assert.deepEqual(asked.data, {
      awaitingApproval: true, reason: "approval_required", kind: "write", subject: "notes/b.txt",
      remember: { exact: ["edit(notes/b.txt)"], broad: ["edit(notes/**)"] },
    });
    assert.equal(existsSync(join(s.workspace, "notes")), false);
    s.permissions.grantOnce("w1", "write", "notes/b.txt");
    assert.equal((await s.bridge.call(write)).ok, true, "the approved call replays");
    assert.equal(readFileSync(join(s.workspace, "notes/b.txt"), "utf8"), "new\n");
    const again = await s.bridge.call({ ...write, input: { path: "notes/b.txt", content: "newer\n" } });
    assert.equal(again.error?.code, "approval_required", "an approval is spent by one call");
    await s.close();
  });

  it("asks the approver: allow once, remember for the session, or deny", async () => {
    const asked: ApprovalRequest[] = [];
    const answers: ApprovalAnswer[] = [{ behavior: "allow" }, { behavior: "allow", remember: ["exec(node create.cjs *)"] }, { behavior: "deny", message: "not now" }];
    const s = await setup({ approver: (request) => (asked.push(request), answers.shift() ?? { behavior: "deny" }) });
    writeFileSync(join(s.workspace, "create.cjs"), "require('node:fs').writeFileSync(process.argv[2], '')");
    const exec = (id: string, command: string) => s.bridge.call({ id, name: "exec", input: { command } });
    assert.equal((await exec("c1", "node create.cjs one")).ok, true);
    assert.equal((await exec("c2", "node create.cjs two")).ok, true);
    assert.equal((await exec("c3", "node create.cjs three")).ok, true, "covered by the remembered rule");
    assert.deepEqual(asked.map((request) => [request.callId, request.kind, request.subject, request.code]), [
      ["c1", "exec", "node create.cjs one", "approval_required"], ["c2", "exec", "node create.cjs two", "approval_required"],
    ]);
    assert.deepEqual(asked[0]?.remember, { exact: ["exec(node create.cjs one)"], broad: ["exec(node create.cjs *)"] });
    const denied = await exec("c4", "node remove.cjs one");
    assert.deepEqual([denied.error?.code, denied.output, denied.data], ["permission_denied", "not now", { reason: "user_denied" }]);
    assert.ok(existsSync(join(s.workspace, "one")));
    assert.deepEqual(s.permissions.rememberedRules, ["exec(node create.cjs *)"]);
    // Read-only commands never ask; a writing redirection does.
    assert.equal((await exec("c5", "git --version")).ok, true);
    assert.equal(asked.length, 3);
    await exec("c6", "echo hi > one");
    assert.equal(asked.length, 4);
    await s.close();
  });

  it("fails closed on a broken approver and stops asking when the call is cancelled", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    const s = await setup({
      approver: (request) => {
        if (request.callId === "boom") throw new Error("ui crashed");
        if (request.callId === "odd") return { behavior: "maybe" } as unknown as ApprovalAnswer;
        seen = request.signal;
        controller.abort();
        return new Promise<ApprovalAnswer>(() => {});
      },
    });
    const write = (id: string) => s.bridge.call({ id, name: "write", input: { path: "x.txt", content: "x" } }, { signal: controller.signal });
    assert.deepEqual((await s.bridge.call({ id: "boom", name: "write", input: { path: "x.txt", content: "x" } })).error?.code, "permission_denied");
    assert.deepEqual((await s.bridge.call({ id: "odd", name: "write", input: { path: "x.txt", content: "x" } })).error?.code, "permission_denied");
    const result = await write("slow");
    assert.equal(result.error?.code, "cancelled");
    assert.equal((seen as AbortSignal | null)?.aborted, true);
    assert.equal(existsSync(join(s.workspace, "x.txt")), false);
    await s.close();
  });

  it("refuses by rule, mode, run settings and workspace bounds before any effect", async () => {
    const s = await setup({ settings: { mode: "yolo", deny: ["exec(rm *)", "read(secrets/**)"], disallow: ["list"] } });
    const keep = join(s.workspace, "keep.txt");
    writeFileSync(keep, "x");
    const rm = await s.bridge.call({ id: "d1", name: "exec", input: { command: "echo ok && rm keep.txt" } });
    assert.deepEqual([rm.error?.code, rm.data], ["permission_denied", { reason: "denied_by_rule", rule: "exec(rm *)" }]);
    const nested = await s.bridge.call({ id: "d2", name: "exec", input: { command: "bash -c 'rm keep.txt'" } });
    assert.equal(nested.error?.code, "permission_denied");
    assert.ok(existsSync(keep));
    const secret = await s.bridge.call({ id: "d3", name: "read", input: { path: "./secrets/../secrets/key.txt" } });
    assert.deepEqual([secret.error?.code, secret.data], ["permission_denied", { reason: "denied_by_rule", rule: "read(secrets/**)" }]);
    const listed = await s.bridge.call({ id: "d4", name: "list", input: {} });
    assert.deepEqual([listed.error?.code, listed.output], ["permission_denied", "list is disallowed for this run"]);
    assert.equal((await s.bridge.call({ id: "o1", name: "read", input: { path: "../../etc/passwd" } })).error?.code, "path_outside_workspace");
    assert.equal((await s.bridge.call({ id: "u1", name: "nope", input: {} })).error?.code, "unknown_tool");
    assert.equal((await s.bridge.call({ id: "i1", name: "read", input: { path: 3 } })).error?.code, "invalid_argument");
    assert.equal((await s.bridge.call({ id: "", name: "read", input: { path: "keep.txt" } })).error?.code, "invalid_argument");
    s.permissions.setMode("plan");
    const plan = await s.bridge.call({ id: "p1", name: "write", input: { path: "keep.txt", content: "y" } });
    assert.deepEqual([plan.error?.code, plan.output], ["plan_mode_denied", "write denied in plan mode"]);
    assert.equal(readFileSync(keep, "utf8"), "x");
    await s.close();
  });

  it("lets plan mode read and write the session's plan draft outside the workspace, and nothing else", async () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-bridge-state-"));
    const draft = join(state, "plan.md");
    const s = await setup({
      settings: { mode: "plan", planDraft: { path: draft, matches: (subject) => subject === draft, denial: (kind) => `${kind} denied: write the plan to ${draft}` } },
    });
    assert.equal((await s.bridge.call({ id: "p1", name: "write", input: { path: draft, content: "# Plan\n" } })).ok, true);
    assert.equal(readFileSync(draft, "utf8"), "# Plan\n");
    // A draft left by an earlier run: read it, then edit it.
    writeFileSync(draft, "# Plan\n- step one\n");
    assert.equal((await s.bridge.call({ id: "p1b", name: "edit", input: { path: draft, old_string: "one", new_string: "1" } })).error?.code, "stale_file");
    assert.match((await s.bridge.call({ id: "p1c", name: "read", input: { path: draft } })).output, /step one/);
    assert.equal((await s.bridge.call({ id: "p1d", name: "edit", input: { path: draft, old_string: "one", new_string: "1" } })).ok, true);
    assert.equal(readFileSync(draft, "utf8"), "# Plan\n- step 1\n");
    const beside = await s.bridge.call({ id: "p2", name: "write", input: { path: join(state, "other.md"), content: "x" } });
    assert.equal(beside.error?.code, "path_outside_workspace");
    const inside = await s.bridge.call({ id: "p3", name: "write", input: { path: "a.md", content: "x" } });
    assert.deepEqual([inside.error?.code, inside.data], ["plan_mode_denied", { reason: "plan_mode", planDraft: draft }]);
    assert.equal((await s.bridge.call({ id: "p4", name: "read", input: { path: join(state, "other.md") } })).error?.code, "path_outside_workspace");
    // A draft that is a link could point anywhere, the workspace included.
    rmSync(draft);
    symlinkSync(process.platform === "win32" ? s.workspace : join(s.workspace, "target.md"), draft,
      process.platform === "win32" ? "junction" : "file");
    assert.equal((await s.bridge.call({ id: "p5", name: "write", input: { path: draft, content: "x" } })).error?.code, "permission_denied");
    assert.equal(existsSync(join(s.workspace, "target.md")), false);
    await s.close();
    rmSync(state, { recursive: true, force: true });
  });

  it("runs a turn's calls in order, letting consecutive reads overlap", async () => {
    const s = await setup({ settings: { mode: "edit" } });
    writeFileSync(join(s.workspace, "a.txt"), "old\n");
    const results = await s.bridge.callAll([
      { id: "1", name: "read", input: { path: "a.txt" } },
      { id: "2", name: "grep", input: { pattern: "old" } },
      { id: "3", name: "edit", input: { path: "a.txt", old_string: "old", new_string: "new" } },
      { id: "4", name: "read", input: { path: "a.txt" } },
      { id: "5", name: "nope" },
    ]);
    assert.deepEqual(results.map((result) => result.ok), [true, true, true, true, false]);
    assert.match(results[0]?.output ?? "", /old/);
    assert.match(results[3]?.output ?? "", /new/);
    assert.equal(results[4]?.error?.code, "unknown_tool");
    await s.close();
  });

  it("needs the kernel's own context", async () => {
    const s = await setup();
    const plugin = s.kernel.restrict("plugin:x", { owner: "x" });
    assert.throws(() => new ToolBridge({ kernel: plugin, permissions: s.permissions, env: s.env }), TypeError);
    await s.close();
  });
});
