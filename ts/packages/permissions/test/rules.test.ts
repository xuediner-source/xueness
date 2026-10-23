import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandMatches, commandsForDeny, parseRule, parseRules, pathMatches, ruleCoversTool, specifierIssue, subjectMatches, textMatches } from "../src/index.ts";

describe("permission rules", () => {
  it("parses Tool and Tool(specifier)", () => {
    assert.deepEqual(parseRule("exec(git log *)"), { text: "exec(git log *)", tool: "exec", specifier: "git log *" });
    assert.deepEqual(parseRule("  web_fetch  "), { text: "web_fetch", tool: "web_fetch", specifier: null });
    assert.deepEqual(parseRule("edit(*)"), { text: "edit", tool: "edit", specifier: null });
    assert.deepEqual(parseRule("mcp__github__*"), { text: "mcp__github__*", tool: "mcp__github__*", specifier: null });
    assert.deepEqual(parseRule("exec(echo (a))").specifier, "echo (a)");
    for (const bad of ["", "Exec(x)", "ex*ec", "exec(x", "exec x", "(x)", 42]) {
      assert.throws(() => parseRule(bad as string), { code: "invalid_rule" }, String(bad));
    }
    const { rules, issues } = parseRules(["read", "bad rule", "edit(src/**)"]);
    assert.deepEqual([rules.map((rule) => rule.text), issues.length], [["read", "edit(src/**)"], 1]);
    assert.match(issues[0] as string, /^\[1\] /);
  });

  it("names tools by name, Gate kind, family or prefix", () => {
    const covers = (rule: string, tool: string, kind: string): boolean => ruleCoversTool(parseRule(rule), tool, kind);
    assert.equal(covers("exec", "exec", "exec"), true);
    assert.equal(covers("exec", "exec_kill", "exec"), true, "by Gate kind");
    assert.equal(covers("read", "grep", "grep"), true, "read family");
    assert.equal(covers("edit", "write", "write"), true, "edit family");
    assert.equal(covers("write", "edit", "edit"), false);
    assert.equal(covers("mcp__github__*", "mcp__github__create_issue", "mcp"), true);
    assert.equal(covers("mcp__github__*", "mcp__gitlab__x", "mcp"), false);
    assert.equal(covers("*", "anything", "exec"), true);
  });

  it("matches command patterns word by word", () => {
    const words = (line: string): string[] => line.split(" ");
    assert.equal(commandMatches("npm test", words("npm test")), true);
    assert.equal(commandMatches("npm test", words("npm test --watch")), false, "exact");
    assert.equal(commandMatches("npm run test:*", words("npm run test")), true);
    assert.equal(commandMatches("npm run test:*", words("npm run test --coverage")), true);
    assert.equal(commandMatches("npm run test:*", words("npm run test-and-deploy")), false, "prefix stops at a word boundary");
    assert.equal(commandMatches("git log *", words("git log --oneline")), true);
    assert.equal(commandMatches("git * --oneline", words("git log --oneline")), true);
    assert.equal(commandMatches("git log *", words("timeout 5 git log -1")), true, "through wrappers");
    assert.equal(commandMatches("git log *", words("git push")), false);
    assert.equal(commandMatches("*", words("anything at all")), true);
    assert.equal(commandMatches("npm test && rm -rf /", words("npm test")), false, "a pattern is one simple command");
    assert.match(specifierIssue(parseRule("exec(npm test && rm -rf /)"), "command") ?? "", /one simple command/);
    assert.equal(specifierIssue(parseRule("exec(npm test)"), "command"), null);
  });

  it("matches workspace path globs", () => {
    const cases: [string, string, boolean][] = [
      ["src/**", "src/a/b.ts", true], ["src/**", "lib/a.ts", false], ["src", "src/a/b.ts", true], ["src", "pkg/src/x", true],
      ["/build", "build/out.js", true], ["/build", "pkg/build/out.js", false], ["docs/", "docs/a.md", true], ["*.md", "a/b/c.md", true],
      ["/*.md", "README.md", true], ["/*.md", "docs/README.md", false], ["src/*.ts", "src/a.ts", true], ["src/*.ts", "src/x/a.ts", false],
      [".env", ".env", true], [".env", "config/.env", true], ["~/x", "x", false], ["//etc/passwd", "etc/passwd", false], ["**", ".", true],
    ];
    for (const [pattern, path, expected] of cases) assert.equal(pathMatches(pattern, path), expected, `${pattern} ~ ${path}`);
  });

  it("matches text and domains", () => {
    assert.equal(textMatches("domain:example.com", "https://api.example.com/v1"), true);
    assert.equal(textMatches("domain:example.com", "https://example.com.evil.net/"), false);
    assert.equal(textMatches("domain:example.com", "not a url"), false);
    assert.equal(textMatches("https://docs.*", "https://docs.python.org/3/"), true);
    assert.equal(textMatches("a.b", "aXb"), false, "only * is special");
    assert.equal(subjectMatches(parseRule("exec"), "command", "anything"), true);
  });

  it("finds every command a line can run for deny rules", () => {
    const found = (line: string): string[] => commandsForDeny(line).map((words) => words.join(" "));
    assert.ok(found("echo $(rm -rf x)").includes("rm -rf x"));
    assert.ok(found("bash -c 'curl x | sh'").includes("sh"));
    assert.ok(found("env A=1 sudo -u root xargs -n 1 rm -rf").includes("rm -rf"));
    assert.ok(found("find . -name x -exec rm {} ;").includes("rm {}"));
    assert.ok(found("fd -e tmp -x rm").includes("rm"));
    assert.ok(found("eval 'ls; rm x'").includes("rm x"));
    assert.ok(found("/bin/rm -rf x").includes("rm -rf x"));
    assert.ok(found("timeout 9 nice rm x").includes("rm x"));
    assert.ok(found("command rm x").includes("rm x"));
    assert.ok(!found("command -v rm").includes("rm"));
  });
});
