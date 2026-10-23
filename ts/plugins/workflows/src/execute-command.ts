/**
 * One `kind: "command"` workflow node (Python `workflows._execute`'s command
 * branch, `_terminate`, plus the `windows.py` pipe-streaming variant).
 *
 * Overlapping workspaces are serialized by flock leases: every ancestor of the
 * node's cwd is held shared and the cwd itself exclusive, so disjoint node
 * directories still run in parallel. The lease descriptors are inherited by the
 * child, so a worker that loses its owner cannot release a lease while the
 * command it started is still running.
 *
 * One implementation serves both platforms: a bounded reader queue drains the
 * pipe (Windows selectors only handle sockets, and the same queue is correct on
 * POSIX), the owner independently observes cancel and timeout, and the tree is
 * killed with a two second grace. POSIX children lead their own session and are
 * signalled as a group; Windows trees are ended with `taskkill /T /F`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { numericValue, PyValueError } from "@xueness/contracts";
import { killTree, trackChild } from "@xueness/engine-tools";
import { lockFileSync, PyBlockingIOError, type HeldFileLock } from "@xueness/sessions";
import { resolvePath, type Row } from "./plan.ts";
import { isSymlink } from "./state-file.ts";
import type { WorkflowStore } from "./store.ts";

/** Cancel/timeout observation, supplied by the run driver. */
export interface RunControl {
  /** Current control field: run | pause | cancel. */
  control(): string;
  /** The desktop host has disappeared (POSIX). */
  ownerGone(): boolean;
}

/** Bytes of a node log that are kept; the rest is counted, not written. */
export const LOG_LIMIT = 2_000_000;

const PASS_THROUGH = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"] as const;
const POLL_MS = 50;
const QUEUE_CHUNKS = 32;
/** After the leader exits, how long a pipe a descendant still holds is drained. */
const EXIT_DRAIN_MS = 500;
const EXIT_WAIT_MS = 2000;
const TERMINATE_GRACE_MS = 2000;
/** `terminate_pid(..., grace=0.2)` in the final cleanup. */
const GROUP_GRACE_MS = 200;
const POSIX = process.platform !== "win32";

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, Math.max(0, ms)));
}

/** Only the six variables Python forwards. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASS_THROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** `[*reversed(path.parents), path]`: the root first, the directory itself last. */
function ancestorsThenSelf(directory: string): string[] {
  const parents: string[] = [];
  let current = dirname(directory);
  while (current !== directory && dirname(current) !== current) {
    parents.push(current);
    current = dirname(current);
  }
  if (current !== directory) parents.push(current);
  return [...parents.reverse(), directory];
}

/** `proc.returncode`: a signal death is the negative signal number. */
function exitCodeOf(child: ChildProcess): number | null {
  if (child.exitCode !== null) return child.exitCode;
  const signal = child.signalCode;
  if (signal === null) return null;
  const number = (osConstants.signals as Record<string, number>)[signal];
  return number === undefined ? null : -number;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolve true when the child exited within `ms`; leaves no timer behind. */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((done) => {
    const settle = (): void => {
      clearTimeout(timer);
      done(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", settle);
      done(false);
    }, Math.max(0, ms));
    child.once("exit", settle);
  });
}

/** `terminate_process_tree`: graceful group signal, then force after the grace. */
async function terminateTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || hasExited(child)) return;
  killTree(child, "SIGTERM");
  if (await waitExit(child, TERMINATE_GRACE_MS)) return;
  killTree(child, "SIGKILL");
  await waitExit(child, EXIT_WAIT_MS);
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `terminate_pid(pid, group=True, grace=.2)`: the leader may already have been
 * reaped by the read loop, but its session can still hold descendants.
 */
async function terminateGroup(pid: number, graceMs: number): Promise<void> {
  if (!POSIX || pid <= 1 || pid === process.pid || !groupAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = performance.now() + Math.max(0, graceMs);
  while (performance.now() < deadline) {
    if (!groupAlive(pid)) return;
    await sleep(POLL_MS);
  }
  if (!groupAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group ended between the check and the signal
  }
}

/** `stream.write`: a short write is completed, never dropped. */
function writeAll(fd: number, chunk: Buffer): void {
  for (let offset = 0; offset < chunk.length;) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

/** `Popen` raising `FileNotFoundError`; Node reports a failed spawn as an event. */
function waitSpawned(child: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    child.once("spawn", () => done());
    child.once("error", (error) => fail(error));
  });
}

/** A bounded chunk queue: the reader pauses the pipe instead of growing memory. */
class ChunkQueue {
  #limit: number;
  #items: Buffer[] = [];
  #ended = false;
  #wake: (() => void) | null = null;
  #resume: (() => void) | null = null;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** False when the producer must pause until `onResume` runs. */
  push(chunk: Buffer): boolean {
    this.#items.push(chunk);
    this.#wake?.();
    return this.#items.length < this.#limit;
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  onResume(callback: () => void): void {
    this.#resume = callback;
  }

  take(ms: number): Promise<Buffer | null> {
    const head = this.#items.shift();
    if (head !== undefined) return Promise.resolve(this.#drained(head));
    if (this.#ended) return Promise.resolve(null);
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        done(null);
      }, ms);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        done(this.#drained(this.#items.shift() ?? null));
      };
    });
  }

  #drained(chunk: Buffer | null): Buffer | null {
    if (this.#items.length < this.#limit) {
      const resume = this.#resume;
      this.#resume = null;
      resume?.();
    }
    return chunk;
  }
}

/**
 * Shared ancestor leases then the exclusive cwd lease, non-blocking in a 50 ms
 * poll that re-checks cancel, owner loss and the node timeout. Returns the row
 * Python returns early with, or null once every lease is held.
 */
