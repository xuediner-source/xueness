/**
 * Child processes for the exec tool.
 *
 * stdin is closed, stdout and stderr are captured separately with bounded
 * memory, and the whole process tree is killed on timeout or cancel: POSIX
 * children run in their own process group (signalled as a group, SIGTERM
 * then SIGKILL), Windows trees are ended with `taskkill /T /F`. A missing
 * executable is a result, not an exception.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StreamCapture, type CapturedOutput } from "./output-capture.ts";
import { hostWindowsJob } from "./windows-job.ts";

export interface RunProcessOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-stream in-memory budget in bytes. */
  maxCaptureBytes: number;
  /** Files for the full stdout/stderr when a stream outgrows the budget. */
  spool?: { stdout: string; stderr: string };
  killGraceMs?: number;
  /** After the main process exits, how long to wait for inherited pipes. */
  drainMs?: number;
  /** Preserve a caller-built Windows command line exactly (cmd batch-file bridge only). */
  windowsVerbatimArguments?: boolean;
  /**
   * At the deadline, hand the still-running child to a background task
   * instead of killing its tree. `canAdopt` is checked synchronously when the
   * deadline fires; `adopt` then receives the child with its streams paused
   * and the capture finished, and returns false when it could not take it
   * (the tree is killed and the run settles as a normal timeout).
   */
  onDeadline?: {
    canAdopt(): boolean;
    adopt(handoff: DeadlineHandoff): Promise<boolean>;
  };
}

/** What a deadline adoption takes over: the live child plus what it wrote so far. */
export interface DeadlineHandoff {
  child: ChildProcess;
  /** Output already delivered before the deadline, per stream. */
  carried: { stdout: CarriedCapture; stderr: CarriedCapture };
  /** Wall-clock start of the foreground run, so the task reports true duration. */
  startedAt: number;
}

/** Capture at handoff time: in-memory chunks, or the spill file with everything. */
export interface CarriedCapture {
  chunks: readonly Buffer[];
  /** Bytes the stream had produced when the handoff happened. */
  totalBytes: number;
  spillPath?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  timedOut: boolean;
  cancelled: boolean;
  /** Output pipes were still held by background processes when we stopped reading. */
  detachedBackground: boolean;
  /** The deadline handed the still-running child to a background task. */
  adopted: boolean;
  durationMs: number;
  spawnError?: { code: string; message: string };
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Signal a child's whole tree: its process group on POSIX, `taskkill /T` on Windows. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of live) killTree(child, "SIGKILL");
  });
}

/** Kill the child's tree if this process exits first; the returned function forgets it. */
export function trackChild(child: ChildProcess): () => void {
  installExitHook();
  live.add(child);
  return () => void live.delete(child);
}

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  const stdout = new StreamCapture(options.maxCaptureBytes, options.spool?.stdout);
  const stderr = new StreamCapture(options.maxCaptureBytes, options.spool?.stderr);
  const grace = options.killGraceMs ?? 2000;
  installExitHook();
  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let detachedBackground = false;
    let adopted = false;
    /** A handoff is in flight: the child may exit, but this run no longer settles it. */
    let adopting = false;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnError: { code: string; message: string } | undefined;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    // Windows: a job object holds the tree even if this host dies without its
    // exit hook; `taskkill /T` at kill time stays the per-child mechanism.
    if (process.platform === "win32" && child.pid !== undefined) hostWindowsJob()?.assign(child.pid);
    live.add(child);
    const stop = (): void => {
      killTree(child, "SIGTERM");
      timers.push(setTimeout(() => killTree(child, "SIGKILL"), grace));
    };
    const onAbort = (): void => {
      // After a deadline adoption the parent cancel link is released: the
      // task, not the caller, owns the child's lifecycle now.
      if (adopted) return;
      cancelled = true;
      stop();
    };
    const onOut = (chunk: Buffer): void => stdout.push(chunk);
    const onErr = (chunk: Buffer): void => stderr.push(chunk);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exit = { code, signal };
      timers.push(setTimeout(() => {
        detachedBackground = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish();
      }, options.drainMs ?? 500));
    };
    const finish = async (): Promise<void> => {
      if (settled || adopting) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (timedOut || cancelled) killTree(child, "SIGKILL");
      options.signal?.removeEventListener("abort", onAbort);
      if (!detachedBackground) live.delete(child);
      const [out, err] = await Promise.all([stdout.finish(), stderr.finish()]);
      resolve({
        exitCode: exit?.code ?? null, signal: exit?.signal ?? null, stdout: out, stderr: err,
        timedOut, cancelled, detachedBackground, adopted, durationMs: Math.round(performance.now() - started),
        ...(spawnError ? { spawnError } : {}),
      });
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = { code: error.code ?? "spawn_failed", message: error.message };
      if (child.pid === undefined) void finish();
    });
    child.on("exit", onExit);
    child.on("close", () => void finish());
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => {
      // Foreground deadline: an eligible command with a live adoption receiver
      // keeps running as a background task instead of being killed. Pause the
      // streams first so nothing is lost between the old and new listeners.
      if (!options.onDeadline?.canAdopt() || cancelled || settled) {
        timedOut = true;
        stop();
        return;
      }
      adopted = true;
      adopting = true;
      const receiver = options.onDeadline;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.pause();
      child.stderr?.pause();
      child.stdout?.removeListener("data", onOut);
      child.stderr?.removeListener("data", onErr);
      child.removeListener("exit", onExit);
      void (async () => {
        const outSnap = stdout.snapshot();
        const errSnap = stderr.snapshot();
        const [out, err] = await Promise.all([stdout.finish(), stderr.finish()]);
        const taken = await receiver?.adopt({
          child,
          carried: {
            stdout: { chunks: outSnap.chunks, totalBytes: outSnap.totalBytes, ...(outSnap.spillPath ? { spillPath: outSnap.spillPath } : {}) },
            stderr: { chunks: errSnap.chunks, totalBytes: errSnap.totalBytes, ...(errSnap.spillPath ? { spillPath: errSnap.spillPath } : {}) },
          },
          startedAt: started,
        });
        settled = true;
        if (!taken) {
          // Refused at the last moment (capacity raced away): fall back to the
          // plain timeout settlement, with the output captured so far. The
          // child was never handed over, so this run still owns it and must
          // end its tree; leaving it running would orphan an unowned process.
          timedOut = true;
          killTree(child, "SIGKILL");
          live.delete(child);
          resolve({
            exitCode: null, signal: null, stdout: out, stderr: err, timedOut, cancelled,
            detachedBackground: true, adopted: false, durationMs: Math.round(performance.now() - started),
          });
          return;
        }
        child.stdout?.resume();
        child.stderr?.resume();
        resolve({
          exitCode: null, signal: null, stdout: out, stderr: err, timedOut: false, cancelled,
          detachedBackground: true, adopted: true, durationMs: Math.round(performance.now() - started),
        });
      })();
    }, options.timeoutMs));
  });
}
