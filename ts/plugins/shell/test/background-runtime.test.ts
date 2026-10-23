import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentContext } from "@xueness/agent";
import { BackgroundTasks, type BackgroundTaskInfo, type TaskState } from "@xueness/engine-tools";
import { shellBackgroundExtension, summarizeBackgroundTasks, type ShellRuntimeBinding } from "@xueness/plugin-shell";
import { Context, PluginHost } from "@xueness/kernel";
import { createShell } from "../src/index.ts";

const sessionId = "a".repeat(32);

function task(id: string, owner: string, state: TaskState = "running", exitCode: number | null = null): BackgroundTaskInfo {
  return {
    id, command: "private command text", cwd: "C:/private/worktree", owner, pid: null, state, exitCode, signal: null,
    outputOpen: state === "running", startedAt: "2026-10-22T00:00:00Z", durationMs: 123, timeoutMs: 1000,
    stdout: { bytes: 17, logged: 17, path: `C:/private/${id}.stdout.log` },
    stderr: { bytes: 3, logged: 3, path: `C:/private/${id}.stderr.log` },
  };
}

function fakeTasks(rows: BackgroundTaskInfo[]) {
  const listOwners: (string | null | undefined)[] = [];
  let readCalls = 0;
  let startCalls = 0;
  const tasks = {
    list(owner?: string | null) { listOwners.push(owner); return rows; },
    async read() { readCalls += 1; throw new Error("read must not consume task output"); },
    async start() { startCalls += 1; throw new Error("start must not rerun stored commands"); },
  } as unknown as BackgroundTasks;
  return { tasks, listOwners, readCalls: () => readCalls, startCalls: () => startCalls };
}

function context(options: { session?: Record<string, unknown>; failSave?: () => boolean } = {}) {
  const session = options.session ?? { id: sessionId, messages: [], archived_messages: [] };
  let saves = 0;
  const agent = {
    session,
    async save() { saves += 1; if (options.failSave?.()) throw new Error("save failed"); },
  } as unknown as AgentContext;
  return { agent, session, saves: () => saves };
}

