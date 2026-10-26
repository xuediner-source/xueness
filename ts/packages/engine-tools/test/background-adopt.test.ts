/**
 * F05.04 — background output and recycling for adopted tasks.
 *
 * A foreground run moved to the background at its deadline keeps complete
 * logs (including what it wrote before the handoff, from the capture chunks
 * or the spilled file), reads stay incremental with bounded unread output,
 * exit and timeout settle differently and are never confused, a resumed
 * parent session (same owner, fresh ToolEnv) continues reading where it left
 * off, and finished adopted tasks are recycled with their logs.
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { after, describe, it } from "node:test";
import {
  BackgroundTasks, createExecKillTool, createExecOutputTool, createExecTool, createToolEnv, isInside,
  runTool, type BackgroundTaskInfo, type TaskRead,
} from "../src/index.ts";
import { workspace } from "./helpers.ts";

const posix = process.platform === "win32" ? "POSIX shell tests" : false;
const ws = workspace();
after(() => ws.dispose());

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await check();
}

function toolsFor(tasks: BackgroundTasks, extra: Parameters<typeof createExecTool>[0] = {}) {
  return { exec: createExecTool({ tasks, ...extra }), output: createExecOutputTool(tasks), kill: createExecKillTool(tasks) };
}

/** Run a foreground command that is adopted at its deadline; resolves with the task. */
async function adopted(tools: ReturnType<typeof toolsFor>, command: string, timeoutMs = 300): Promise<BackgroundTaskInfo> {
  const result = await ws.run(tools.exec, { command, timeout_ms: timeoutMs });
  assert.equal(result.ok, true, result.output);
  const task = result.data as BackgroundTaskInfo;
  assert.equal(task.adopted, true, `expected adoption: ${result.output}`);
  return task;
}

async function readUntil(tools: ReturnType<typeof toolsFor>, id: string, marker: RegExp, ms = 5000): Promise<TaskRead["stdout"]> {
  let collected: TaskRead["stdout"] = { text: "", bytes: 0, truncated: false };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !marker.test(collected.text)) {
    const read = await runTool(tools.output, { task_id: id }, ws.env);
    assert.equal(read.ok, true, read.output);
    const chunk = (read.data as TaskRead).stdout;
    collected = { text: collected.text + chunk.text, bytes: collected.bytes + chunk.bytes, truncated: collected.truncated || chunk.truncated };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return collected;
}

