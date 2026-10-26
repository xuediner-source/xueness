import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/**
 * A host-owned directory (`hostWritable`, the session's visualization
 * directory): Read, Write and Edit reach it in every mode without approval and
 * with its real absolute path as the subject; deny rules and `disallow` still
 * win, and neither a link out of it nor a sibling path gets in.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PermissionSession } from "@xueness/permissions";
import { setup } from "./support.ts";

describe("host-writable directories", () => {
  it("let every mode write, read and edit inside without asking, and nothing beside it", async () => {
    const state = realpathSync(mkdtempSync(join(tmpdir(), "xueness-bridge-host-")));
    const host = join(state, "visualizations", "a".repeat(32)); mkdirSync(host, { recursive: true });
    const outside = join(state, "outside"); mkdirSync(outside);
    for (const mode of ["build", "plan", "edit", "yolo"] as const) {
      const asked: string[] = [];
      const s = await setup({ settings: { mode, hostWritable: [host] }, approver: async (request) => { asked.push(request.kind); return { behavior: "deny" }; } });
      const file = join(host, `${mode}.html`);
      assert.equal((await s.bridge.call({ id: "w", name: "write", input: { path: file, content: "<p>one</p>" } })).ok, true, mode);
      assert.match((await s.bridge.call({ id: "r", name: "read", input: { path: file } })).output, /one/);
      assert.equal((await s.bridge.call({ id: "e", name: "edit", input: { path: file, old_string: "one", new_string: "two" } })).ok, true);
      assert.equal(readFileSync(file, "utf8"), "<p>two</p>");
      assert.equal((await s.bridge.call({ id: "x", name: "write", input: { path: join(outside, "x.html"), content: "x" } })).error?.code, "path_outside_workspace");
      assert.equal((await s.bridge.call({ id: "y", name: "write", input: { path: `${host}-sibling/x.html`, content: "x" } })).error?.code, "path_outside_workspace");
      assert.deepEqual(asked, [], mode);
      await s.close();
    }
    symlinkSync(outside, join(host, "escape"), process.platform === "win32" ? "junction" : "dir");
    const s = await setup({ settings: { hostWritable: [host] } });
    assert.equal((await s.bridge.call({ id: "l", name: "write", input: { path: join(host, "escape", "x.html"), content: "x" } })).error?.code, "path_outside_workspace");
    await s.close();
    rmSync(state, { recursive: true, force: true });
  });

  it("decide after disallow and deny rules, for path subjects inside the directory only", () => {
    const host = resolve("/state/visualizations/s");
    const request = (kind: string, subject: string, subjectKind: "path" | "text" = "path") => ({ tool: kind, kind, subject, subjectKind });
    const session = new PermissionSession({ hostWritable: [host, "relative/dir"] });
    assert.equal(session.check(request("write", `${host}/a.html`)).code, "host_writable");
    assert.equal(session.hostWritableTarget("edit", `${host}/sub/../a.html`), host);
    for (const [kind, subject] of [["write", host], ["write", `${host}x/a.html`], ["write", resolve("/state/visualizations/a.html")], ["exec", `${host}/a.html`], ["write", "relative/dir/a.html"]] as const) {
      assert.equal(session.hostWritableTarget(kind, subject), null, `${kind} ${subject}`);
    }
    assert.equal(session.check(request("write", `${host}/a.html`, "text")).code, "approval_required");
    assert.equal(new PermissionSession({ hostWritable: [host], deny: ["write"] }).check(request("write", `${host}/a.html`)).code, "denied_by_rule");
    assert.equal(new PermissionSession({ hostWritable: [host], disallow: ["write"] }).check(request("write", `${host}/a.html`)).code, "disallowed");
    assert.equal(new PermissionSession({ mode: "plan", hostWritable: [host] }).check(request("write", `${host}/a.html`)).code, "host_writable");
  });
});
