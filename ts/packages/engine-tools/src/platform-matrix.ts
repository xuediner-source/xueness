/**
 * The cross-platform execution adaptation matrix (F05.05).
 *
 * Three platforms run the same exec semantics through different mechanisms:
 *
 * | capability        | Linux / macOS                       | Windows                                     |
 * |-------------------|-------------------------------------|---------------------------------------------|
 * | default `command` | bash (or sh) via ["/bin/bash","-c"] | PowerShell via powershell.exe -Command      |
 * | explicit bash     | /bin/bash and friends              | Git Bash only (never the WSL WindowsApps alias) |
 * | argv runs         | direct spawn                       | direct spawn; .bat/.cmd bridge through cmd.exe with verbatim quoting |
 * | environment       | case-sensitive names               | case-insensitive names; overlay deduplicates case-insensitively |
 * | interactive use   | exec children are non-interactive (stdin closed, NO_COLOR, PAGER=cat); a PTY backend serves the terminal plugin | same, via ConPTY when the prebuild loads |
 * | tree kill         | child runs in its own process group; SIGTERM then SIGKILL to -pgid | taskkill /T /F walks the tree               |
 * | crash cleanup     | host exit hook kills tracked trees | the same hook plus one host job object with KILL_ON_JOB_CLOSE, so a hard host death still ends every child |
 *
 * `executionPlatformMatrix` states the documented expectation for a platform;
 * `probeExecutionPlatform` runs targeted live probes on this machine so a
 * runner can verify the matrix against reality (实机验收) before relying on it.
 */
import { spawn } from "node:child_process";
import { defaultShell } from "./exec.ts";
import { nodePty } from "./pty.ts";
import { killTree } from "./process.ts";
import { hostWindowsJob } from "./windows-job.ts";

export interface ExecutionPlatformMatrix {
  platform: NodeJS.Platform;
  /** Family of the shell that runs a `command` invocation. */
  shell: "posix" | "powershell";
  /** Environment variable names collide case-insensitively. */
  envCaseInsensitive: boolean;
  /** Children get their own process group, so a tree is signalled as a group. */
  processGroups: boolean;
  /** How killTree ends a child's tree at a timeout or on cancel. */
  treeKill: "process-group" | "taskkill";
  /** What ends orphaned children when the host dies without its exit hook. */
  crashCleanup: "job-object" | "exit-hook";
}

/** The documented adaptation matrix for one platform. */
export function executionPlatformMatrix(platform: NodeJS.Platform = process.platform): ExecutionPlatformMatrix {
  if (platform === "win32") {
    return { platform, shell: "powershell", envCaseInsensitive: true, processGroups: false, treeKill: "taskkill", crashCleanup: "job-object" };
  }
  return { platform, shell: "posix", envCaseInsensitive: false, processGroups: true, treeKill: "process-group", crashCleanup: "exit-hook" };
}

/** Live probe results for this machine; `null` where a probe does not apply. */
export interface ExecutionPlatformProbes {
  platform: NodeJS.Platform;
  /** The default shell exists and runs a trivial command. */
  shell: { argv: string[]; ok: boolean; output: string };
  /** POSIX: SIGTERM to the child's group really kills a grandchild. Null on Windows. */
  groupKill: boolean | null;
  /** Windows: the host job object is live (crash cleanup keeps working). Null on POSIX. */
  jobObject: boolean | null;
  /** A pseudo-terminal backend loads (the terminal plugin's interactive mode). */
  pty: boolean;
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Probe the default shell: it must start, print a marker and exit 0. */
async function probeShell(timeoutMs: number): Promise<ExecutionPlatformProbes["shell"]> {
  const argv = [...defaultShell(), process.platform === "win32" ? "Write-Output probe-ok" : "printf probe-ok"];
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      if (!settled) killTree(child, "SIGKILL");
    }, timeoutMs);
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ argv, ok, output });
    };
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0 && output.includes("probe-ok")));
  });
}

/**
 * POSIX probe: spawn `sleep 30 & wait` in its own group, SIGTERM the group
 * like killTree does, and require the grandchild to die too — the guarantee
 * every timeout and cancel on Linux/macOS leans on.
 */
async function probeGroupKill(timeoutMs: number): Promise<boolean | null> {
  if (process.platform === "win32") return null;
  const shell = defaultShell();
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const child = spawn(shell[0] as string, [shell[1] as string, "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"], detached: true, windowsHide: true,
    });
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      finish(false);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const grandchild = Number(/(\d+)/.exec(text)?.[1]);
      if (!Number.isInteger(grandchild) || grandchild <= 1) return;
      clearTimeout(timer);
      killTree(child, "SIGTERM");
      void (async () => {
        for (let tries = 0; tries < 100; tries += 1) {
          if (!alive(grandchild) && !alive(child.pid)) return finish(true);
          await within(20);
        }
        killTree(child, "SIGKILL");
        finish(false);
      })();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Run the targeted probes on this machine. Everything is best-effort: a probe
 * reports what it found; comparing against `executionPlatformMatrix` is the
 * caller's (and the test suite's) job.
 */
export async function probeExecutionPlatform(options: { timeoutMs?: number } = {}): Promise<ExecutionPlatformProbes> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    platform: process.platform,
    shell: await probeShell(timeoutMs),
    groupKill: await probeGroupKill(timeoutMs),
    jobObject: process.platform === "win32" ? hostWindowsJob() !== null : null,
    pty: nodePty() !== null,
  };
}