describe("adopted task output and recycling", { skip: posix }, () => {
  it("carries spilled foreground output into the complete task log while reads stay incremental", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      // ~170 KB of output before the deadline: the foreground capture spills
      // to a file, and the handoff must copy that file into the task log.
      const result = await ws.run(tools.exec, { command: "seq 1 30000; sleep 0.5; echo AFTER-SPILL; sleep 30", timeout_ms: 400 });
      assert.equal(result.ok, true, result.output);
      const task = result.data as BackgroundTaskInfo;
      assert.ok(task.stdout.bytes > 100_000, `carried byte count recorded, got ${task.stdout.bytes}`);
      assert.ok(isInside(ws.artifacts, task.stdout.path) && !isInside(ws.root, task.stdout.path));

      const fresh = await readUntil(tools, task.id, /AFTER-SPILL/);
      assert.match(fresh.text, /AFTER-SPILL/, "post-handoff output is new output");
      assert.ok(!fresh.text.includes("29999"), "spilled foreground output is not repeated as unread output");
      assert.ok(fresh.bytes < 200, `the new unread chunk is tiny, got ${fresh.bytes}`);

      const log = await readFile(task.stdout.path, "utf8");
      assert.ok(log.startsWith("1\n2\n"), "the task log continues the whole foreground stream");
      assert.match(log, /\n29999\n30000\n/);
      assert.match(log, /AFTER-SPILL/);
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      await tasks.dispose();
    }
  });

  it("bounds unread post-handoff output and reports the capped log", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300, maxLogBytes: 4096 });
    const tools = toolsFor(tasks);
    try {
      const task = await adopted(tools, "echo head; sleep 0.4; seq 1 60000; sleep 30", 300);
      const fresh = await readUntil(tools, task.id, /59999\n60000|bytes omitted/, 8000);
      assert.ok(fresh.truncated || /60000/.test(fresh.text), `the unread chunk keeps head and tail: ${fresh.text.slice(0, 80)}…`);
      const read = await runTool(tools.output, { task_id: task.id }, ws.env);
      assert.match(read.output, /\[stdout: log file is capped/, "a capped log is reported, not confused with an exit");
      const logInfo = (read.data as TaskRead).info.stdout;
      assert.ok(logInfo.logged <= 4096, `log stays within its cap, got ${logInfo.logged}`);
      const logSize = (await stat(task.stdout.path)).size;
      assert.ok(logSize <= 4096, `log file within cap, got ${logSize}`);
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      await tasks.dispose();
    }
  });

  it("never confuses a real exit with the task's own timeout", async () => {
    const finished = new BackgroundTasks({ killGraceMs: 300 });
    const finishTools = toolsFor(finished);
    const limiter = new BackgroundTasks({ killGraceMs: 300 });
    const limitTools = toolsFor(limiter, { backgroundTimeoutMs: 700 });
    try {
      const exited = await adopted(finishTools, "echo go; sleep 0.4; exit 7", 300);
      const done = await runTool(finishTools.output, { task_id: exited.id, wait_ms: 5000 }, ws.env);
      const doneInfo = (done.data as TaskRead).info;
      assert.equal(doneInfo.state, "exited");
      assert.equal(doneInfo.exitCode, 7);
      assert.match(done.output, /exited with code 7/);
      assert.doesNotMatch(done.output, /timed out/);

      const limited = await adopted(limitTools, "echo go; sleep 30", 300);
      const timedOut = await runTool(limitTools.output, { task_id: limited.id, wait_ms: 5000 }, ws.env);
      const timeoutInfo = (timedOut.data as TaskRead).info;
      assert.equal(timeoutInfo.state, "timed_out");
      assert.match(timedOut.output, /timed out after 0\.7s; the process tree was killed/);
      assert.doesNotMatch(timedOut.output, /exited with code/);
      assert.equal(timeoutInfo.adopted, true, "the adopted task keeps its provenance");
    } finally {
      await Promise.all([finished.dispose(), limiter.dispose()]);
    }
  });

  it("continues reading after the parent session resumes, and only for its owner", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const resumed = "session-resumed-" + Date.now();
    const envOne = createToolEnv({ cwd: ws.root, artifactsDir: ws.artifacts, owner: resumed });
    try {
      const start = await runTool(tools.exec, { command: "echo FIRST; sleep 0.5; echo SECOND; sleep 30", timeout_ms: 300 }, envOne);
      assert.equal(start.ok, true, start.output);
      assert.match(start.output, /FIRST/, "the foreground result carries the pre-deadline output");
      const task = start.data as BackgroundTaskInfo;
      assert.equal(task.owner, resumed);
      let text = "";
      for (let tries = 0; tries < 200 && !/SECOND/.test(text); tries += 1) {
        const read = await tasks.read(task.id, { owner: resumed });
        text += read.stdout.text;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(text, /SECOND/, "the first session reads the post-handoff output");
      assert.doesNotMatch(text, /FIRST/, "the foreground part is never handed out twice");

      // The session restarts: a fresh ToolEnv with the same owner id.
      const envTwo = createToolEnv({ cwd: ws.root, artifactsDir: ws.artifacts, owner: resumed });
      const second = await runTool(tools.output, { task_id: task.id }, envTwo);
      assert.equal(second.ok, true, second.output);
      assert.equal((second.data as TaskRead).stdout.text, "", "a resumed session continues, it does not reread");

      const stranger = createToolEnv({ cwd: ws.root, artifactsDir: ws.artifacts, owner: "someone-else" });
      const foreign = await runTool(tools.output, { task_id: task.id }, stranger);
      assert.equal(foreign.error?.code, "unknown_task", "another session's env cannot read the task");
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      await tasks.dispose();
    }
  });

  it("reports duration from the original spawn and recycles finished adopted tasks with their logs", async () => {
    const tasks = new BackgroundTasks({ maxKept: 1, killGraceMs: 200 });
    const tools = toolsFor(tasks);
    try {
      const first = await adopted(tools, "echo one; sleep 0.4", 300);
      assert.ok(first.durationMs >= 250, `duration covers the foreground part, got ${first.durationMs}`);
      assert.ok(!Number.isNaN(Date.parse(first.startedAt)), "startedAt is a real timestamp");

      const second = await adopted(tools, "echo two; sleep 0.4", 300);
      assert.ok(await waitFor(() => tasks.get(second.id)?.state === "exited" && tasks.get(second.id)?.outputOpen === false), "second task settled");
      assert.ok(await waitFor(() => tasks.get(first.id) === undefined), "older finished adopted tasks are evicted");
      assert.ok(await waitFor(async () => {
        try {
          await readFile(first.stdout.path);
          return false;
        } catch {
          return true;
        }
      }), "the evicted task's log is deleted");
      assert.equal(tasks.get(second.id)?.state, "exited", "the newest finished task is kept");
    } finally {
      await tasks.dispose();
    }
  });
});
