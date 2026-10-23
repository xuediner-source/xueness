/**
 * Argv read-only classification.
 * Adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/tests/bash-permission.test.ts
 * (the cases about command names, subcommands, safe flags, redirects,
 * pipes, command substitution and git next to cd).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyShellCommand } from "../src/index.ts";

const READ_ONLY = [
  "pwd", "whoami", "echo hello", "printf '%s\\n' hello", "cat README.md", "cat < README.md", "cat -n README.md",
  "fd --hidden foo src", "fdfind -e ts foo src", "head -n 20 README.md", "tail --lines=50 README.md", "wc -l README.md",
  "stat README.md", "file README.md", "base64 -d fixture.txt", "sha256sum package.json", "date +%F", "hostname -f",
  "man ls", "netstat -an", "ps -ef", "lsof -n -i", "pgrep -fl node", "pyright --outputjson", "ss -tuln",
  "test -f package.json", "tput cols", "strings fixture.bin", "sed -n '1,20p' README.md", "jq '.scripts' package.json",
  "sort README.md", "uniq README.md", "cut -d: -f1 README.md", "tr a-z A-Z", "diff -u a.txt b.txt",
  "du -sh .", "docker ps --format '{{.Names}}'", "docker logs --tail 20 container",
  "gh pr view 123 --json title --repo owner/repo", "gh run list --limit 10 --json databaseId",
  "rg -n foo src", "rg --files src", "rg -g '*.ts' foo src", "grep -R -n foo src", "grep -R -n foo src 2>&1",
  "grep -R -n foo src 2>/dev/null", "grep --include '*.ts' foo src", "LC_ALL=C grep -R -n foo src",
  "command grep -R -n foo src", "noglob grep -R -n foo src",
  "tree", "tree -a", "tree -L 2", "tree --charset utf-8 src",
  "grep -c foo README.md", "grep --count foo README.md", "grep --color=never -n foo README.md", "fd --ignore-case foo src",
  "node -v", "node --version", "python --version", "python3 --version", "ip addr", "history", "history 20",
  "arch", "arch --help", "ifconfig en0", "printf '%d\\n' 42", "printf -- '%s\\n' hello",
  "find . -name package.json", "find . -newer marker -type f", "cal -3", "uptime", "type grep", "unexpand README.md",
  "git status --short", "git status --porcelain --branch --untracked-files=all", "git diff --name-only --",
  "git diff --exit-code -- src/index.ts", "git log --oneline -n 5", "git log --oneline -8 -- tests/xxx.ts",
  "git show --stat HEAD", "git ls-files --others --exclude-standard", "git rev-parse --show-toplevel",
  "git grep -n foo -- src", "git branch --show-current", "cd project && grep -R -n foo src",
  "grep -R -n foo src | head -20", "find src -type f -name '*.ts'",
];

const NOT_READ_ONLY = [
  "ls > out.txt", "find . -exec rm {} \\;", "ls $(touch out.txt)", "tree -o out.txt", "tree --bogus",
  "cat README.md > out.txt", "rg --pre ./filter foo src", "rg --pre=./filter foo src", "grep foo src > out.txt",
  "cat < /dev/tcp/example.com/80", "cat < //server/share", "sed -n '1w out.txt' README.md", "jq -f filter.jq package.json",
  "jq env package.json", "xargs rm -rf", "docker ps --context prod", "docker logs --host tcp://example.com container",
  "gh pr view 123 --repo https://example.com/repo", "date tomorrow", "lsof -iTCP@example.com", "man ./local.1",
  "pyright --watch", "ss dst example.com", "test -v PATH", "tput clear", "FOO=bar grep foo src",
  "node -e 'console.log(1)'", "python -c 'print(1)'", "history abc", "arch -x", "printf -v name value",
  "printf '%d\\n' not-a-number", "find . -files0-from list", "ifconfig -a", "find . -delete", "find . -fprint out.txt",
  "git -c core.pager=cat status", "git -C . status --short", "git -C/tmp status --short", "git --exec-path=/tmp status",
  "git checkout main", "cd project && git status --short", "git status && rm out.txt", "sed -i 's/a/b/' file.txt",
  "git push", "git commit -m x", "git branch new-feature",
];

describe("argv read-only policy", () => {
  it("treats safe argv, flags and read-only compounds as read-only", () => {
    for (const line of READ_ONLY) {
      const verdict = classifyShellCommand(line);
      assert.equal(verdict.readOnly, true, `${line}: ${verdict.reason}`);
    }
  });

  it("rejects dangerous flags, writes, substitutions and git after cd", () => {
    for (const line of NOT_READ_ONLY) {
      assert.equal(classifyShellCommand(line).readOnly, false, line);
    }
  });
});
