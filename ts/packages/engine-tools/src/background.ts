/**
 * Background command tasks for the exec tool.
 *
 * A task runs in its own process group (POSIX) with stdin closed. Its stdout
 * and stderr go in full to log files in the artifacts directory (never the
 * workspace; each capped in size), and the output the model has not read yet
 * stays in memory as head + tail, so every read returns only new output, with
 * bounded size. A task ends when it exits, is killed, hits its timeout, or
 * when the manager is disposed: the shell plugin ties the manager to its
 * scope, so disabling the plugin stops every task it started.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { cutHead, cutTail, decodeOutput } from "./output-capture.ts";
import { killTree, trackChild, type CarriedCapture } from "./process.ts";
import { hostWindowsJob } from "./windows-job.ts";

export type TaskState = "running" | "exited" | "killed" | "timed_out" | "failed";

export interface TaskStreamInfo {
  /** Bytes the stream produced so far. */
  bytes: number;
  /** Bytes written to the log file (stops at the size cap). */
  logged: number;
  path: string;
}

export interface BackgroundTaskInfo {
  id: string;
  command: string;
  cwd: string;
  owner: string | null;
  pid: number | null;
  state: TaskState;
  exitCode: number | null;
  signal: string | null;
  /** Something in the task's process tree still holds its output open. */
  outputOpen: boolean;
  /** This task began as a foreground run that hit its deadline and moved over. */
  adopted?: boolean;
  startedAt: string;
  durationMs: number;
  timeoutMs: number;
  stdout: TaskStreamInfo;
  stderr: TaskStreamInfo;
  error?: { code: string; message: string };
}

export interface TaskOutputChunk {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface TaskRead {
  info: BackgroundTaskInfo;
  stdout: TaskOutputChunk;
  stderr: TaskOutputChunk;
}

export interface StartTaskOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  /** Working directory as shown to the model. */
  cwdDisplay?: string;
  env: NodeJS.ProcessEnv;
  /** Command as shown to the model. */
  command: string;
  timeoutMs: number;
  /** Existing directory for the log files; must be outside the workspace. */
  logDir: string;
  owner?: string | null;
  /** Preserve a caller-built Windows command line exactly (cmd batch-file bridge only). */
  windowsVerbatimArguments?: boolean;
}

/** A foreground run's still-live child, handed over at its deadline. */
export interface AdoptTaskOptions {
  child: ChildProcess;
  cwd: string;
  cwdDisplay?: string;
  command: string;
  timeoutMs: number;
  logDir: string;
  owner?: string | null;
  /** performance.now() of the original spawn, so duration covers the foreground part. */
  beganAt?: number;
  /** Output the foreground run already captured and showed; goes into the logs only. */
  carried?: { stdout?: CarriedCapture; stderr?: CarriedCapture };
}

export interface BackgroundTasksOptions {
  /** Tasks that may run at once (default 8). */
  maxRunning?: number;
  /** Finished tasks kept for reading; older ones and their logs are dropped (default 32). */
  maxKept?: number;
  /** Size cap of each log file in bytes (default 64 MiB). */
  maxLogBytes?: number;
  /** In-memory budget per stream for output not read yet (default 24 KiB). */
  unreadBytes?: number;
  killGraceMs?: number;
}

export class BackgroundTaskError extends Error {
  override name = "BackgroundTaskError";
  readonly code: string;
  constructor(code: "too_many_tasks" | "unknown_task" | "tasks_closed", message: string) {
    super(message);
    this.code = code;
  }
}

/** Output not read yet: everything while it fits, else the first and last halves. */
class Unread {
  readonly #max: number;
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;
  #total = 0;

