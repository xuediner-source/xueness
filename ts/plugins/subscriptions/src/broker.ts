/** On-demand owned Node worker with cancellation and plugin lifecycle cleanup (Python `subscriptions/broker.py`). */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PyValueError } from "@xueness/contracts";
import { ProviderCancelled } from "@xueness/providers";
import { ASSETS, directory } from "./state.ts";

type Row = Record<string, unknown>;
const MAX_LINE = 8_000_000;
const IMPORT_ENV = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "QODER_ACCESS_TOKEN", "QODER_USER_ID", "ANTIGRAVITY_CLIENT_ID", "ANTIGRAVITY_CLIENT_SECRET"]);
const CATEGORIES = new Set(["authentication_failed", "rate_limited", "timeout", "connection_failed", "upstream_failure", "invalid_response", "request_rejected", "request_failed",
  "endpoint_not_found", "quota_exhausted", "unsupported_region", "context_overflow"]);
const monotonic = (): number => performance.now() / 1000;

/** Sanitized bridge failure, retaining the machine-readable upstream cause. */
export class SubscriptionRequestError extends PyValueError {
  readonly category: string;
  readonly status: number | null;
  constructor(message: unknown, info?: unknown) {
    super([...String(message)].slice(0, 700).join(""));
    const data = info !== null && typeof info === "object" && !Array.isArray(info) ? info as Row : {};
    this.category = CATEGORIES.has(data.category as string) ? data.category as string : "request_failed";
    const status = data.status;
    this.status = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  }
}

function requestDeadline(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new PyValueError("invalid subscription request deadline");
  if (monotonic() >= value) throw new SubscriptionRequestError("subscription request timed out", { category: "timeout" });
  return value;
}

export interface CallOptions { onChunk?: (chunk: unknown) => void; start?: boolean; requestDeadline?: number | null; signal?: AbortSignal | null }
interface Waiter { (value: Row | null): void }

