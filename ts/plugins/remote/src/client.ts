/**
 * `session_client.py`: an owned, bounded NDJSON JSON-RPC transport to
 * `xueness app-server` over ssh. It never retries a command; a timeout,
 * cancel or broken pipe closes the connection and reports the outcome unknown.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDict, pyDecodeUtf8, pyJsonDumps, pyJsonLoads, pyLen, PyValueError } from "@xueness/contracts";
import { killTree, trackChild } from "@xueness/engine-tools";
import { posixQuote } from "./exec.ts";
import { posixOrThrow, sshArgv, sshEnv, type RemoteConnection } from "./store.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING = 128;
const MAX_STDERR_COUNT = 16384;

export class TransportError extends Error {
  override name = "TransportError";
}

export class RemoteError extends TransportError {
  override name = "RemoteError";
  readonly error: unknown;
  constructor(error: unknown) { super("remote request refused"); this.error = error; }
}

type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SessionClientOptions {
  row: RemoteConnection;
  root: string;
  onClose?: (reason: string) => void;
  onNotification?: (frame: Record<string, unknown>) => void;
  /** Tests substitute the child; production spawns the local ssh client. */
  factory?: Spawner;
}

interface Slot { settle(error: Error | null, value?: unknown): void }

/** Python truthiness for the `request_id or uuid4().hex` fallback. */
function falsy(value: unknown): boolean {
  return value == null || value === false || value === 0 || value === "" || Array.isArray(value) && value.length === 0 || isDict(value) && Object.keys(value).length === 0;
}

export class SessionClient {
  stderrBytes = 0;
  reason: string | null = null;
  private closed = false;
  private readonly pending = new Map<string, Slot>();
  private readonly proc: ChildProcess;
  private readonly untrack: () => void;
  private buffer = Buffer.alloc(0);
  private writes: Promise<void> = Promise.resolve();

  private readonly options: SessionClientOptions;
  constructor(options: SessionClientOptions) {
    this.options = options;
    posixOrThrow(options.row);
    // Only the saved directory is variable; no renderer command or executable.
    const command = "cd -- " + posixQuote(typeof options.row.directory === "string" ? options.row.directory : ".") + " && exec xueness app-server --workspace-root .";
    const argv = sshArgv(options.row, command);
    const factory: Spawner = options.factory ?? ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
    this.proc = factory(argv[0]!, argv.slice(1), { cwd: options.root, env: sshEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32" });
    this.untrack = trackChild(this.proc);
    this.proc.once("exit", () => this.untrack());
    this.proc.on("error", () => this.close("remote transport ended"));
    this.proc.stdin?.on("error", () => this.close("write failed"));
    this.proc.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
    this.proc.stdout?.on("end", () => this.close("remote transport ended"));
    this.proc.stdout?.on("error", () => this.close("remote transport ended"));
    // Never retain host output: credentials, paths and terminal controls can appear here.
    this.proc.stderr?.on("data", (chunk: Buffer) => { this.stderrBytes = Math.min(MAX_STDERR_COUNT, this.stderrBytes + chunk.length); });
    this.proc.stderr?.on("error", () => {});
  }

  get alive(): boolean {
    return !this.closed && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  request(method: string, params?: Record<string, unknown> | null, opts: { timeout?: number; requestId?: unknown; cancel?: { isSet(): boolean } | null } = {}): Promise<unknown> {
    const rid = falsy(opts.requestId) ? randomUUID().replace(/-/g, "") : opts.requestId;
    if (typeof rid !== "string" || pyLen(rid) < 1 || pyLen(rid) > 128) throw new PyValueError("invalid request id");
    const frame = Buffer.from(pyJsonDumps({ jsonrpc: "2.0", id: rid, method, params: falsy(params) ? {} : params }, { ensureAscii: false, allowNan: false }) + "\n", "utf8");
    if (frame.length > MAX_FRAME_BYTES) throw new PyValueError("request frame too large");
    if (!this.alive) throw new TransportError("connection unavailable");
    if (this.pending.has(rid)) throw new TransportError("request id already in flight");
    if (this.pending.size >= MAX_PENDING) throw new TransportError("too many pending requests");
    const timeout = Math.min(Math.max(Number(opts.timeout ?? 30), 0.01), 120) * 1000;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      let finished = false;
      const finish = (error: Error | null, value?: unknown): void => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearInterval(poll); this.pending.delete(rid);
        if (error) rejectRequest(error); else resolveRequest(value);
      };
      this.pending.set(rid, { settle: finish });
      const timer = setTimeout(() => { const error = new TransportError("request timed out; outcome may be unknown"); finish(error); this.close("request timed out"); }, timeout);
      const poll = setInterval(() => {
        if (opts.cancel?.isSet()) { const error = new TransportError("request cancelled; outcome may be unknown"); finish(error); this.close("request cancelled"); }
      }, 50);
      // Writes are serialized; a broken pipe closes the connection.
      this.writes = this.writes.then(() => new Promise<void>((done) => {
        if (this.closed || !this.pending.has(rid)) return done();
        const stdin = this.proc.stdin;
        if (!stdin || stdin.destroyed) { this.close("write failed"); return done(); }
        stdin.write(frame, (error) => { if (error) this.close("write failed"); done(); });
      }));
    });
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
      let end: number;
      while ((end = this.buffer.indexOf(0x0a)) >= 0) {
        if (end + 1 > MAX_FRAME_BYTES) throw new TransportError("remote frame too large");
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        this.frame(pyJsonLoads(pyDecodeUtf8(line), { rejectNonFinite: true }));
        if (this.closed) return;
      }
      if (this.buffer.length >= MAX_FRAME_BYTES) throw new TransportError("remote frame too large");
    } catch {
      this.close("remote transport ended");
    }
  }

  private frame(value: unknown): void {
    if (!isDict(value) || value.jsonrpc !== "2.0") throw new TransportError("invalid remote frame");
    if (Object.hasOwn(value, "id")) {
      const rid = value.id;
      if (typeof rid !== "string" || Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) throw new TransportError("invalid remote response");
      const slot = this.pending.get(rid);
      if (slot) Object.hasOwn(value, "error") ? slot.settle(new RemoteError(value.error)) : slot.settle(null, value.result);
    } else if (typeof value.method === "string") {
      this.options.onNotification?.(value);
    } else throw new TransportError("invalid remote notification");
  }

  close(reason = "disconnected"): void {
    if (this.closed) return;
    this.closed = true; this.reason = reason;
    for (const slot of [...this.pending.values()]) slot.settle(new TransportError(reason + "; outcome may be unknown"));
    this.pending.clear();
    killTree(this.proc, "SIGTERM");
    const grace = setTimeout(() => { if (this.proc.exitCode === null && this.proc.signalCode === null) killTree(this.proc, "SIGKILL"); }, 200);
    grace.unref?.();
    for (const stream of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) { try { stream?.destroy(); } catch { /* already closed */ } }
    this.options.onClose?.(reason);
  }
}