  constructor(max: number) {
    this.#max = Math.max(2, max);
  }

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    const half = Math.floor(this.#max / 2);
    if (this.#headBytes < half) {
      const take = chunk.subarray(0, half - this.#headBytes);
      this.#head.push(take);
      this.#headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (!chunk.length) return;
    this.#tail.push(chunk);
    this.#tailBytes += chunk.length;
    while (this.#tail.length > 1 && this.#tailBytes - (this.#tail[0] as Buffer).length >= this.#max - half) {
      this.#tailBytes -= (this.#tail.shift() as Buffer).length;
    }
  }

  take(): TaskOutputChunk {
    const head = Buffer.concat(this.#head);
    const tailAll = Buffer.concat(this.#tail);
    const total = this.#total;
    this.#head = [];
    this.#tail = [];
    this.#headBytes = this.#tailBytes = this.#total = 0;
    if (total <= this.#max) return { text: decodeOutput(Buffer.concat([head, tailAll])), bytes: total, truncated: false };
    const tail = cutTail(tailAll.subarray(Math.max(0, tailAll.length - (this.#max - Math.floor(this.#max / 2)))));
    const kept = cutHead(head);
    const omitted = total - kept.length - tail.length;
    return { text: `${decodeOutput(kept)}\n… [${omitted} bytes omitted] …\n${decodeOutput(tail)}`, bytes: total, truncated: true };
  }
}

interface Task {
  info: BackgroundTaskInfo;
  child: ChildProcess;
  started: number;
  unread: { stdout: Unread; stderr: Unread };
  files: WriteStream[];
  exited: Promise<void>;
  closed: Promise<void>;
  /** Record the exit and stop the task's own time limit. */
  settle(): void;
  /** The task's own time limit; cleared when the main process exits. */
  timeout: NodeJS.Timeout | null;
  /** SIGKILL after the grace period; kept until the whole tree let go of the output. */
  escalate: NodeJS.Timeout | null;
  stopping: "killed" | "timed_out" | null;
}

const STREAMS = ["stdout", "stderr"] as const;

/** Resolve when `promise` settles or after `ms`, whichever is first; leaves no timer behind. */
function within(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
    promise.then(done, done);
  });
}

function copy(info: BackgroundTaskInfo, started: number): BackgroundTaskInfo {
  const durationMs = info.state === "running" ? Math.round(performance.now() - started) : info.durationMs;
  return { ...info, durationMs, stdout: { ...info.stdout }, stderr: { ...info.stderr }, ...(info.error ? { error: { ...info.error } } : {}) };
}

export class BackgroundTasks {
  readonly #tasks = new Map<string, Task>();
  readonly #maxRunning: number;
  readonly #maxKept: number;
  readonly #maxLogBytes: number;
  readonly #unreadBytes: number;
  readonly #grace: number;
  #closed = false;

  constructor(options: BackgroundTasksOptions = {}) {
    this.#maxRunning = options.maxRunning ?? 8;
    this.#maxKept = options.maxKept ?? 32;
    this.#maxLogBytes = options.maxLogBytes ?? 64 * 1024 * 1024;
    this.#unreadBytes = options.unreadBytes ?? 24 * 1024;
    this.#grace = options.killGraceMs ?? 2000;
  }

  get running(): number {
    return [...this.#tasks.values()].filter((task) => task.info.state === "running").length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Start a task; resolves once the process started (or failed to). */
  async start(options: StartTaskOptions): Promise<BackgroundTaskInfo> {
    if (this.#closed) throw new BackgroundTaskError("tasks_closed", "background tasks are shut down");
    if (!this.#hasCapacity()) {
      throw new BackgroundTaskError("too_many_tasks", `at most ${this.#maxRunning} background tasks may run at once; stop one with exec_kill`);
    }
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const { task, carriedDone } = this.#register({
      child, logDir: options.logDir, cwd: options.cwd, cwdDisplay: options.cwdDisplay, command: options.command,
      timeoutMs: options.timeoutMs, owner: options.owner,
    });
    const info = task.info;
    const started = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error: NodeJS.ErrnoException) => resolve(error));
    });
    if (started) {
      info.state = "failed";
      info.error = { code: started.code === "ENOENT" ? "command_not_found" : "spawn_failed", message: started.message };
      task.settle();
      this.#tasks.delete(info.id);
      await task.closed;
      await Promise.all([info.stdout.path, info.stderr.path].map((path) => rm(path, { force: true })));
      return copy(info, task.started);
    }
    task.timeout = setTimeout(() => this.#stop(task, "timed_out"), options.timeoutMs);
    return copy(info, task.started);
  }

  /** Whether a foreground deadline adoption would be taken right now. */
  canAdopt(): boolean {
    return !this.#closed && this.#hasCapacity();
  }

  /**
   * Take over a still-running child as a background task: a foreground
   * command whose deadline arrived and which may keep running. The output it
   * wrote in the foreground goes into the task's log files (the model already
   * saw it), so reads stay incremental and the logs stay complete. Null when
   * it cannot be taken; the caller then settles the run as a plain timeout.
   */
  async adopt(options: AdoptTaskOptions): Promise<BackgroundTaskInfo | null> {
    if (!this.canAdopt()) return null;
    const child = options.child;
    if (child.pid === undefined || child.exitCode !== null || child.killed) return null;
    const { task, carriedDone } = this.#register({
      child, logDir: options.logDir, cwd: options.cwd, cwdDisplay: options.cwdDisplay, command: options.command,
      timeoutMs: options.timeoutMs, owner: options.owner, beganAt: options.beganAt, adopted: true, carried: options.carried,
    });
    // The handed-over streams stay paused until the carried output has been
    // written, so the log keeps its order.
    await Promise.all(carriedDone);
    // The child may have exited while the carried output was being copied (a
    // handoff at the very end of a run). Such a task is already over, so it
    // gets no time limit: the timer would otherwise outlive it by the whole
    // background timeout and hold the log files open for that long.
    if (task.info.state === "running") task.timeout = setTimeout(() => this.#stop(task, "timed_out"), options.timeoutMs);
    return copy(task.info, task.started);
  }

  get(id: string, owner?: string | null): BackgroundTaskInfo | undefined {
    const task = this.#tasks.get(id);
    return task && this.#visible(task, owner) ? copy(task.info, task.started) : undefined;
  }

  list(owner?: string | null): BackgroundTaskInfo[] {
    return [...this.#tasks.values()].filter((task) => this.#visible(task, owner)).map((task) => copy(task.info, task.started));
  }

  /** New output since the last read; with `waitMs`, first wait up to that long for the task to finish. */
  async read(id: string, options: { owner?: string | null; waitMs?: number; signal?: AbortSignal } = {}): Promise<TaskRead> {
    const task = this.#find(id, options.owner);
    if (options.waitMs && task.info.state === "running") await within(task.exited, options.waitMs, options.signal);
    // closed also waits for log files; pipe EOF can arrive before their writes flush.
    if (task.info.state !== "running") await within(task.closed, 200, options.signal);
    return { info: copy(task.info, task.started), stdout: task.unread.stdout.take(), stderr: task.unread.stderr.take() };
  }

  /** Stop a task's whole process tree (also one whose main process exited but left children holding its output). */
  async kill(id: string, owner?: string | null): Promise<TaskRead> {
    const task = this.#find(id, owner);
    this.#stop(task, "killed");
    await within(task.exited, this.#grace + 1000);
    await within(task.closed, 500);
    return { info: copy(task.info, task.started), stdout: task.unread.stdout.take(), stderr: task.unread.stderr.take() };
  }

  /** Stop every task and release pipes, timers and files. Starting new tasks fails afterwards. */
  async dispose(): Promise<void> {
    this.#closed = true;
    const tasks = [...this.#tasks.values()];
    for (const task of tasks) this.#stop(task, "killed");
    await Promise.all(tasks.map((task) => within(task.closed, this.#grace + 2000)));
    for (const task of tasks) {
      // A process that left the group can keep our pipes open; stop reading them.
      if (task.info.outputOpen) {
        task.child.stdout?.destroy();
        task.child.stderr?.destroy();
      }
      for (const timer of [task.timeout, task.escalate]) if (timer) clearTimeout(timer);
      task.timeout = task.escalate = null;
    }
    await Promise.all(tasks.map((task) => within(task.closed, 1000)));
  }

  #hasCapacity(): boolean {
    return this.running < this.#maxRunning;
  }

  /** Create the task record and wire pipes and exit/close handling for a live child. */
  #register(meta: {
    child: ChildProcess;
    logDir: string;
    cwd: string;
    cwdDisplay?: string;
    command: string;
    timeoutMs: number;
    owner?: string | null;
    beganAt?: number;
    adopted?: boolean;
    carried?: { stdout?: CarriedCapture; stderr?: CarriedCapture };
  }): { task: Task; carriedDone: Promise<void>[] } {
    const child = meta.child;
    let id = `bg_${randomBytes(4).toString("hex")}`;
    while (this.#tasks.has(id)) id = `bg_${randomBytes(4).toString("hex")}`;
    const paths = { stdout: join(meta.logDir, `${id}.stdout.log`), stderr: join(meta.logDir, `${id}.stderr.log`) };
    // Windows: the host job object also holds background trees, so a host
    // crash cannot leave them behind; per-child kills stay `killTree`'s job.
    if (process.platform === "win32" && child.pid !== undefined) hostWindowsJob()?.assign(child.pid);
    const untrack = trackChild(child);
    // Later errors (a failed kill) must not be unhandled.
    child.on("error", () => {});
    const carried = (name: "stdout" | "stderr"): number => meta.carried?.[name]?.totalBytes ?? 0;
    const info: BackgroundTaskInfo = {
      id, command: meta.command, cwd: meta.cwdDisplay ?? meta.cwd, owner: meta.owner ?? null, pid: child.pid ?? null,
      state: "running", exitCode: null, signal: null, outputOpen: true,
      startedAt: new Date(Date.now() - (meta.beganAt === undefined ? 0 : performance.now() - meta.beganAt)).toISOString(),
      durationMs: 0, timeoutMs: meta.timeoutMs,
      stdout: { bytes: carried("stdout"), logged: 0, path: paths.stdout }, stderr: { bytes: carried("stderr"), logged: 0, path: paths.stderr },
      ...(meta.adopted ? { adopted: true } : {}),
    };
    let markExited!: () => void;
    let markClosed!: () => void;
    const task: Task = {
      info, child, started: meta.beganAt ?? performance.now(), unread: { stdout: new Unread(this.#unreadBytes), stderr: new Unread(this.#unreadBytes) }, files: [],
      exited: new Promise((resolve) => (markExited = resolve)), closed: new Promise((resolve) => (markClosed = resolve)),
      settle: () => {
        info.durationMs = Math.round(performance.now() - task.started);
        if (task.timeout) clearTimeout(task.timeout);
        task.timeout = null;
        markExited();
      },
      timeout: null, escalate: null, stopping: null,
    };
    this.#tasks.set(id, task);
    const carriedDone: Promise<void>[] = [];
    for (const name of STREAMS) task.files.push(this.#pipe(task, name, child[name] as Readable, paths[name], meta.carried?.[name], carriedDone));
    child.on("exit", (code, signal) => {
      info.exitCode = code;
      info.signal = signal;
      info.state = task.stopping ?? "exited";
      task.settle();
    });
    child.on("close", () => {
      info.outputOpen = false;
      if (task.escalate) clearTimeout(task.escalate);
      task.escalate = null;
      untrack();
      void Promise.all(task.files.map((file) => new Promise<void>((resolve) => {
        if (file.closed) return resolve();
        file.once("close", () => resolve());
        file.end();
      }))).then(() => {
        markClosed();
        this.#evict();
      });
    });
    return { task, carriedDone };
  }

  #pipe(task: Task, name: "stdout" | "stderr", stream: Readable, path: string, carried: CarriedCapture | undefined, carriedDone: Promise<void>[]): WriteStream {
    const file = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const stats = task.info[name];
    let failed = false;
    file.on("error", () => {
      failed = true;
      stream.resume();
    });
    const save = (chunk: Buffer): void => {
      const room = this.#maxLogBytes - stats.logged;
      if (failed || room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stats.logged += part.length;
      if (!file.write(part)) {
        stream.pause();
        file.once("drain", () => stream.resume());
      }
    };
    if (carried) {
      // Foreground output the model already saw: into the log only, never
      // repeated as unread output, so reads after the handoff stay incremental.
      for (const chunk of carried.chunks) save(chunk);
      if (carried.spillPath) {
        const spill = createReadStream(carried.spillPath);
        carriedDone.push(new Promise<void>((resolve) => {
          spill.on("data", (chunk: string | Buffer) => save(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
          spill.on("end", () => resolve());
          spill.on("error", () => resolve());
        }));
      }
    }
    stream.on("data", (chunk: Buffer) => {
      stats.bytes += chunk.length;
      task.unread[name].push(chunk);
      save(chunk);
    });
    // Attaching the listener above resumes a stream the handoff had paused;
    // with a spill copy still running, keep it paused until the carried
    // output is written, so the log keeps its order (the handoff resumes it).
    if (carried?.spillPath) stream.pause();
    stream.on("error", () => {});
    return file;
  }

  #stop(task: Task, reason: "killed" | "timed_out"): void {
    if (task.info.state === "running") {
      task.stopping ??= reason;
      killTree(task.child, "SIGTERM");
      task.escalate ??= setTimeout(() => {
        task.escalate = null;
        if (task.info.outputOpen) killTree(task.child, "SIGKILL");
      }, this.#grace);
    } else if (task.info.outputOpen) {
      killTree(task.child, "SIGKILL");
    }
  }

  #find(id: string, owner?: string | null): Task {
    const task = this.#tasks.get(id);
    if (!task || !this.#visible(task, owner)) throw new BackgroundTaskError("unknown_task", `no background task ${id}`);
    return task;
  }

  #visible(task: Task, owner: string | null | undefined): boolean {
    return owner === undefined || task.info.owner === owner;
  }

  #evict(): void {
    const finished = [...this.#tasks.values()].filter((task) => task.info.state !== "running" && !task.info.outputOpen);
    for (const task of finished.slice(0, Math.max(0, finished.length - this.#maxKept))) {
      this.#tasks.delete(task.info.id);
      for (const name of STREAMS) void rm(task.info[name].path, { force: true }).catch(() => {});
    }
  }
}
