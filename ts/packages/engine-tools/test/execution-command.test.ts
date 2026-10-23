import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveExecutionCommand } from "../src/execution-command.ts";

describe("direct execution command resolution", () => {
  it("keeps executable argv direct and routes Windows batch shims through cmd with literal args", () => {
    const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "C:\\tools", PATHEXT: ".EXE;.CMD;.BAT" };
    const node = resolveExecutionCommand(["node.exe", "-e", "console.log('a b')"], {
      cwd: "C:\\workspace", env, platform: "win32", exists: (path) => path.toLowerCase() === "c:\\tools\\node.exe",
    });
    assert.deepEqual(node.argv, ["C:\\tools\\node.exe", "-e", "console.log('a b')"]);

    const shim = resolveExecutionCommand(["npm.cmd", "run", "build task", "%TEMP%", "a&b", ""], {
      cwd: "C:\\workspace", env, platform: "win32", exists: (path) => path.toLowerCase() === "c:\\tools\\npm.cmd",
    });
    assert.deepEqual(shim.argv, [
      env.ComSpec, "/d", "/s", "/c", '""C:\\tools\\npm.cmd" ^^^"run^^^" ^^^"build task^^^" ^^^"^^^%TEMP^^^%^^^" ^^^"a^^^&b^^^" ^^^"^^^""',
    ]);
    assert.equal(shim.windowsVerbatimArguments, true);
    assert.equal(shim.cwd, "C:\\workspace");
    assert.equal(shim.env, env);
  });
});
