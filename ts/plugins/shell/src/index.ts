/**
 * The approved command tools as a plugin: `exec`, plus `exec_output` and
 * `exec_kill` for background tasks. Its config, checked against the manifest
 * schema, sets the timeouts, how much output is kept inline and which
 * environment variables reach commands. Background tasks belong to the
 * plugin's scope: disabling or reconfiguring the plugin stops all of them.
 */
import { formatSchemaIssues, validateSchema, type JsonSchema } from "@xueness/contracts";
import { BackgroundTasks, createExecKillTool, createExecOutputTool, createExecTool, defaultShell, resolveExecutionCommand, type ExecOptions, type ToolEnv } from "@xueness/engine-tools";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { resolveBashShell, type BashShellProvider, type ShellDialect } from "./shell-provider.ts";
import { ShellInitSnapshotManager } from "./shell-snapshot.ts";
import { buildBashCommand, StartupScriptManager } from "./startup-script.ts";

export interface ShellRuntimeBinding { tasks?: BackgroundTasks; dialect?: ShellDialect; executable?: string }
export interface ShellRuntimeOptions { stateDir?: string }
export { shellBackgroundExtension, summarizeBackgroundTasks, type BackgroundTaskSummary } from "./background-runtime.ts";

export interface ShellConfig {
  defaultTimeoutMs: number;
  maxCaptureBytes: number;
  scrubEnv: boolean;
  passEnv: string[];
  backgroundTimeoutMs: number;
  maxBackgroundTasks: number;
  shellMode: "system" | "bash";
  shellExecutable: string;
  captureInit: boolean;
  startupScript: string;
}

const schema = manifest.config.schema as JsonSchema;

export function shellConfig(value: unknown): ShellConfig {
  const config = { ...manifest.config.default, ...(value as Partial<ShellConfig> | undefined) } as ShellConfig;
  const issues = validateSchema(schema, config);
  if (issues.length) throw new TypeError(formatSchemaIssues(issues));
  if (config.captureInit && config.shellMode !== "bash") throw new TypeError("captureInit requires shellMode: bash");
  if (config.startupScript.length > 0 && config.shellMode !== "bash") throw new TypeError("startupScript requires shellMode: bash");
  return { ...config, passEnv: [...config.passEnv] };
}

export function execOptions(config: ShellConfig): ExecOptions {
  return {
    defaultTimeoutMs: config.defaultTimeoutMs, maxCaptureBytes: config.maxCaptureBytes, scrubEnv: config.scrubEnv,
    passEnv: config.passEnv, backgroundTimeoutMs: config.backgroundTimeoutMs,
  };
}

export function createShell(binding?: ShellRuntimeBinding, runtimeOptions: ShellRuntimeOptions = {}): BundledPlugin {
  const plugin = definePlugin<ShellConfig>({
    name: "shell",
    validate: shellConfig,
    apply(ctx, config) {
      const tasks = new BackgroundTasks({ maxRunning: config.maxBackgroundTasks });
      const snapshots = new ShellInitSnapshotManager();
      const startupScripts = new StartupScriptManager();
      const provider = config.shellMode === "bash" ? resolveBashShell(config.shellExecutable) : undefined;
      const initialDialect: ShellDialect = config.shellMode === "bash" ? "posix" : process.platform === "win32" ? "powershell" : "posix";
      const initialExecutable = config.shellMode === "bash" ? provider?.executable : (defaultShell()[0] ?? undefined);
      if (binding) {
        binding.tasks = tasks;
        binding.dialect = initialDialect;
        if (initialExecutable) binding.executable = initialExecutable;
        else delete binding.executable;
      }
      // Registered first, so it runs last: the tools are gone before the tasks are stopped.
      ctx.effect(() => async () => {
        if (binding?.tasks === tasks) {
          delete binding.tasks;
          delete binding.dialect;
          delete binding.executable;
        }
        try {
          await tasks.dispose();
        } finally {
          await Promise.allSettled([snapshots.cleanup(), startupScripts.cleanup()]);
        }
      });
      ctx.tool(createExecTool({
        ...execOptions(config), tasks,
        prepareInvocation: async (input, env, base) => prepareShellInvocation(input, env, base, config, provider, binding, runtimeOptions, snapshots, startupScripts),
      }));
      ctx.tool(createExecOutputTool(tasks));
      ctx.tool(createExecKillTool(tasks));
    },
  });
  return { manifest, plugin };
}

export const shell: BundledPlugin = createShell();
export const shellPlugin = shell.plugin;
export { resolveBashShell, type BashShellProvider, type ShellDialect } from "./shell-provider.ts";
export { buildSnapshotScript, ShellInitSnapshotManager, windowsPathToBashPath } from "./shell-snapshot.ts";
export { buildBashCommand, StartupScriptManager } from "./startup-script.ts";

async function prepareShellInvocation(
  input: Parameters<NonNullable<ExecOptions["prepareInvocation"]>>[0],
  toolEnv: ToolEnv,
  base: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv },
  config: ShellConfig,
  selectedProvider: BashShellProvider | undefined,
  binding: ShellRuntimeBinding | undefined,
  runtimeOptions: ShellRuntimeOptions,
  snapshots: ShellInitSnapshotManager,
  startupScripts: StartupScriptManager,
): Promise<{ argv: string[]; cwd: string; env: NodeJS.ProcessEnv }> {
  if (input.argv) {
    return resolveExecutionCommand(base.argv, { cwd: base.cwd, env: base.env });
  }
  if (config.shellMode !== "bash") return base;

  const provider = selectedProvider ?? resolveBashShell(config.shellExecutable);
  if (!provider) {
    const message = config.shellExecutable.trim()
      ? `bash executable not found or unavailable: ${config.shellExecutable}`
      : `no POSIX bash or Git Bash executable was found for shellMode: bash`;
    throw Object.assign(new Error(message), { code: "shell_not_found" });
  }
  if (binding) {
    binding.dialect = provider.dialect;
    binding.executable = provider.executable;
  }

  const env = applyEnvOverlay(base.env, provider.envOverlay);
  const rootDir = runtimeOptions.stateDir ?? toolEnv.artifactsDir;
  const sources = [];
  if (config.captureInit) {
    sources.push(await snapshots.getOrCreate({ rootDir, executable: provider.executable, env, cwd: base.cwd, ...(toolEnv.signal ? { signal: toolEnv.signal } : {}) }));
  }
  if (config.startupScript.length > 0) {
    sources.push(await startupScripts.materialize(rootDir, config.startupScript));
  }
  const command = input.command ?? "";
  return {
    argv: [provider.executable, "--noprofile", "--norc", "-c", buildBashCommand(command, sources)],
    cwd: base.cwd,
    env,
  };
}

function applyEnvOverlay(base: NodeJS.ProcessEnv, overlay: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [name, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    if (process.platform === "win32") {
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === name.toLowerCase()) delete env[existing];
    }
    env[name] = value;
  }
  return env;
}

export { loadShellConfig, createShellSettingsApi } from "./config-api.ts";
