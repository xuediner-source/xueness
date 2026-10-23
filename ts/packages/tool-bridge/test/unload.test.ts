import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setup, until } from "./support.ts";

/** Running, not a zombie waiting for a parent that may never reap it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0] !== "Z";
  } catch {
    return process.platform !== "linux";
  }
}

async function gone(pid: number, ms = 3000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (!alive(pid)) return true;
  }
  return false;
}

const pidIn = (path: string): number => Number(readFileSync(path, "utf8").trim());

describe("unloading a plugin during a call", { skip: process.platform === "win32" ? "POSIX shell commands" : false }, () => {
  it("aborts the running command and kills its process tree when the plugin unloads", async () => {
    const s = await setup({ settings: { mode: "yolo" } });
    const pidFile = join(s.workspace, "pid");
    const running = s.bridge.call({ id: "c1", name: "exec", input: { command: "sleep 30 & echo $! > pid; wait" } });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"));
    const child = pidIn(pidFile);
    assert.ok(alive(child));
    const started = Date.now();
    await s.host.disable("shell");
    assert.ok(Date.now() - started < 5000, "unloading does not wait for the command's own end");
    const result = await running;
    assert.equal(result.error?.code, "command_cancelled");
    assert.ok(await gone(child), "the grandchild went with the tree");
    assert.equal((await s.bridge.call({ id: "c2", name: "exec", input: { command: "true" } })).error?.code, "unknown_tool");
    await s.host.enable("shell");
    assert.equal((await s.bridge.call({ id: "c3", name: "exec", input: { command: "true" } })).ok, true);
    await s.close();
  });

  it("stops background tasks with their plugin, and a finished call holds nothing up", async () => {
    const s = await setup({ settings: { mode: "yolo" } });
    const started = await s.bridge.call({ id: "b1", name: "exec", input: { command: "echo $$ > bg; exec sleep 30", background: true } });
    assert.equal(started.ok, true);
    await until(() => existsSync(join(s.workspace, "bg")) && readFileSync(join(s.workspace, "bg"), "utf8").endsWith("\n"));
    const task = pidIn(join(s.workspace, "bg"));
    assert.ok(alive(task));
    const before = Date.now();
    await s.host.disable("shell");
    assert.ok(Date.now() - before < 5000);
    assert.ok(await gone(task), "the task went with its plugin");
    await s.close();
  });
});
