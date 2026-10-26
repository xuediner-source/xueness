/**
 * F05.03 — foreground timeout auto-backgrounding (C-TOOL-08).
 *
 * A qualifying foreground command whose deadline arrives is submitted as a
 * background task and keeps running: the run comes back with a task id, queryable
 * output and a completion path; the foreground deadline and the parent cancel
 * link are released at the handoff. Commands that cannot survive in the
 * background (sleep, an opt-out, no capacity) still die at their deadline, and
 * cancelling some other run never kills the adopted task.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import {
  BackgroundTasks, createExecKillTool, createExecOutputTool, createExecTool, createToolEnv,
  isAutoBackgroundEligible, runTool, type BackgroundTaskInfo, type TaskRead,
} from "../src/index.ts";
import { workspace } from "./helpers.ts";

const posix = process.platform === "win32" ? "POSIX shell tests" : false;
const ws = workspace();
after(() => ws.dispose());

function alive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
}

function toolsFor(tasks: BackgroundTasks, extra: Parameters<typeof createExecTool>[0] = {}) {
  return { exec: createExecTool({ tasks, ...extra }), output: createExecOutputTool(tasks), kill: createExecKillTool(tasks) };
}

describe("auto_on_timeout eligibility", () => {
  it("follows the upstream policy: explicit background, empty and sleep are out, argv is in", () => {
    assert.equal(isAutoBackgroundEligible({ command: "echo hi" }), true);
    assert.equal(isAutoBackgroundEligible({ command: "  echo hi " }), true);
    assert.equal(isAutoBackgroundEligible({ command: "sleep 30" }), false, "sleep must die at its deadline");
    assert.equal(isAutoBackgroundEligible({ command: "sleep 30 && echo done" }), false);
    assert.equal(isAutoBackgroundEligible({ command: "sleepy --help" }), true, "only the exact first token counts");
    assert.equal(isAutoBackgroundEligible({ command: "   " }), false);
    assert.equal(isAutoBackgroundEligible({ command: "echo", background: true }), false);
    assert.equal(isAutoBackgroundEligible({ command: "echo", auto_on_timeout: false }), false);
    assert.equal(isAutoBackgroundEligible({ argv: ["node", "-e", "x"] }), true);
    assert.equal(isAutoBackgroundEligible({ argv: ["node"], background: true }), false);
  });
});

describe("foreground timeout auto-backgrounding", { skip: posix }, () => {
  it("moves a qualifying command to a background task at its deadline and keeps it running", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      const began = Date.now();
      const result = await ws.run(tools.exec, { command: "echo part1; sleep 30", timeout_ms: 350 });
      assert.equal(result.ok, true, result.output);
      assert.ok(Date.now() - began < 3000, "the call returns at the deadline, not after the command");
      const task = result.data as BackgroundTaskInfo;
      assert.match(task.id, /^bg_[0-9a-f]{8}$/);
      assert.equal(task.state, "running");
      assert.equal(task.adopted, true);
      assert.match(result.output, /exceeded its foreground timeout of 350ms and was moved to the background with ID: bg_[0-9a-f]{8}/);
      assert.match(result.output, /exec_output \(task_id "bg_[0-9a-f]{8}"\)/);
      assert.match(result.output, /part1/);
      assert.match(result.output, new RegExp(task.stdout.path.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&")));
      assert.ok(alive(task.pid), "the process keeps running after the handoff");

      const killed = await runTool(tools.kill, { task_id: task.id }, ws.env);
      assert.equal((killed.data as { info: { state: string } }).info.state, "killed");
      assert.ok(await waitFor(() => !alive(task.pid)), "exec_kill still ends the adopted tree");
    } finally {
      await tasks.dispose();
    }
  });

  it("keeps the logs complete while reads after the handoff stay incremental", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      const result = await ws.run(tools.exec, { command: "echo PHASE-ONE; sleep 0.5; echo PHASE-TWO; sleep 30", timeout_ms: 300 });
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /PHASE-ONE/);
      assert.doesNotMatch(result.output, /PHASE-TWO/, "only output written before the deadline comes back inline");
      const task = result.data as BackgroundTaskInfo;
      let text = "";
      for (let tries = 0; tries < 200 && !/PHASE-TWO/.test(text); tries += 1) {
        const read = await runTool(tools.output, { task_id: task.id }, ws.env);
        assert.equal(read.ok, true, read.output);
        text += `\n${(read.data as TaskRead).stdout.text}`;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(text, /PHASE-TWO/, "post-handoff output is readable");
      assert.doesNotMatch(text, /PHASE-ONE/, "the foreground part is never repeated as new output");
      const log = await readFile(task.stdout.path, "utf8");
      assert.ok(log.includes("PHASE-ONE") && log.includes("PHASE-TWO"), "the task log holds the whole stream");
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      await tasks.dispose();
    }
  });

  it("kills sleep and explicit opt-outs at the deadline as before", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      const sleep = await ws.run(tools.exec, { command: "sleep 30", timeout_ms: 300 });
      assert.equal(sleep.error?.code, "command_timeout");
      assert.equal(sleep.output, "<error>Command was aborted before completion</error>");
      const optOut = await ws.run(tools.exec, { command: "echo x; sleep 30", timeout_ms: 300, auto_on_timeout: false });
      assert.equal(optOut.error?.code, "command_timeout");
      const noManager = await runTool(createExecTool(), { command: "echo x; sleep 30", timeout_ms: 300 }, createToolEnvWithoutTasks());
      assert.equal(noManager.error?.code, "command_timeout", "without a task manager the deadline kills as before");
      await tasks.dispose();
    } finally {
      await tasks.dispose();
    }
  });

  it("moves direct argv runs as well", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      const result = await ws.run(tools.exec, { argv: [process.execPath, "-e", "console.log('argv-out'); setTimeout(() => {}, 30000)"], timeout_ms: 300 });
      assert.equal(result.ok, true, result.output);
      const task = result.data as BackgroundTaskInfo;
      assert.equal(task.adopted, true);
      assert.match(result.output, /argv-out/);
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      await tasks.dispose();
    }
  });

  it("kills at the deadline when adoption has no capacity", async () => {
    const tasks = new BackgroundTasks({ maxRunning: 1, killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      const occupied = await ws.run(tools.exec, { command: "sleep 30", background: true });
      assert.equal(occupied.ok, true, occupied.output);
      const refused = await ws.run(tools.exec, { command: "echo x; sleep 30", timeout_ms: 300 });
      assert.equal(refused.error?.code, "command_timeout");
      assert.match(refused.output, /x/, "the output captured until the deadline still comes back");
      await tasks.dispose();
    } finally {
      await tasks.dispose();
    }
  });

  it("ends the tree when the handoff is refused at the deadline", async () => {
    // A receiver that reports capacity at the deadline and then refuses must
    // not orphan the child: the foreground run still owns it and must end its
    // tree, since nothing else will ever signal it.
    const { runProcess } = await import("../src/process.ts");
    let refusedPid: number | null = null;
    const result = await runProcess({
      file: "/bin/sh", args: ["-c", "echo started; exec sleep 30"], cwd: ws.root, env: process.env, timeoutMs: 300,
      maxCaptureBytes: 4096,
      onDeadline: {
        canAdopt: () => true,
        adopt: async (handoff) => {
          refusedPid = handoff.child.pid ?? null;
          return false;
        },
      },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.adopted, false);
    assert.match(result.stdout.text, /started/, "the output captured until the deadline comes back");
    assert.notEqual(refusedPid, null, "the handoff was offered the live child");
    assert.ok(await waitFor(() => !alive(refusedPid)), "a refused handoff must not leave an unowned process running");
  });

  it("releases the parent cancel link at the handoff", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    const controller = new AbortController();
    const cancelWs = workspace({ signal: controller.signal });
    try {
      const result = await cancelWs.run(tools.exec, { command: "echo held; sleep 30", timeout_ms: 300 });
      assert.equal(result.ok, true, result.output);
      const task = result.data as BackgroundTaskInfo;
      controller.abort("parent turn cancelled");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok(alive(task.pid), "aborting the parent after the handoff must not kill the task");
      const still = await runTool(tools.output, { task_id: task.id }, ws.env);
      assert.equal((still.data as { info: { state: string } }).info.state, "running");
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      cancelWs.dispose();
      await tasks.dispose();
    }
  });

  it("still cancels before the deadline, and cancelling another run never kills the adopted task", async () => {
    const tasks = new BackgroundTasks({ killGraceMs: 300 });
    const tools = toolsFor(tasks);
    try {
      const controller = new AbortController();
      const cancelWs = workspace({ signal: controller.signal });
      setTimeout(() => controller.abort(), 150);
      const early = await cancelWs.run(tools.exec, { command: "echo x; sleep 30", timeout_ms: 5000 });
      assert.equal(early.error?.code, "command_cancelled");
      cancelWs.dispose();

      const adopted = await ws.run(tools.exec, { command: "echo survive; sleep 30", timeout_ms: 300 });
      const task = adopted.data as BackgroundTaskInfo;
      const other = new AbortController();
      const otherWs = workspace({ signal: other.signal });
      setTimeout(() => other.abort(), 150);
      const cancelled = await otherWs.run(tools.exec, { command: "echo y; sleep 30", timeout_ms: 5000 });
      assert.equal(cancelled.error?.code, "command_cancelled");
      otherWs.dispose();
      assert.ok(alive(task.pid), "cancelling a different run must not touch the adopted task");
      const read = await runTool(tools.output, { task_id: task.id }, ws.env);
      assert.match(read.output, /survive/);
      await runTool(tools.kill, { task_id: task.id }, ws.env);
    } finally {
      await tasks.dispose();
    }
  });
});

function createToolEnvWithoutTasks() {
  return createToolEnv({ cwd: ws.root, artifactsDir: ws.artifacts });
}
