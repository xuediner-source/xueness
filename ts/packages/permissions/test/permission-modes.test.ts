/**
 * Full access (yolo), plan mode and alwaysAsk.
 * Adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/tests/permission-service.test.ts
 * (plan read-only allow, plan write deny, yolo bypass, alwaysAsk)
 * and apps/zcode-cli/packages/core/tests/permission-full-access.test.ts
 * (full access is yolo: prompts stop, disallow and deny rules stay).
 * The receipt and queue machinery in permission-full-access.ts is a runtime
 * concern and is not part of this package.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionSession, type PermissionRequest } from "../src/index.ts";

const exec = (subject: string, callId?: string): PermissionRequest => ({ tool: "exec", kind: "exec", subject, subjectKind: "command", ...(callId ? { callId } : {}) });
const edit = (subject: string): PermissionRequest => ({ tool: "edit", kind: "edit", subject, subjectKind: "path" });
const code = (session: PermissionSession, request: PermissionRequest): string => {
  const decision = session.check(request);
  return `${decision.behavior}:${decision.code}`;
};

describe("permission modes", () => {
  it("lets yolo skip prompts while disallow, deny rules and remote exec still apply", () => {
    const session = new PermissionSession({ mode: "yolo", deny: ["exec(rm *)"], disallow: ["web_search"], ask: ["exec(git push *)"] });
    assert.equal(code(session, exec("npm install")), "allow:mode");
    assert.equal(code(session, exec("sed -i 's/a/b/' file.txt")), "allow:mode");
    assert.equal(code(session, exec("git push origin main")), "allow:mode", "an ask rule does not prompt in yolo");
    assert.equal(code(session, exec("rm -rf /")), "deny:denied_by_rule");
    assert.equal(code(session, { tool: "web_search", kind: "web_search", subject: "q", subjectKind: "text" }), "deny:disallowed");
    const remote = JSON.stringify({ connection: "prod", connection_digest: "abc", argv: ["ls"] });
    assert.equal(code(session, exec(remote, "remote-1")), "ask:remote_exec");
  });

  it("allows read-only commands in plan mode and denies writes", () => {
    const draft = { path: "/state/plan.md", matches: (subject: string) => subject === "/state/plan.md", denial: (kind: string) => `${kind} denied in plan mode` };
    const session = new PermissionSession({ mode: "plan", planDraft: draft, allow: ["exec(npm test)"] });
    assert.equal(code(session, { tool: "read", kind: "read", subject: "a.ts", subjectKind: "path" }), "allow:auto_allowed");
    assert.equal(code(session, exec("git status --short")), "allow:read_only");
    assert.equal(code(session, exec("rg -n foo src")), "allow:read_only");
    assert.equal(code(session, exec("grep -R -n foo src | head -20")), "allow:read_only");
    assert.equal(code(session, exec("find . -name package.json")), "allow:read_only");
    assert.equal(code(session, exec("cat README.md > out.txt")), "deny:plan_mode");
    assert.equal(code(session, exec("find . -exec rm {} \\;")), "deny:plan_mode");
    assert.equal(code(session, exec("find . -delete")), "deny:plan_mode");
    assert.equal(code(session, exec("sed -i 's/a/b/' file.txt")), "deny:plan_mode");
    assert.equal(code(session, exec("git checkout main")), "deny:plan_mode");
    assert.equal(code(session, exec("git -C . status --short")), "deny:plan_mode");
    assert.equal(code(session, exec("cd project && git status --short")), "deny:plan_mode");
    assert.equal(code(session, exec("npm test")), "deny:plan_mode", "an allow rule does not bypass plan mode");
    assert.equal(code(session, edit("a.ts")), "deny:plan_mode");
    assert.equal(code(session, { tool: "write", kind: "write", subject: draft.path, subjectKind: "path" }), "allow:plan_draft");
  });

  it("asks for alwaysAsk even when the command is read-only, allowed, or the mode would pass it", () => {
    const line = "git status";
    for (const mode of ["build", "plan", "yolo", "edit"] as const) {
      const session = new PermissionSession({ mode, allow: ["exec(git status *)"], alwaysAsk: ["exec(git status *)"] });
      assert.equal(code(session, exec(line)), "ask:always_ask", mode);
    }
    const denied = new PermissionSession({ mode: "yolo", deny: ["exec(rm *)"], alwaysAsk: ["exec(rm *)"], allow: ["exec(rm *)"] });
    assert.equal(code(denied, exec("rm -rf x")), "deny:denied_by_rule");
    const blocked = new PermissionSession({ mode: "yolo", disallow: ["exec"], alwaysAsk: ["exec(git status *)"] });
    assert.equal(code(blocked, exec(line)), "deny:disallowed");
    const once = new PermissionSession({ alwaysAsk: ["exec(git status *)"] });
    once.grantOnce("c1", "exec", line);
    assert.equal(code(once, exec(line, "c1")), "allow:approved");
    assert.equal(code(once, exec(line, "c1")), "ask:always_ask");
  });
});