export class SubscriptionWorker {
  readonly process: ChildProcess;
  /** Resolves only after the OS process and its stdio handles have closed. */
  readonly stopped: Promise<void>;
  private readonly pending = new Map<string, Waiter>();
  private readonly monitor: NodeJS.Timeout;
  closed = false;
  private readonly requireAvailable: () => void;
  /** `script` is the bundled `worker.mjs`; tests may substitute a worker speaking the same JSON-lines protocol. */
  constructor(stateDir: string, requireAvailable: () => void, baseEnv: NodeJS.ProcessEnv = process.env, script = join(ASSETS, "worker.mjs")) {
    this.requireAvailable = requireAvailable;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(baseEnv)) if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) || IMPORT_ENV.has(key)) env[key] = value;
    env.XUENESS_SUBSCRIPTIONS_STORE = directory(stateDir, true);
    if (baseEnv.XUENESS_DESKTOP_NODE) env.ELECTRON_RUN_AS_NODE = "1";
    this.process = spawn(baseEnv.XUENESS_DESKTOP_NODE || process.execPath, [script], { env, cwd: directory(stateDir), stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
    this.stopped = new Promise<void>((resolve) => this.process.once("close", () => resolve()));
    this.process.on("error", () => this.close());
    this.process.on("exit", () => this.close());
    this.process.stdin?.on("error", () => this.close());
    let buffered: Buffer[] = [], size = 0;
    this.process.stdout?.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
        const line = Buffer.concat([...buffered, chunk.subarray(start, index + 1)]); buffered = []; size = 0; start = index + 1;
        if (line.length > MAX_LINE) return this.close();
        let value: unknown;
        try { value = JSON.parse(line.toString("utf8")); } catch { return this.close(); }
        if (value === null || typeof value !== "object" || Array.isArray(value)) return this.close();
        this.pending.get(String((value as Row).id))?.(value as Row);
      }
      buffered.push(chunk.subarray(start)); size += chunk.length - start;
      if (size > MAX_LINE) this.close();
    });
    this.process.stdout?.on("end", () => this.close());
    this.monitor = setInterval(() => { try { this.requireAvailable(); } catch { this.close(); } }, 250);
    this.monitor.unref();
  }

  private send(value: Row): void {
    const raw = Buffer.from(JSON.stringify(value) + "\n", "utf8");
    if (raw.length > MAX_LINE) throw new PyValueError("subscription request exceeds size limit");
    if (this.closed || this.process.exitCode !== null || this.process.signalCode !== null) throw new SubscriptionRequestError("subscription worker unavailable", { category: "connection_failed" });
    this.process.stdin?.write(raw);
  }

  async call(action: string, provider: string, data: Row = {}, options: CallOptions = {}): Promise<Row> {
    this.requireAvailable();
    const requested = requestDeadline(options.requestDeadline);
    let deadline = monotonic() + (action === "generate" ? 610 : 125);
    if (requested !== null) deadline = Math.min(deadline, requested);
    const id = randomUUID().replaceAll("-", "");
    if (this.closed) throw new SubscriptionRequestError("subscription worker unavailable", { category: "connection_failed" });
    let completed = false, wake: (() => void) | null = null;
    const inbox: Row[] = [];
    this.pending.set(id, (value) => { if (value) inbox.push(value); wake?.(); });
    try {
      this.send({ id, action, provider, data });
      for (;;) {
        this.requireAvailable();
        if (options.signal?.aborted) throw new ProviderCancelled();
        if (this.closed) throw new SubscriptionRequestError("subscription worker stopped", { category: "connection_failed" });
        if (monotonic() >= deadline) throw new SubscriptionRequestError("subscription request timed out", { category: "timeout" });
        const value = inbox.shift();
        if (!value) {
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, Math.max(0, Math.min(200, (deadline - monotonic()) * 1000))); wake = () => { clearTimeout(timer); resolve(); }; });
          wake = null; continue;
        }
        if (Object.hasOwn(value, "chunk")) { options.onChunk?.(value.chunk); continue; }
        completed = true;
        if (value.error) throw new SubscriptionRequestError(value.error, value.errorInfo);
        const result = value.result ?? {};
        return result !== null && typeof result === "object" && !Array.isArray(result) ? result as Row : {};
      }
    } finally {
      if (!completed && !this.closed) { try { this.send({ action: "abort", target: id }); } catch { /* the worker is gone */ } }
      this.pending.delete(id);
    }
  }

  close(): Promise<void> {
    if (this.closed) return this.stopped;
    this.closed = true; clearInterval(this.monitor);
    try { this.process.stdin?.end(); } catch { /* already closed */ }
    for (const waiter of this.pending.values()) waiter(null);
    const pid = this.process.pid;
    const kill = (signal: NodeJS.Signals): void => { try { if (pid && process.platform !== "win32") process.kill(-pid, signal); else this.process.kill(signal); } catch { /* exited */ } };
    if (this.process.exitCode === null && this.process.signalCode === null) {
      kill("SIGTERM");
      setTimeout(() => { if (this.process.exitCode === null && this.process.signalCode === null) kill("SIGKILL"); }, 500).unref();
    }
    this.process.stdout?.destroy();
    return this.stopped;
  }
}

/** One worker per state directory, started on demand. */
export class SubscriptionBroker {
  private worker: SubscriptionWorker | null = null;
  private readonly workers = new Set<SubscriptionWorker>();
  private readonly stateDir: string;
  private readonly requireAvailable: () => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly script: string | undefined;
  constructor(stateDir: string, requireAvailable: () => void, env: NodeJS.ProcessEnv = process.env, script?: string) {
    this.stateDir = stateDir; this.requireAvailable = requireAvailable; this.env = env; this.script = script;
  }
  async call(action: string, provider: string, data: Row = {}, options: CallOptions = {}): Promise<Row> {
    const requested = requestDeadline(options.requestDeadline);
    this.requireAvailable();
    if (this.worker?.closed) this.worker = null;
    if (!this.worker) {
      if (options.start === false) return {};
      this.worker = new SubscriptionWorker(this.stateDir, this.requireAvailable, this.env, this.script);
      const worker = this.worker;
      this.workers.add(worker);
      void worker.stopped.then(() => this.workers.delete(worker));
    }
    return this.worker.call(action, provider, data, { ...options, requestDeadline: requested });
  }
  running(): boolean { return !!this.worker && !this.worker.closed; }
  async shutdown(): Promise<void> {
    this.worker = null;
    await Promise.all([...this.workers].map((worker) => worker.close()));
  }
}
