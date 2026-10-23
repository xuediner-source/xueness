import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionSession, permissionSettingsIssues, type PermissionRequest } from "../src/index.ts";

const exec = (subject: string, callId?: string): PermissionRequest => ({ tool: "exec", kind: "exec", subject, subjectKind: "command", ...(callId ? { callId } : {}) });
const dangerous = () => ({ ruleId: "guarded.remove-tree", message: "needs one-time approval" });

describe("guarded permission mode", () => {
  it("requires a host callback and leaves the build default unchanged", () => {
    assert.equal(new PermissionSession().mode, "build");
    assert.throws(() => new PermissionSession({ mode: "guarded" }), /requires a guarded permission callback/);
    assert.match(permissionSettingsIssues({ mode: "guarded" }).join(" "), /requires a guarded permission callback/);
    assert.throws(() => new PermissionSession().setMode("guarded"), /requires a guarded permission callback/);
  });

  it("asks for matched exec before allow, remembered, yolo-fallthrough and ask rules", () => {
    const session = new PermissionSession({
      mode: "guarded", allow: ["exec(rm *)"], ask: ["exec(rm *)"],
      guarded: (request) => request.kind === "exec" && request.subject.startsWith("rm ") ? dangerous() : null,
    });
    session.remember("exec(rm *)");
    const match = session.check(exec("rm -r tree", "r1"));
    assert.deepEqual(match, { behavior: "ask", code: "guarded", message: "needs one-time approval", remember: null, rule: "guarded.remove-tree" });
    assert.equal(session.check(exec("npm run build")).behavior, "allow");
    assert.equal(session.check({ tool: "ask_user", kind: "ask_user", subject: "question", subjectKind: "text" }).code, "auto_allowed");
  });

  it("keeps deny, disallow, plan, remote exec and exact one-shot priority", () => {
    const callback = () => dangerous();
    assert.equal(new PermissionSession({ mode: "guarded", guarded: callback, deny: ["exec(rm *)"] }).check(exec("rm -r tree")).behavior, "deny");
    assert.equal(new PermissionSession({ mode: "guarded", guarded: callback, disallow: ["exec"] }).check(exec("rm -r tree")).behavior, "deny");
    assert.equal(new PermissionSession({ mode: "plan", guarded: callback }).check(exec("rm -r tree")).code, "plan_mode");

    const session = new PermissionSession({ mode: "guarded", guarded: callback });
    const remote = JSON.stringify({ connection: "prod", connection_digest: "abc", argv: ["rm", "-r", "tree"] });
    assert.equal(session.check(exec(remote, "remote")).code, "remote_exec");
    assert.deepEqual(session.check(exec("rm -r tree", "once")), {
      behavior: "ask", code: "guarded", message: "needs one-time approval", remember: null, rule: "guarded.remove-tree",
    });
    session.grantOnce("once", "exec", "rm -r tree");
    assert.equal(session.check(exec("rm -r tree", "once")).code, "approved");
    assert.equal(session.check(exec("rm -r tree", "once")).code, "guarded");
  });
});
