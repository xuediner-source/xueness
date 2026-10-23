import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { after, describe, it } from "node:test";
import {
  BackgroundTasks, createExecKillTool, createExecOutputTool, createExecTool, isInside, runTool,
  type BackgroundTaskInfo, type TaskRead, type ToolEnv,
} from "../src/index.ts";
import { workspace } from "./helpers.ts";

const posix = process.platform === "win32" ? "POSIX shell tests" : false;
const ws = workspace();
after(() => ws.dispose());

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live processes, pipes, sockets and timers (file-system requests in flight are transient). */
function handles(): string[] {
  return process.getActiveResourcesInfo().filter((name) => !name.startsWith("FSReq")).sort();
}

async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 25));
  return check();
}

function toolsFor(tasks: BackgroundTasks, extra: Parameters<typeof createExecTool>[0] = {}) {
  return { exec: createExecTool({ tasks, ...extra }), output: createExecOutputTool(tasks), kill: createExecKillTool(tasks) };
}

async function start(tools: ReturnType<typeof toolsFor>, input: Record<string, unknown>, env: ToolEnv = ws.env): Promise<BackgroundTaskInfo> {
  await ws.put(".keep", "");
  const result = await runTool(tools.exec, { ...input, background: true }, env);
  assert.equal(result.ok, true, result.output);
  return result.data as BackgroundTaskInfo;
}

describe("background exec tasks", { skip: posix }, () => {
  it("return at once, then hand out only the output written since the last read", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const began = Date.now();
    const info = await start(tools, { command: "echo start; sleep 0.4; echo done; echo oops >&2" });
    assert.ok(Date.now() - began < 1000, "starting must not wait for the command");
    assert.match(info.id, /^bg_[0-9a-f]{8}$/);
    assert.equal(info.state, "running");
    const first = await runTool(tools.output, { task_id: info.id, wait_ms: 5000 }, ws.env);
    assert.equal(first.ok, true);
    assert.match(first.output, /exited with code 0 after/);
    assert.match(first.output, /\nstart\ndone\n\[stderr\]\noops$/);
    const again = await runTool(tools.output, { task_id: info.id }, ws.env);
    assert.match(again.output, /\(no new output\)/);
    // The full logs live in the artifacts directory, never in the workspace.
    for (const path of [info.stdout.path, info.stderr.path]) assert.ok(isInside(ws.artifacts, path) && !isInside(ws.root, path));
    assert.equal(await readFile(info.stdout.path, "utf8"), "start\ndone\n");
    const listed = await runTool(tools.output, {}, ws.env);
    assert.match(listed.output, new RegExp(`${info.id}  exited with code 0`));
    await tasks.dispose();
  });

  it("keep running between calls and stop their whole process tree on exec_kill", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const info = await start(tools, { command: "sleep 60 & echo child $!; echo ready; wait" });
    let text = "";
    for (let tries = 0; tries < 100 && !/\nready/.test(text); tries += 1) {
      text += (await runTool(tools.output, { task_id: info.id }, ws.env)).output;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(text, /\nchild \d+\nready/);
    const child = Number(/child (\d+)/.exec(text)?.[1]);
    assert.ok(alive(child) && alive(info.pid as number));
    const killed = await runTool(tools.kill, { task_id: info.id }, ws.env);
    assert.equal(killed.ok, true);
    assert.equal((killed.data as TaskRead).info.state, "killed");
    assert.ok(await waitFor(() => !alive(child) && !alive(info.pid as number)), "the task and its child must be gone");
    await tasks.dispose();
  });

  it("time out on their own limit and kill the tree", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const info = await start(tools, { command: "sleep 30", timeout_ms: 300 });
    const read = await runTool(tools.output, { task_id: info.id, wait_ms: 5000 }, ws.env);
    assert.equal((read.data as TaskRead).info.state, "timed_out");
    assert.match(read.output, /timed out after 0.3s; the process tree was killed/);
    assert.ok(await waitFor(() => !alive(info.pid as number)));
    await tasks.dispose();
  });

  it("limit running tasks, stay private to their session, and report a missing command", async () => {
    const tasks = new BackgroundTasks({ maxRunning: 1, killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const mine = { ...ws.env, owner: "session-a" };
    const other = { ...ws.env, owner: "session-b" };
    const info = await start(tools, { command: "sleep 30" }, mine);
    const second = await runTool(tools.exec, { command: "sleep 30", background: true }, mine);
    assert.equal(second.error?.code, "too_many_tasks");
    assert.equal((await runTool(tools.output, { task_id: info.id }, other)).error?.code, "unknown_task");
    assert.equal((await runTool(tools.kill, { task_id: info.id }, other)).error?.code, "unknown_task");
    assert.match((await runTool(tools.output, {}, other)).output, /^no background tasks$/);
    await runTool(tools.kill, { task_id: info.id }, mine);
    const missing = await runTool(tools.exec, { argv: ["xueness-no-such-command"], background: true }, mine);
    assert.equal(missing.error?.code, "command_not_found");
    assert.equal(tasks.list().length, 1, "a task that never started is not kept");
    await tasks.dispose();
  });

  it("bound unread output in memory and cap the log files", async () => {
    const tasks = new BackgroundTasks({ unreadBytes: 2000, maxLogBytes: 10_000, killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const info = await start(tools, { command: "seq 1 100000" });
    const read = await runTool(tools.output, { task_id: info.id, wait_ms: 5000 }, ws.env);
    const data = read.data as TaskRead;
    assert.equal(data.stdout.truncated, true);
    assert.match(read.output, /\n1\n2\n3\n/);
    assert.match(read.output, /\n99999\n100000\n/);
    assert.match(read.output, /\[stdout: 588895 new bytes, middle omitted; full output: /);
    assert.match(read.output, /\[stdout: log file is capped; the last 578895 bytes were not saved\]/);
    assert.ok(read.output.length < 3000);
    assert.equal((await stat(info.stdout.path)).size, 10_000);
    await tasks.dispose();
  });

  it("are all stopped by dispose, even children that outlive the main process, leaving no handles", async () => {
    const baseline = handles();
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const server = await start(tools, { command: "trap '' TERM; sleep 60 & sleep 60 & wait" });
    const leftover = await start(tools, { command: "(sleep 60 &); echo bye" });
    const read = await runTool(tools.output, { task_id: leftover.id, wait_ms: 3000 }, ws.env);
    assert.equal((read.data as TaskRead).info.state, "exited");
    assert.equal((read.data as TaskRead).info.outputOpen, true);
    assert.match(read.output, /still hold its output open/);
    await tasks.dispose();
    assert.equal(tasks.running, 0);
    for (const info of tasks.list()) assert.equal(info.outputOpen, false, `${info.command} still has its output open`);
    assert.ok(await waitFor(() => !alive(server.pid as number)));
    assert.deepEqual(handles(), baseline);
    const late = await runTool(tools.exec, { command: "true", background: true }, ws.env);
    assert.equal(late.error?.code, "tasks_closed");
  });

  it("are refused without a task manager, and long foreground timeouts need background", async () => {
    const plain = createExecTool();
    assert.equal((await runTool(plain, { command: "true", background: true }, ws.env)).error?.code, "unsupported");
    const long = await runTool(plain, { command: "true", timeout_ms: 600_001 }, ws.env);
    assert.equal(long.error?.code, "invalid_argument");
    assert.match(long.output, /needs background: true/);
  });
});