describe("shell background runtime", () => {
  it("projects at most 32 same-session task facts without command or output text", () => {
    const rows = Array.from({ length: 34 }, (_, index) => task(`task-${index}`, sessionId));
    rows.push(task("other-session", "b".repeat(32), "exited", 0));
    const summary = summarizeBackgroundTasks(rows, sessionId);
    assert.equal(summary.length, 32);
    assert.deepEqual(summary[0], {
      id: "task-0", state: "running", exitCode: null, outputOpen: true, stdoutBytes: 17, stderrBytes: 3,
      stdoutPath: "C:/private/task-0.stdout.log", stderrPath: "C:/private/task-0.stderr.log", durationMs: 123,
    });
    assert.equal("command" in summary[0]!, false);
    assert.equal("stdout" in summary[0]!, false);
  });

  it("sends one terminal reminder and deduplicates current and archived messages", async () => {
    const archived = { role: "user", _background_task_notice: "archived:exited" };
    const current = { role: "user", _background_task_notice: "current:killed" };
    const { tasks } = fakeTasks([task("archived", sessionId, "exited", 0), task("current", sessionId, "killed"), task("fresh", sessionId, "exited", 7)]);
    const state = context({ session: { id: sessionId, messages: [current], archived_messages: [archived] } });
    const extension = shellBackgroundExtension({ tasks });

    await extension.beforeModelRequest?.(state.agent);
    await extension.beforeModelRequest?.(state.agent);
    const messages = state.session.messages as Record<string, unknown>[];
    const notices = messages.filter((message) => typeof message._background_task_notice === "string");
    const fresh = notices.find((message) => message._background_task_notice === "fresh:exited");
    assert.equal(notices.length, 2);
    assert.equal(fresh?._input_kind, "background_notice");
    assert.match(String(fresh?.content), /fresh.*exited.*exit code 7.*TaskOutput/s);
    assert.doesNotMatch(String(fresh?.content), /private command text|private\/fresh|stdout/);
    assert.equal(state.saves(), 1);
  });

  it("filters ownership, updates the snapshot, and never reads incremental output", async () => {
    const foreign = task("foreign", "b".repeat(32), "exited", 4);
    const own = task("own", sessionId, "exited", 0);
    const manager = fakeTasks([foreign, own]);
    const state = context();
    const extension = shellBackgroundExtension({ tasks: manager.tasks });

    assert.equal(await extension.beforeFinalResponse?.(state.agent, { content: "done" }), true);
    assert.deepEqual(manager.listOwners, [sessionId]);
    assert.equal(manager.readCalls(), 0);
    assert.deepEqual(state.session.background_tasks, [summarizeBackgroundTasks([own], sessionId)[0]]);
    assert.equal((state.session.messages as Record<string, unknown>[]).some((message) => String(message._background_task_notice).startsWith("foreign:")), false);

    const previousRunning = task("running", sessionId);
    const currentRunning = task("running", sessionId);
    currentRunning.durationMs += 10;
    currentRunning.stdout.bytes += 5;
    currentRunning.stderr.bytes += 2;
    const runningState = context({ session: {
      id: sessionId,
      messages: [],
      archived_messages: [],
      background_tasks: summarizeBackgroundTasks([previousRunning], sessionId),
    } });
    const runningManager = fakeTasks([currentRunning]);
    const runningExtension = shellBackgroundExtension({ tasks: runningManager.tasks });

    assert.equal(await runningExtension.beforeFinalResponse?.(runningState.agent, { content: "done" }), false);
    assert.deepEqual(runningState.session.background_tasks, summarizeBackgroundTasks([currentRunning], sessionId));
    assert.deepEqual(runningState.session.messages, []);
    assert.equal(runningState.saves(), 1);
    assert.equal(runningManager.readCalls(), 0);
    assert.equal(runningManager.startCalls(), 0);
  });

  it("marks missing running snapshots lost once without reading output, rerunning commands, or inventing an exit code", async () => {
    const oldFacts = [
      { id: "lost-task", state: "running", exitCode: 23, outputOpen: true, stdoutBytes: 51, stderrBytes: 9, stdoutPath: "C:/old/lost.stdout.log", stderrPath: "C:/old/lost.stderr.log", durationMs: 456, command: "secret command", output: "secret output", env: { TOKEN: "secret" } },
      { id: "current-task", state: "running", exitCode: null, outputOpen: true, stdoutBytes: 99, stderrBytes: 88, stdoutPath: "C:/old/current.stdout.log", stderrPath: "C:/old/current.stderr.log", durationMs: 999 },
      { id: "finished-task", state: "exited", exitCode: 5, outputOpen: false, stdoutBytes: 20, stderrBytes: 4, stdoutPath: "C:/old/finished.stdout.log", stderrPath: "C:/old/finished.stderr.log", durationMs: 300 },
      { id: "prior-lost", state: "lost", reason: "runtime_unavailable", exitCode: null, outputOpen: false, stdoutBytes: 7, stderrBytes: 2, stdoutPath: "C:/old/lost.stdout.log", stderrPath: "C:/old/lost.stderr.log", durationMs: 80 },
      { id: 7, state: "running", command: "invalid id" },
      { id: "unknown-state", state: "forgotten", command: "invalid state" },
    ];
    const archivedNotices = ["current-task:exited", "finished-task:exited", "prior-lost:lost"].map((key) => ({ role: "user", _background_task_notice: key }));
    const state = context({ session: { id: sessionId, messages: [], archived_messages: archivedNotices, background_tasks: oldFacts } });
    const manager = fakeTasks([task("current-task", sessionId, "exited", 12), task("still-running", sessionId)]);
    const extension = shellBackgroundExtension({ tasks: manager.tasks });

    await extension.beforeModelRequest?.(state.agent);
    let summaries = state.session.background_tasks as Record<string, unknown>[];
    assert.deepEqual(summaries.map((summary) => summary.id), ["current-task", "still-running", "lost-task", "finished-task", "prior-lost"]);
    assert.equal(summaries[0]!.state, "exited");
    assert.equal(summaries[0]!.exitCode, 12);
    const lost = summaries.find((summary) => summary.id === "lost-task")!;
    assert.deepEqual({ state: lost.state, reason: lost.reason, exitCode: lost.exitCode, outputOpen: lost.outputOpen, stdoutBytes: lost.stdoutBytes, stderrBytes: lost.stderrBytes, durationMs: lost.durationMs }, {
      state: "lost", reason: "runtime_unavailable", exitCode: null, outputOpen: false, stdoutBytes: 51, stderrBytes: 9, durationMs: 456,
    });
    assert.equal("command" in lost || "output" in lost || "env" in lost, false);
    const notices = (state.session.messages as Record<string, unknown>[]).filter((message) => message._background_task_notice === "lost-task:lost");
    assert.equal(notices.length, 1);
    assert.match(String(notices[0]!.content), /unavailable.*result is unknown.*not be rerun automatically/i);
    assert.doesNotMatch(String(notices[0]!.content), /TaskOutput/);
    assert.equal((state.session.messages as Record<string, unknown>[]).some((message) => message._background_task_notice === "still-running:running"), false);

    await extension.beforeModelRequest?.(state.agent);
    assert.equal(await extension.beforeFinalResponse?.(state.agent, { content: "done" }), false);
    summaries = state.session.background_tasks as Record<string, unknown>[];
    assert.equal(summaries.filter((summary) => summary.id === "lost-task" && summary.state === "lost").length, 1);
    assert.equal((state.session.messages as Record<string, unknown>[]).filter((message) => message._background_task_notice === "lost-task:lost").length, 1);
    assert.equal(manager.readCalls(), 0);
    assert.equal(manager.startCalls(), 0);
    assert.equal(state.saves(), 1);
  });

  it("rolls back a failed save so the terminal reminder can be resent", async () => {
    const originalFacts = [{ id: "old" }];
    let shouldFail = true;
    const state = context({ session: { id: sessionId, messages: [], archived_messages: [], background_tasks: originalFacts }, failSave: () => shouldFail });
    const { tasks } = fakeTasks([task("retry", sessionId, "timed_out")]);
    const extension = shellBackgroundExtension({ tasks });

    await assert.rejects(async () => { await extension.beforeModelRequest?.(state.agent); }, /save failed/);
    assert.deepEqual(state.session.messages, []);
    assert.equal(state.session.background_tasks, originalFacts);
    shouldFail = false;
    await extension.beforeModelRequest?.(state.agent);
    assert.equal((state.session.messages as Record<string, unknown>[]).filter((message) => message._background_task_notice === "retry:timed_out").length, 1);
  });

  it("binds a manager on activation and disposes it without clearing a replacement binding", async () => {
    const kernel = Context.create();
    const binding: ShellRuntimeBinding = {};
    const host = new PluginHost(kernel, [createShell(binding)]);
    try {
      const [started] = await host.start();
      assert.equal(started?.state, "active", started?.error ?? "");
      const first = binding.tasks;
      assert.ok(first);
      await host.configure("shell", { defaultTimeoutMs: 121000 });
      assert.notEqual(binding.tasks, first);
      assert.equal(first.closed, true);
      const second = binding.tasks;
      assert.ok(second);
      const replacement = new BackgroundTasks();
      binding.tasks = replacement;
      await host.disable("shell");
      assert.equal(binding.tasks, replacement);
      assert.equal(second.closed, true);
      assert.equal(replacement.closed, false);
      assert.equal(shellBackgroundExtension({}).capabilities?.[0], "shell.background_notifications");
      const unbound = await extensionNoBinding();
      assert.equal((unbound.session.messages as unknown[]).length, 0);
      await replacement.dispose();
    } finally {
      await host.dispose();
      await kernel.dispose();
    }
  });
});

async function extensionNoBinding() {
  const state = context();
  const extension = shellBackgroundExtension({});
  await extension.beforeModelRequest?.(state.agent);
  assert.equal(state.saves(), 0);
  return state;
}
