/**
 * Regression tests for the P0 tool problems of the Python backend, through
 * the whole path a model call takes (bridge → permissions → plugin tool):
 *
 *   CRLF rewritten to LF · GBK files unreadable · grep scanning node_modules ·
 *   a missing command ending the run · a hard 30 s command timeout
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { encodeText } from "@xueness/engine-tools";
import { setup, until } from "./support.ts";

describe("P0 regressions through the tool bridge", () => {
  it("keeps CRLF line endings through read, edit and write", async () => {
    const s = await setup({ settings: { mode: "edit" } });
    const path = join(s.workspace, "win.txt");
    writeFileSync(path, "one\r\ntwo\r\nthree\r\n");
    const read = await s.bridge.call({ id: "r", name: "read", input: { path: "win.txt" } });
    assert.equal((read.data as { lineEnding: string }).lineEnding, "CRLF");
    const edit = await s.bridge.call({ id: "e", name: "edit", input: { path: "win.txt", old_string: "two\nthree", new_string: "deux\ntrois\nquatre" } });
    assert.equal(edit.ok, true, edit.output);
    assert.equal(readFileSync(path, "latin1"), "one\r\ndeux\r\ntrois\r\nquatre\r\n");
    const write = await s.bridge.call({ id: "w", name: "write", input: { path: "win.txt", content: "a\nb\n" } });
    assert.equal(write.ok, true, write.output);
    assert.equal(readFileSync(path, "latin1"), "a\r\nb\r\n");
    await s.close();
  });

  it("reads, searches and edits GBK files in their own encoding", async () => {
    const s = await setup({ settings: { mode: "edit" } });
    const path = join(s.workspace, "gbk.txt");
    writeFileSync(path, encodeText("第一行：你好\n第二行：世界\n", "gbk"));
    const read = await s.bridge.call({ id: "r", name: "read", input: { path: "gbk.txt" } });
    assert.match(read.output, /你好/);
    assert.equal((read.data as { encoding: string }).encoding, "gbk");
    const grep = await s.bridge.call({ id: "g", name: "grep", input: { pattern: "世界" } });
    assert.match(grep.output, /gbk\.txt:2:第二行：世界/);
    assert.equal((await s.bridge.call({ id: "e", name: "edit", input: { path: "gbk.txt", old_string: "世界", new_string: "朋友" } })).ok, true);
    assert.deepEqual(readFileSync(path), Buffer.from(encodeText("第一行：你好\n第二行：朋友\n", "gbk")));
    await s.close();
  });

  it("leaves node_modules and ignored files out of grep and glob", async () => {
    const s = await setup();
    for (const dir of ["src", "node_modules/pkg", "dist"]) mkdirSync(join(s.workspace, dir), { recursive: true });
    writeFileSync(join(s.workspace, ".gitignore"), "dist/\n");
    writeFileSync(join(s.workspace, "src/app.js"), "const needle = 1;\n");
    writeFileSync(join(s.workspace, "node_modules/pkg/index.js"), "module.exports = 'needle';\n");
    writeFileSync(join(s.workspace, "dist/app.js"), "var needle;\n");
    const grep = await s.bridge.call({ id: "g", name: "grep", input: { pattern: "needle", output_mode: "files_with_matches" } });
    assert.deepEqual(grep.output.trim().split("\n"), ["src/app.js"]);
    const glob = await s.bridge.call({ id: "l", name: "glob", input: { pattern: "**/*.js" } });
    assert.deepEqual(glob.output.trim().split("\n"), ["src/app.js"]);
    await s.close();
  });

  it("returns a missing command as a result and goes on with the turn", async () => {
    const s = await setup({ settings: { mode: "yolo" } });
    writeFileSync(join(s.workspace, "a.txt"), "still here\n");
    const [missing, argv, next] = await s.bridge.callAll([
      { id: "1", name: "exec", input: { command: "xueness-no-such-command --flag" } },
      { id: "2", name: "exec", input: { argv: ["xueness-no-such-binary"] } },
      { id: "3", name: "read", input: { path: "a.txt" } },
    ]);
    assert.deepEqual([missing?.ok, missing?.error?.code], [false, "command_not_found"]);
    assert.deepEqual([argv?.ok, argv?.error?.code], [false, "command_not_found"]);
    assert.match(next?.output ?? "", /still here/);
    await s.close();
  });

  it("lets a command run past 30 seconds when its timeout allows", { skip: process.platform === "win32" ? "POSIX shell" : false }, async (t) => {
    const s = await setup({ settings: { mode: "yolo" } });
    // A real process on a simulated clock: 31 s pass at once while the command still runs.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = async (id: string, timeout: number) => {
      const marker = join(s.workspace, id);
      const call = s.bridge.call({ id, name: "exec", input: { command: `touch ${id} && sleep 1 && echo done`, timeout_ms: timeout, auto_on_timeout: false } });
      await until(() => existsSync(marker));
      t.mock.timers.tick(31_000);
      return call;
    };
    const long = await run("long", 45_000);
    assert.deepEqual([long.ok, long.output.split("\n")[0]], [true, "done"]);
    const short = await run("short", 30_000);
    assert.equal(short.error?.code, "command_timeout", "the clock does drive the timeout");
    t.mock.timers.reset();
    await s.close();
  });
});
