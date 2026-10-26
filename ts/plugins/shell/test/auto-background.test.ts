/**
 * F05.03/F05.04 through the shell plugin: a foreground command that reaches
 * its configured timeout is adopted into the plugin's own background tasks
 * (the prepared bash invocation keeps running), its completion reaches the
 * session as a durable notice, and disabling the plugin stops the adopted
 * task and recycles the terminal environment scripts with everything else.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentContext } from "@xueness/agent";
import { createToolEnv, runTool, type BackgroundTaskInfo, type TaskRead, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { createShell, resolveBashShell, shellBackgroundExtension, type ShellRuntimeBinding } from "@xueness/plugin-shell";

const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-shell-auto-")));
after(() => rmSync(base, { recursive: true, force: true }));
const sessionId = "c".repeat(32);

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xueness-shell-auto-fx-")));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(workspace);
  mkdirSync(artifactsDir);
  return {
    root, workspace, stateDir, artifactsDir,
    env: createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir, owner: sessionId }),
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

async function startConfigured(config: Record<string, unknown>, fixture: ReturnType<typeof makeFixture>) {
  const kernel = Context.create();
  const binding: ShellRuntimeBinding = {};
  const host = new PluginHost(kernel, [createShell(binding, { stateDir: fixture.stateDir })]);
  const [status] = await host.start();
  assert.equal(status?.state, "active", status?.error ?? "");
  await host.configure("shell", config);
  return { kernel, host, binding };
}

function tool(kernel: Context, name: string): ToolDefinition {
  return kernel.tools.get<ToolDefinition>(name) as ToolDefinition;
}

async function gone(...pids: (number | null | undefined)[]): Promise<boolean> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (pids.every((pid) => {
      if (pid === null || pid === undefined) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    })) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("shell plugin auto-backgrounding", () => {
  it("adopts a foreground command at the configured timeout into the plugin's tasks", async () => {
    const fixture = makeFixture();
    const { kernel, host, binding } = await startConfigured({ defaultTimeoutMs: 1100, backgroundTimeoutMs: 30000 }, fixture);
    try {
      const result = await runTool(tool(kernel, "exec"), { command: "echo plugin-bg; sleep 10" }, fixture.env);
      assert.equal(result.ok, true, result.output);
      const task = result.data as BackgroundTaskInfo;
      assert.equal(task.adopted, true);
      assert.equal(binding.tasks?.get(task.id)?.state, "running", "the adopted task lives in the plugin's manager");
      assert.match(result.output, /was moved to the background with ID: bg_[0-9a-f]{8}/);
      // Windows bash may still be starting at handoff; verify its actual spooled output.
      let read = await runTool(tool(kernel, "exec_output"), { task_id: task.id }, fixture.env);
      for (let attempt = 0; attempt < 100 && !read.output.includes("plugin-bg"); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        read = await runTool(tool(kernel, "exec_output"), { task_id: task.id }, fixture.env);
      }
      assert.match(read.output, /plugin-bg/);
      assert.equal((read.data as TaskRead).info.state, "running");
      const stopped = await runTool(tool(kernel, "exec_kill"), { task_id: task.id }, fixture.env);
      assert.match(stopped.output, /killed/);
      assert.ok(await gone(task.pid));
    } finally {
      await host.dispose();
      await kernel.dispose();
      fixture.dispose();
    }
  });

  it("delivers a durable completion notice for an adopted task to its session", async () => {
    const fixture = makeFixture();
    const { kernel, host, binding } = await startConfigured({ defaultTimeoutMs: 1100, backgroundTimeoutMs: 1100 }, fixture);
    try {
      const result = await runTool(tool(kernel, "exec"), { command: "echo notice-me; sleep 10" }, fixture.env);
      assert.equal(result.ok, true, result.output);
      const task = result.data as BackgroundTaskInfo;
      const tasks = binding.tasks;
      assert.ok(tasks);
      for (let tries = 0; tries < 300 && tasks.get(task.id)?.state === "running"; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(tasks.get(task.id)?.state, "timed_out", "the adopted task hits its own background limit");

      const session: Record<string, unknown> = { id: sessionId, messages: [], archived_messages: [] };
      const agent = { session, async save() { /* counted below */ } } as unknown as AgentContext;
      const extension = shellBackgroundExtension({ tasks });
      assert.equal(await extension.beforeFinalResponse?.(agent, { content: "done" }), true);
      const notices = (session.messages as Record<string, unknown>[]).filter((message) => message._background_task_notice === `${task.id}:timed_out`);
      assert.equal(notices.length, 1);
      assert.match(String(notices[0]?.content), new RegExp(`Background task ${task.id} reached terminal state timed_out`));
      assert.doesNotMatch(String(notices[0]?.content), /notice-me/, "the notice never echoes command output");
      const facts = session.background_tasks as { id: string; state: string }[];
      assert.deepEqual({ id: facts[0]?.id, state: facts[0]?.state }, { id: task.id, state: "timed_out" });
    } finally {
      await host.dispose();
      await kernel.dispose();
      fixture.dispose();
    }
  });

  it("stops an adopted task and recycles the bash terminal environment when the plugin is disabled", { skip: !resolveBashShell("") }, async () => {
    const fixture = makeFixture();
    const home = join(fixture.workspace, "rc home");
    mkdirSync(home);
    writeFileSync(join(home, ".bashrc"), "bg_stage() { printf rc-bg; }\n", "utf8");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const { kernel, host } = await startConfigured({ shellMode: "bash", captureInit: true, defaultTimeoutMs: 1100 }, fixture);
    try {
      const result = await runTool(tool(kernel, "exec"), { command: "bg_stage; echo bg-out; sleep 10" }, fixture.env);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /rc-bg/, "the prepared bash environment ran in the foreground part");
      const task = result.data as BackgroundTaskInfo;
      assert.equal(task.adopted, true);
      const files = (directory: string): string[] => {
        if (!existsSync(directory)) return [];
        return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
      };
      assert.equal(files(fixture.stateDir).length, 1, "the init snapshot stays materialized while the task runs");
      await host.disable("shell");
      assert.ok(await gone(task.pid), "disabling the plugin stops the adopted task");
      assert.equal(files(fixture.stateDir).length, 0, "plugin close removes its manager-owned terminal scripts");
    } finally {
      await host.dispose();
      await kernel.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fixture.dispose();
    }
  });
});
