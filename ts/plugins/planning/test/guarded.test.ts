import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execSubject } from "@xueness/engine-tools";
import { guardedPermission, matchGuardedCommand, type GuardedShell } from "../src/guarded.ts";

describe("planning guarded command matcher", () => {
  it("matches finite dangerous invocations across segments and simple wrappers", () => {
    const argvSubject = execSubject({ argv: ["sudo", "rm", "-rf", "workspace"] });
    assert.equal(argvSubject, "sudo rm -rf workspace");
    assert.deepEqual(matchGuardedCommand(argvSubject, "posix"), { status: "matched", ruleId: "guarded.remove-tree" });
    assert.equal(matchGuardedCommand("env X=1 command rm one two", "posix").status, "matched");
    assert.equal(matchGuardedCommand("printf ok; future-tool --option && rm -rf doomed", "posix").status, "matched");
    assert.equal(matchGuardedCommand("rm --help -r target --unknown-option", "posix").status, "matched");
    assert.equal(matchGuardedCommand("rm data*.log", "posix").status, "matched");
  });

  it("matches the supported Git, find, rsync and storage rules", () => {
    const cases: [string, GuardedShell][] = [
      ["git -C . reset --hard --future-option", "posix"],
      ["git clean --force --help", "posix"],
      ["git push origin +main --unknown", "posix"],
      ["git branch -D old-branch", "posix"],
      ["git checkout -- file.txt", "posix"],
      ["git restore --staged file.txt", "posix"],
      ["find . -name '*.tmp' -delete", "posix"],
      ["rsync -a --delete source/ dest/", "posix"],
      ["dd if=input of=/dev/sda", "posix"],
      ["mkfs.ext4 /dev/sdb", "posix"],
      ["mount /dev/sdb1 /mnt/data", "posix"],
      ["Remove-Item -Path C:\\temp\\* -Recurse", "powershell"],
      ["ri first,second", "powershell"],
      ["Clear-Disk -Number 1", "powershell"],
      ["Format-Volume -DriveLetter D", "powershell"],
      ["Initialize-Disk -Number 1", "powershell"],
      ["Remove-Partition -DiskNumber 1 -PartitionNumber 2", "powershell"],
    ];
    for (const [command, shell] of cases) assert.equal(matchGuardedCommand(command, shell).status, "matched", command);
    assert.equal(matchGuardedCommand("mount", "posix").status, "notMatched");
    assert.equal(matchGuardedCommand("rsync -a --delete -n src/ dst/", "posix").status, "notMatched");
  });

  it("leaves ordinary work unmatched and labels complex or unsupported grammar", () => {
    assert.equal(matchGuardedCommand("npm run build && touch dist/output.js", "posix").status, "notMatched");
    assert.equal(matchGuardedCommand("rm -z one", "posix").status, "unsupported");
    assert.equal(matchGuardedCommand("bash -c 'rm -rf target'", "posix").status, "unsupported");
    assert.equal(matchGuardedCommand("echo $(compute-target)", "posix").status, "unsupported");
    assert.equal(matchGuardedCommand("Remove-Item -Recurse target", "cmd").status, "unsupported");
    assert.equal(guardedPermission({ tool: "remote_exec", kind: "exec", subject: "{}", subjectKind: "text" }, "posix"), null);
    assert.deepEqual(guardedPermission({ tool: "exec", kind: "exec", subject: "rm -r target", subjectKind: "command" }, "posix"), {
      ruleId: "guarded.remove-tree", message: "guarded mode requires one-time approval for guarded.remove-tree",
    });
  });
});
