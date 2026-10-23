import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyArgv, classifyShellCommand, sedScriptReadOnly } from "../src/index.ts";

const READ_ONLY = [
  "git status", "git log --oneline -20", "git diff HEAD~1 -- src", "git show HEAD:package.json", "git branch", "git branch -a --list 'feat/*'",
  "git tag -l", "git remote -v", "git stash list", "git config --get user.name", "git --version",
  "ls -la", "ls src/*.ts", "cat package.json | head -20", "grep -rn 'TODO' src", "rg foo src/*.ts", "rg -n 'a|b' .", "wc -l *.md",
  "find . -name '*.ts' -not -path './node_modules/*'", "sed -n '1,20p' README.md", "sed -n '/start/,/end/p' f", "sed 's/a/b/g' f",
  "sort data.txt | uniq -c", "tree -L 2", "jq .name package.json", "echo hello", "printf '%s\\n' a b", "pwd", "cd src && ls", "date +%Y-%m-%d",
  "node --version", "python3 -V", "go version", "java -version", "npm ls", "npm view react version", "npm config get registry",
  "timeout 10 git diff", "nice -n 5 ls", "bash -c 'git status && ls'", "echo x > /dev/null 2>&1", "cat < input.txt", "which node",
  "test -f /etc/hosts", "command -v rg", "env", "hostname", "du -sh src", "stat package.json", "file README.md",
];

const NOT_READ_ONLY: [string, RegExp][] = [
  ["rm -rf build", /not a known read-only/],
  ["npm test", /npm test/],
  ["make version", /not a known read-only/],
  ["echo hi > out.txt", /redirection/],
  ["cat a >> b", /redirection/],
  ["FOO=1 ls", /sets FOO/],
  ["ls $HOME", /variable expansion/],
  ["cat $(which ls)", /command substitution/],
  ["find . -delete", /find -delete/],
  ["find . -exec rm {} \\;", /find -exec/],
  ["find {.,-delete}", /brace expansion/],
  ["rg foo *", /pattern that may expand/],
  ["rg --pre=bash foo", /option --pre/],
  ["sed -n 1p *", /pattern that may expand/],
  ["sed -i 's/a/b/' f", /option -i/],
  ["sed 'w out' f", /sed script/],
  ["sed 's/a/b/e' f", /sed script/],
  ["sort -o out in", /option -o/],
  ["sort -uo out in", /option -uo/],
  ["uniq in out", /uniq writing/],
  ["tree -o out.txt", /option -o/],
  ["tree -R", /option -R/],
  ["file -C -m magic", /option -C/],
  ["fd -x rm", /option -x/],
  ["git -C src status", /git option -C/],
  ["git -c core.pager=sh log", /git option -c/],
  ["git push", /git push/],
  ["git commit -m x", /git commit/],
  ["git branch new-feature", /creates or changes refs/],
  ["git log --output=x", /--output/],
  ["git config user.name x", /git config that may write/],
  ["git stash", /git stash/],
  ["npm install", /npm install/],
  ["npm audit fix", /npm audit/],
  ["cat ~/.ssh/id_rsa", /outside the workspace/],
  ["cat /etc/passwd", /outside the workspace/],
  ["ls ../..", /outside the workspace/],
  ["git -C /tmp/other log", /outside the workspace/],
  ["grep -f/etc/passwd x", /outside the workspace/],
  ["grep -e x /etc/passwd", /outside the workspace/],
  ["cd", /cd that may leave/],
  ["cd -", /cd that may leave/],
  ["cd /", /outside the workspace/],
  ["./ls", /runs a program by path/],
  ["/bin/cat x", /runs a program by path/],
  ["* x", /command name is a pattern/],
  ["date -s 2020-01-01", /date -s/],
  ["hostname evil", /hostname that may set/],
  ["env rm -rf x", /env with arguments/],
  ["command rm x", /command that runs/],
  ["timeout 5", /timeout without a command/],
  ["bash -c 'rm x'", /not a known read-only/],
  ["for f in a b; do cat f; done", /control flow/],
  ["cat <<EOF\nx\nEOF", /here-document/],
  ["", /empty command/],
];

describe("read-only command classification", () => {
  it("allows commands that only read", () => {
    for (const line of READ_ONLY) assert.equal(classifyShellCommand(line).readOnly, true, `${line}: ${classifyShellCommand(line).reason}`);
  });

  it("refuses commands that may write, run code or read outside the workspace", () => {
    for (const [line, reason] of NOT_READ_ONLY) {
      const verdict = classifyShellCommand(line);
      assert.equal(verdict.readOnly, false, line);
      assert.match(verdict.reason, reason, line);
    }
  });

  it("classifies argv without shell expansion", () => {
    assert.equal(classifyArgv(["git", "status"]).readOnly, true);
    assert.equal(classifyArgv(["ls", "*"]).readOnly, true, "no shell, so no glob");
    assert.equal(classifyArgv(["rg", "*", "--pre=bash"]).readOnly, false);
    assert.equal(classifyArgv([]).readOnly, false);
  });

  it("reads sed scripts conservatively", () => {
    for (const script of ["p", "1,5p", "$d", "/x/,/y/d", "s/a/b/g", "s|a|b|2", "10q", "s/a\\/b/c/;p", "1~2p"]) {
      assert.equal(sedScriptReadOnly(script), script !== "1~2p", script);
    }
    for (const script of ["w out", "s/a/b/w out", "s/a/b/e", "e ls", "r /etc/passwd", "{p}", "y/ab/cd/", "a text"]) {
      assert.equal(sedScriptReadOnly(script), false, script);
    }
  });
});
