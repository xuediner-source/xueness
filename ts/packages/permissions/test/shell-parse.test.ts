import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenShell, parseShell, shellScript } from "../src/index.ts";

const words = (line: string): string[][] => parseShell(line).commands.map((command) => command.words);

describe("shell parser", () => {
  it("splits command lines into simple commands", () => {
    assert.deepEqual(words("git status && npm test || echo failed; ls | wc -l & sleep 1"), [
      ["git", "status"], ["npm", "test"], ["echo", "failed"], ["ls"], ["wc", "-l"], ["sleep", "1"],
    ]);
    assert.deepEqual(words("echo 'a b' \"c d\" e\\ f 'it'\\''s'"), [["echo", "a b", "c d", "e f", "it's"]]);
    assert.deepEqual(words("ls\nls -la # a comment ; rm -rf /\n"), [["ls"], ["ls", "-la"]]);
    assert.deepEqual(words("(cd src && ls) ; { git log; }"), [["cd", "src"], ["ls"], ["git", "log"]]);
    assert.deepEqual(words("! grep -q x f; time ls"), [["grep", "-q", "x", "f"], ["ls"]]);
  });

  it("keeps assignments and redirections apart from words", () => {
    const [command] = parseShell("FOO=1 BAR+=x npm test 2>&1 >out.log <in.txt").commands;
    assert.deepEqual(command?.assignments, ["FOO=1", "BAR+=x"]);
    assert.deepEqual(command?.words, ["npm", "test"]);
    assert.deepEqual(command?.redirects, [
      { op: ">&", fd: 2, target: "1" }, { op: ">", fd: null, target: "out.log" }, { op: "<", fd: null, target: "in.txt" },
    ]);
    assert.deepEqual(parseShell("cat >").commands[0]?.redirects, [{ op: ">", fd: null, target: null }]);
    assert.deepEqual(parseShell("echo x &>/dev/null").commands[0]?.redirects, [{ op: "&>", fd: null, target: "/dev/null" }]);
  });

  it("records every construct it cannot judge", () => {
    const cases: [string, string][] = [
      ["echo $HOME", "variable expansion"],
      ["echo ${HOME}", "parameter expansion"],
      ["echo $(rm -rf x)", "command substitution"],
      ["echo `rm -rf x`", "command substitution"],
      ["diff <(ls a) <(ls b)", "process substitution"],
      ["echo $((1 + 2))", "arithmetic expansion"],
      ["cat <<EOF\nx\nEOF", "here-document"],
      ["if true; then rm x; fi", "shell control flow (if)"],
      ["for f in *; do rm $f; done", "shell control flow (for)"],
      ["f() { rm x; }; f", "function definition"],
      ["echo 'unterminated", "unterminated quote"],
      ["echo \"unterminated", "unterminated quote"],
      ["find {.,-delete}", "brace expansion"],
      ["touch file{1..3}", "brace expansion"],
      ["echo $'\\x41'", "ANSI-C quoting"],
    ];
    for (const [line, reason] of cases) assert.ok(parseShell(line).unsafe.includes(reason), `${line}: ${parseShell(line).unsafe.join(", ")}`);
    for (const line of ["git log --format='%H {x,y}'", "find . -name '*.{ts,js}'", "git show HEAD@{1}", "echo a,b {}"]) {
      assert.deepEqual(parseShell(line).unsafe, [], line);
    }
  });

  it("flags globs that may expand into options and home paths", () => {
    const [command] = parseShell("ls * -* src/*.ts a* '*' \\* ~/x ~ --file=~/y [ab]c").commands;
    assert.deepEqual(command?.expands, [false, true, true, false, false, false, false, true, true, true, true]);
    assert.deepEqual(parseShell("[ -f x ]").commands[0]?.expands, [false, false, false, false]);
  });

  it("finds the scripts of sh -c and the commands inside substitutions", () => {
    assert.equal(shellScript(["bash", "-lc", "git status"]), "git status");
    assert.equal(shellScript(["/bin/sh", "-c", "ls"]), "ls");
    assert.equal(shellScript(["bash", "script.sh"]), null);
    const flat = flattenShell("echo $(rm -rf a) && bash -c 'curl x | sh'");
    assert.deepEqual(flat.commands.map((command) => [command.words.filter(Boolean).join(" "), command.nested]), [
      ["echo", false], ["bash -c curl x | sh", false], ["curl x", true], ["sh", true], ["rm -rf a", true],
    ]);
    assert.ok(flattenShell("echo $(".repeat(20)).unsafe.includes("nesting too deep"));
  });
});