async function acquireLeases(
  store: WorkflowStore, cwd: string, control: RunControl,
  elapsed: () => number, timeout: number, leases: HeldFileLock[],
): Promise<Row | null> {
  const directory = join(store.directory, ".workspaces");
  for (const target of ancestorsThenSelf(cwd)) {
    const key = createHash("sha256").update(target, "utf8").digest("hex");
    const path = join(directory, key);
    if (isSymlink(path)) throw new PyValueError("invalid workspace lease");
    const shared = target !== cwd;
    for (;;) {
      if (control.ownerGone() || control.control() === "cancel") return { status: "cancelled" };
      if (elapsed() > timeout) return { status: "failed", error: "timeout waiting for workspace lease" };
      try {
        leases.push(lockFileSync(path, { shared, blocking: false }));
        break;
      } catch (error) {
        if (!(error instanceof PyBlockingIOError)) throw error;
        await sleep(POLL_MS);
      }
    }
  }
  return null;
}

/** Run one approved argv to completion and report the row `_execute` returns. */
export async function executeCommandNode(store: WorkflowStore, record: Row, spec: Row, control: RunControl): Promise<Row> {
  const wid = record.id as string;
  const nid = spec.id as string;
  const cwd = resolvePath(resolve(String(record.root), String(spec.cwd)));
  const timeout = numericValue(spec.timeout) ?? 0;
  const started = performance.now();
  const elapsed = (): number => (performance.now() - started) / 1000;

  const leaseDirectory = join(store.directory, ".workspaces");
  if (isSymlink(leaseDirectory)) throw new PyValueError("invalid workspace lease directory");
  mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });

  const leases: HeldFileLock[] = [];
  let child: ChildProcess | null = null;
  let untrack: (() => void) | null = null;
  let logFd: number | null = null;
  try {
    const refused = await acquireLeases(store, cwd, control, elapsed, timeout, leases);
    if (refused !== null) return refused;

    const logPath = store.path(wid, "." + nid + ".log");
    const argv = spec.argv as string[];
    // `pass_fds`: the child keeps the leases alive if this process disappears.
    const inherited = POSIX ? leases.map((lease) => lease.fd) : [];
    const spawned = spawn(argv[0] as string, argv.slice(1), {
      cwd, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe", ...inherited],
      detached: POSIX, windowsHide: true,
    });
    child = spawned;
    untrack = trackChild(spawned);
    spawned.on("error", () => {});
    await waitSpawned(spawned);
    // A failed PID write still owns this process; the finally cleans it up.
    store.update(wid, (row) => {
      (row.nodes as Record<string, Row>)[nid]!.pid = spawned.pid;
    });

    // Python merges stderr into the stdout pipe; two readers feed one log.
    const queue = new ChunkQueue(QUEUE_CHUNKS);
    const streams = [spawned.stdout, spawned.stderr];
    const open = new Set(streams.filter((stream) => stream !== null));
    let exitedAt: number | null = null;
    spawned.once("exit", () => {
      exitedAt = performance.now();
    });
    for (const stream of streams) {
      if (stream === null) continue;
      stream.on("data", (chunk: Buffer) => {
        if (queue.push(chunk)) return;
        for (const each of streams) each?.pause();
        queue.onResume(() => {
          for (const each of streams) each?.resume();
        });
      });
      const done = (): void => {
        if (!open.delete(stream)) return;
        if (open.size === 0) queue.end();
      };
      stream.once("end", done);
      stream.once("error", done);
    }

    logFd = openSync(logPath, "w");
    let reason: "cancelled" | "timeout" | null = null;
    let total = 0;
    let eof = false;
    for (;;) {
      if (control.ownerGone() || control.control() === "cancel") {
        reason = "cancelled";
        break;
      }
      if (elapsed() >= timeout) {
        reason = "timeout";
        break;
      }
      const chunk = eof ? null : await queue.take(POLL_MS);
      if (chunk !== null) {
        if (total < LOG_LIMIT) writeAll(logFd, chunk.subarray(0, LOG_LIMIT - total));
        total += chunk.length;
        continue;
      }
      if (!eof && queue.ended) {
        eof = true;
        // Windows ends on the reader's end-of-stream marker at once; POSIX
        // only ends on EOF once the process is gone, because a descendant can
        // still hold the pipe.
        if (!POSIX) break;
        continue;
      }
      if (hasExited(spawned)) {
        // POSIX: no readable data this poll and the process is gone.
        if (POSIX) break;
        // Windows: give a descendant that still holds the pipe half a second.
        exitedAt ??= performance.now();
        if (performance.now() - exitedAt > EXIT_DRAIN_MS) break;
      }
      if (eof) await sleep(POLL_MS);
    }

    closeSync(logFd);
    logFd = null;
    if (reason !== null) await terminateTree(spawned);
    else if (!(await waitExit(spawned, EXIT_WAIT_MS))) await terminateTree(spawned);

    const exitCode = exitCodeOf(spawned);
    return {
      status: reason === "cancelled" ? "cancelled" : reason === null && exitCode === 0 ? "completed" : "failed",
      exit_code: exitCode,
      error: reason ?? "",
      duration: elapsed(),
      log_capped: total > LOG_LIMIT,
    };
  } finally {
    if (child !== null) {
      const pid = child.pid;
      await terminateTree(child);
      // The leader may already have been reaped by the read loop. Its session
      // can still hold descendants; this is the same final group signal, only
      // for a session this command created.
      if (pid !== undefined) await terminateGroup(pid, GROUP_GRACE_MS);
      child.stdout?.destroy();
      child.stderr?.destroy();
      untrack?.();
    }
    if (logFd !== null) closeSync(logFd);
    for (const lease of [...leases].reverse()) lease.release();
  }
}
