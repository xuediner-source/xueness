import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createToolEnv, runTool, type BackgroundTaskInfo, type ExecData, type TaskRead, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginConfigError, PluginHost } from "@xueness/kernel";
import { createShell, resolveBashShell, shell, shellConfig, type ShellRuntimeBinding } from "@xueness/plugin-shell";

const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-shell-plugin-")));
after(() => rmSync(base, { recursive: true, force: true }));
const env = createToolEnv({ cwd: base, roots: [base], artifactsDir: join(tmpdir(), `xueness-shell-artifacts-${process.pid}`) });

function call(kernel: Context, name: string, input: unknown) {
  return runTool(kernel.tools.get<ToolDefinition>(name) as ToolDefinition, input, env);
}

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xueness-shell-bash-")));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state with 空格");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(workspace);
  mkdirSync(artifactsDir);
  return {
    root, workspace, stateDir,
    env: createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir }),
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

async function runIn(kernel: Context, toolEnv: ReturnType<typeof createToolEnv>, name: string, input: unknown) {
  return runTool(kernel.tools.get<ToolDefinition>(name) as ToolDefinition, input, toolEnv);
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

/** Signals are delivered asynchronously and an orphan stays visible until reaped, so wait briefly. */
async function gone(...pids: number[]): Promise<boolean> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (pids.every((pid) => !alive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exec(kernel: Context, argv: string[]): Promise<{ output: string; data: ExecData }> {
  const tool = kernel.tools.get<ToolDefinition>("exec") as ToolDefinition;
  const result = await runTool(tool, { argv }, env);
  return { output: result.output, data: result.data as ExecData };
}

describe("shell plugin", () => {
  it("checks its config against the manifest schema", () => {
    assert.deepEqual(shellConfig({}), {
      defaultTimeoutMs: 120000, maxCaptureBytes: 24576, scrubEnv: true, passEnv: [], backgroundTimeoutMs: 1800000, maxBackgroundTasks: 8,
      shellMode: "system", shellExecutable: "", captureInit: false, startupScript: "",
    });
    assert.throws(() => shellConfig({ maxBackgroundTasks: 0 }), /maxBackgroundTasks/);
    assert.throws(() => shellConfig({ defaultTimeoutMs: 10 }), /defaultTimeoutMs/);
    assert.throws(() => shellConfig({ passEnv: ["NOT-A-NAME"] }), /passEnv/);
    assert.throws(() => shellConfig({ shell: ["/bin/zsh", "-c"] }), /shell/);
    assert.throws(() => shellConfig({ captureInit: true }), /captureInit requires shellMode/);
    assert.throws(() => shellConfig({ shellMode: "system", startupScript: "echo hi" }), /startupScript requires shellMode/);
  });

  it("selects explicit bash, never treats WindowsApps as Git Bash and returns a tool failure when missing", async () => {
    const windowsEnv = {
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools\\Git\\cmd",
    };
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const provider = resolveBashShell("", windowsEnv, "win32", (path) => path.toLowerCase() === gitBashPath.toLowerCase());
    assert.equal(provider?.dialect, "posix");
    assert.equal(provider?.executable, gitBashPath);
    const wslOnly = resolveBashShell("", { PATH: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps" }, "win32", () => true);
    assert.equal(wslOnly, undefined);
    const override = resolveBashShell("D:\\Custom\\bash.exe", windowsEnv, "win32", (path) => path.toLowerCase() === "d:\\custom\\bash.exe");
    assert.equal(override?.executable, "D:\\Custom\\bash.exe");

    const fixture = makeFixture();
    const missing = join(fixture.workspace, "missing-bash.exe");
    const { kernel, host } = await startConfigured({ shellMode: "bash", shellExecutable: missing }, fixture);
    try {
      const result = await runIn(kernel, fixture.env, "exec", { command: "echo should-not-run" });
      assert.equal(result.error?.code, "shell_not_found");
      assert.match(result.output, /bash executable not found/);
    } finally {
      await host.dispose();
      await kernel.dispose();
      fixture.dispose();
    }
  });

  it("applies config changes to the exec tool by restarting the plugin", async () => {
    const kernel = Context.create();
    process.env.XUENESS_SHELL_PLUGIN_TOKEN = "visible";
    const host = new PluginHost(kernel, [shell]);
    try {
      const [status] = await host.start();
      assert.equal(status?.state, "active", status?.error ?? "");
      assert.equal(kernel.tools.ownerOf("exec"), "shell");
      const systemCommand = process.platform === "win32" ? "Write-Output system-default" : "printf system-default";
      assert.equal((await call(kernel, "exec", { command: systemCommand })).output, "system-default");
      const printToken = [process.execPath, "-e", "console.log(process.env.XUENESS_SHELL_PLUGIN_TOKEN ?? 'scrubbed')"];
      assert.match((await exec(kernel, printToken)).output, /scrubbed/);

      await assert.rejects(host.configure("shell", { defaultTimeoutMs: 5 }), PluginConfigError);
      const restarted = await host.configure("shell", { defaultTimeoutMs: 1000, passEnv: ["XUENESS_SHELL_PLUGIN_TOKEN"] });
      assert.deepEqual([restarted.state, restarted.activations], ["active", 2]);
      assert.match((await exec(kernel, printToken)).output, /visible/);
      const slow = await exec(kernel, [process.execPath, "-e", "setTimeout(() => {}, 20000)"]);
      assert.equal(slow.data.timedOut, true, slow.output);
      assert.ok(slow.data.durationMs < 10_000, `timed out after ${slow.data.durationMs} ms`);
    } finally {
      delete process.env.XUENESS_SHELL_PLUGIN_TOKEN;
      await host.dispose();
      await kernel.dispose();
    }
  });

  it("stops every background task when it is disabled or reconfigured", async () => {
    const kernel = Context.create();
    const host = new PluginHost(kernel, [shell]);
    try {
      await host.start();
      const startTask = async (): Promise<BackgroundTaskInfo> => {
        const source = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log('child '+child.pid); setInterval(()=>{},1000);";
        const result = await call(kernel, "exec", { argv: [process.execPath, "-e", source], background: true });
        assert.equal(result.ok, true, result.output);
        return result.data as BackgroundTaskInfo;
      };
      const childOf = async (task: BackgroundTaskInfo): Promise<number> => {
        for (let tries = 0; tries < 200; tries += 1) {
          const read = await call(kernel, "exec_output", { task_id: task.id });
          const match = /child (\d+)/.exec(read.output);
          if (match) return Number(match[1]);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("no child pid");
      };
      const first = await startTask();
      const firstChild = await childOf(first);
      assert.equal((await call(kernel, "exec_output", { task_id: first.id })).ok, true);
      await host.configure("shell", { maxBackgroundTasks: 2 });
      assert.ok(await gone(first.pid as number, firstChild), "reconfiguring restarts the plugin and stops its tasks");
      assert.equal((await call(kernel, "exec_output", { task_id: first.id })).error?.code, "unknown_task");

      const second = await startTask();
      const secondChild = await childOf(second);
      const read = (await call(kernel, "exec_output", { task_id: second.id })).data as TaskRead;
      assert.equal(read.info.state, "running");
      await host.disable("shell");
      assert.equal(kernel.tools.get("exec"), undefined);
      assert.ok(await gone(second.pid as number, secondChild), "disabling the plugin stops its tasks");
    } finally {
      await host.dispose();
      await kernel.dispose();
    }
  });

  it("captures bash aliases, functions and PATH once, then recaptures after the rc signature changes", { skip: !resolveBashShell("") }, async () => {
    const fixture = makeFixture();
    const home = join(fixture.workspace, "home 用户 space");
    mkdirSync(home);
    const rcPath = join(home, ".bashrc");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const config = { shellMode: "bash", captureInit: true };
    const { kernel, host } = await startConfigured(config, fixture);
    const readConfigured = async () => runIn(kernel, fixture.env, "exec", {
      command: `init_alias; printf '|'; init_function; printf '|%s|%s|%s' "$XUENESS_RC_ONLY" "$PATH" "$PWD"`,
    });
    try {
      writeFileSync(rcPath, [
        "alias init_alias='printf alias-one'",
        "init_function() { printf function-one; }",
        "export XUENESS_RC_ONLY=must-not-be-snapshotted",
        "PATH=\"$PATH:/xueness-rc-path-one\"",
        "pwd > \"$HOME/captured-cwd\"",
        "printf x >> \"$HOME/rc-runs\"",
      ].join("\n"), "utf8");
      const first = await readConfigured();
      assert.equal(first.ok, true, first.output);
      assert.match(first.output, /^alias-one\|function-one\|\|.*xueness-rc-path-one\|/);
      assert.equal(readFileSync(join(home, "rc-runs"), "utf8"), "x");
      assert.equal(readFileSync(join(home, "captured-cwd"), "utf8").trim(), first.output.split("|").at(-1));
      const reused = await readConfigured();
      assert.equal(reused.ok, true, reused.output);
      assert.equal(readFileSync(join(home, "rc-runs"), "utf8"), "x", "unchanged rc reuses its snapshot");

      writeFileSync(rcPath, [
        "alias init_alias='printf alias-two-long'",
        "init_function() { printf function-two-long; }",
        "export XUENESS_RC_ONLY=must-not-be-snapshotted",
        "PATH=\"$PATH:/xueness-rc-path-two\"",
        "pwd > \"$HOME/captured-cwd\"",
        "printf x >> \"$HOME/rc-runs\"",
      ].join("\n"), "utf8");
      const refreshed = await readConfigured();
      assert.equal(refreshed.ok, true, refreshed.output);
      assert.match(refreshed.output, /^alias-two-long\|function-two-long\|\|.*xueness-rc-path-two\|/);
      assert.equal(readFileSync(join(home, "rc-runs"), "utf8"), "xx", "changed rc metadata triggers a fresh capture");
      writeFileSync(rcPath, "return 9\n", "utf8");
      const rejectedRc = await readConfigured();
      assert.equal(rejectedRc.error?.code, "shell_init_failed", "a failed rc source cannot produce a valid snapshot");
    } finally {
      await host.dispose();
      await kernel.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fixture.dispose();
    }
  });

  it("sources the content-hashed startup script after the init snapshot and cleans both files on close", { skip: !resolveBashShell("") }, async () => {
    const fixture = makeFixture();
    const home = join(fixture.workspace, "home with spaces 用户");
    mkdirSync(home);
    writeFileSync(join(home, ".bashrc"), "stage() { printf rc-stage; }\n", "utf8");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const { kernel, host } = await startConfigured({ shellMode: "bash", captureInit: true, startupScript: "stage() { printf startup-stage; }" }, fixture);
    try {
      const first = await runIn(kernel, fixture.env, "exec", { command: "stage" });
      assert.equal(first.output, "startup-stage");
      const second = await runIn(kernel, fixture.env, "exec", { command: "stage" });
      assert.equal(second.output, "startup-stage");
      const files = (directory: string): string[] => {
        if (!existsSync(directory)) return [];
        return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
      };
      assert.equal(files(fixture.stateDir).length, 2, "snapshot and same-hash startup script are reused");
      await host.disable("shell");
      assert.equal(files(fixture.stateDir).length, 0, "plugin close removes only its manager-owned scripts");
    } finally {
      await host.dispose();
      await kernel.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fixture.dispose();
    }
  });

  it("does not source rc or startup scripts for direct argv and preserves shell metacharacters", { skip: !resolveBashShell("") }, async () => {
    const fixture = makeFixture();
    const home = join(fixture.workspace, "argv home");
    mkdirSync(home);
    writeFileSync(join(home, ".bashrc"), "printf sourced >> \"$HOME/rc-marker\"\n", "utf8");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const { kernel, host } = await startConfigured({
      shellMode: "bash", captureInit: true, startupScript: "printf sourced >> \"$HOME/startup-marker\"",
    }, fixture);
    try {
      const injectionMarker = join(fixture.workspace, "cmd-injection-marker.txt");
      const args = [
        "a b", "$HOME", "x&y", "%TEMP%", 'a"b', "space tail\\",
        `quoted" & echo INJECTED > "${injectionMarker}" & rem "`,
      ];
      const result = await runIn(kernel, fixture.env, "exec", {
        argv: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args],
      });
      assert.equal(result.ok, true, result.output);
      assert.equal(result.output, JSON.stringify(args));
      assert.equal(existsSync(join(home, "rc-marker")), false);
      assert.equal(existsSync(join(home, "startup-marker")), false);
      if (process.platform === "win32") {
        const batch = join(fixture.workspace, "literal %& arguments.cmd");
        writeFileSync(batch, "@echo off\r\nnode -e \"console.log(JSON.stringify(process.argv.slice(1)))\" %*\r\n", "utf8");
        const batResult = await runIn(kernel, fixture.env, "exec", { argv: [batch, ...args] });
        assert.equal(batResult.ok, true, batResult.output);
        assert.equal(batResult.output, JSON.stringify(args), "cmd shim receives literal argv values");
        assert.equal(existsSync(injectionMarker), false, "quoted metacharacters cannot execute an extra cmd command");
      }
    } finally {
      await host.dispose();
      await kernel.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fixture.dispose();
    }
  });

  it("uses prepared bash commands in the background task manager", { skip: !resolveBashShell("") }, async () => {
    const fixture = makeFixture();
    const { kernel, host } = await startConfigured({ shellMode: "bash" }, fixture);
    try {
      const result = await runIn(kernel, fixture.env, "exec", { command: "echo bash-background; sleep 30", background: true });
      assert.equal(result.ok, true, result.output);
      const task = result.data as BackgroundTaskInfo;
      assert.match(result.output, new RegExp(task.id));
      const stopped = await runIn(kernel, fixture.env, "exec_kill", { task_id: task.id });
      assert.equal(stopped.ok, true, stopped.output);
      assert.match(stopped.output, /killed/);
    } finally {
      await host.dispose();
      await kernel.dispose();
      fixture.dispose();
    }
  });
});
