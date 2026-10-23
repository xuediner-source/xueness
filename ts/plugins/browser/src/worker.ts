/**
 * The persistent Playwright worker (Python `_BrowserBroker`, `_broker`,
 * `shutdown`): one `node bridge.mjs <profile>` per state directory speaking
 * JSON lines, with Python's limits (request 100 KB, response 1 MB, start 25 s,
 * call 45 s), its credential-free environment and its managed profile checks.
 * Calls are serialized; any protocol fault closes the worker so the next call starts a fresh one.
 */
import type { ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@xueness/contracts";

type Row = Record<string, unknown>;
export const MAX_REQUEST = 100_000;
export const MAX_RESPONSE = 1_000_000;
export const START_TIMEOUT_MS = 25_000;
export const CALL_TIMEOUT_MS = 45_000;
export const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge.mjs");

/** Starts a worker process; the plugin passes its scoped `ctx.spawn`, tests a fake. */
export type WorkerSpawn = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => { child: ChildProcess; release(): Promise<void> };
const runtimeError = (message: string): Error => Object.assign(new Error(message), { code: "execution_error" });
const valueError = (message: string): Error => Object.assign(new Error(message), { code: "invalid_argument" });

/** `runtime.worker_environment`: no common API credentials reach the browser renderer. */
export function workerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) env[key] = value;
  if (source.XUENESS_DESKTOP_NODE) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** `runtime.worker_command`. */
export function workerCommand(argument: string, source: NodeJS.ProcessEnv = process.env, bridge = BRIDGE): [string, string[]] {
  return [source.XUENESS_DESKTOP_NODE || "node", [bridge, argument]];
}

const isLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

/** `profiles.managed_profile`: `<state>/browser-profile`, never through a link. */
export function managedProfile(stateDir: string): string {
  if (isLink(stateDir)) throw valueError("profile_invalid");
  let state: string;
  try { state = realpathSync(stateDir); } catch { state = resolve(stateDir); }
  const path = join(state, "browser-profile");
  if (exists(path) && (isLink(path) || !statSync(path).isDirectory())) throw valueError("profile_invalid");
  return path;
}

/** The checks `_BrowserBroker.__init__` makes before the worker may own the profile. */
export function prepareProfile(stateDir: string): string {
  const profile = managedProfile(stateDir), state = dirname(profile);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (isLink(profile) || !statSync(profile).isDirectory() || dirname(realpathSync(profile)) !== state) throw valueError("browser profile path is unsafe");
  if (process.platform !== "win32") chmodSync(profile, 0o700);
  return profile;
}

export class BrowserWorker {
  #child: ChildProcess; #release: () => Promise<void>;
  #lines: (string | Error | null)[] = []; #waiters: ((line: string | Error | null) => void)[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #callTimeoutMs = CALL_TIMEOUT_MS;
  readonly profile: string;

  private constructor(profile: string, child: ChildProcess, release: () => Promise<void>) {
    this.profile = profile; this.#child = child; this.#release = release;
    let pending: Buffer = Buffer.alloc(0), done = false;
    const push = (item: string | Error | null): void => { if (done) return; if (item === null || item instanceof Error) done = true; const waiter = this.#waiters.shift(); if (waiter) waiter(item); else this.#lines.push(item); };
    child.stdout?.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (let newline = pending.indexOf(10); newline !== -1 && !done; newline = pending.indexOf(10)) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        if (line.length + 1 > MAX_RESPONSE) { push(new RangeError("browser response exceeded the size limit")); return; }
        push(line.toString("utf8") + "\n");
      }
      if (pending.length >= MAX_RESPONSE) push(new RangeError("browser response exceeded the size limit"));
    });
    child.stdout?.once("end", () => push(null));
    child.once("exit", () => push(null));
    child.once("error", () => push(null));
    child.stdin?.on("error", () => {});
  }

  #next(timeoutMs: number): Promise<string | Error | null | "timeout"> {
    if (this.#lines.length) return Promise.resolve(this.#lines.shift()!);
    return new Promise((done) => {
      const timer = setTimeout(() => { const index = this.#waiters.indexOf(waiter); if (index >= 0) this.#waiters.splice(index, 1); done("timeout"); }, timeoutMs);
      const waiter = (line: string | Error | null): void => { clearTimeout(timer); done(line); };
      this.#waiters.push(waiter);
    });
  }

  /** Start the worker and wait for its `{"ready": true}` line. */
  static async start(stateDir: string, root: string, spawn: WorkerSpawn, options: { env?: NodeJS.ProcessEnv; bridge?: string; startTimeoutMs?: number; callTimeoutMs?: number } = {}): Promise<BrowserWorker> {
    const profile = prepareProfile(stateDir), source = options.env ?? process.env;
    const [file, args] = workerCommand(profile, source, options.bridge);
    let spawned: ReturnType<WorkerSpawn>;
    try { spawned = spawn(file, args, { cwd: root, env: workerEnvironment(source) }); }
    catch { throw runtimeError("browser worker did not start; Node, Playwright and Chromium are required"); }
    const worker = new BrowserWorker(profile, spawned.child, spawned.release);
    if (options.callTimeoutMs) worker.#callTimeoutMs = options.callTimeoutMs;
    const first = await worker.#next(options.startTimeoutMs ?? START_TIMEOUT_MS);
    if (first === "timeout") { await worker.close(); throw runtimeError("browser worker did not start; Node, Playwright and Chromium are required"); }
    let ready: unknown = null;
    if (typeof first === "string") { try { ready = JSON.parse(first); } catch { ready = null; } }
    if (!ready || typeof ready !== "object" || Array.isArray(ready) || (ready as Row).ready !== true) {
      await worker.close();
      const reason = ready && typeof ready === "object" ? (ready as Row).reason : null;
      throw runtimeError("browser worker could not start: " + (["driver_missing", "browser_missing", "launch_failed"].includes(reason as string) ? reason as string : "invalid_response"));
    }
    return worker;
  }

  get running(): boolean { const child = this.#child; return !this.#closed && child.exitCode === null && child.signalCode === null; }

  /** One request and its response line, serialized behind earlier calls. */
  call(command: Row): Promise<Row> {
    const encoded = pyJsonDumps(command, { separators: [",", ":"] });
    if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST) return Promise.reject(valueError("browser request exceeds the size limit"));
    const run = this.#tail.catch(() => {}).then(async (): Promise<Row> => {
      if (!this.running) { await this.close(); throw runtimeError("browser worker stopped"); }
      const written = await new Promise<boolean>((done) => { const stdin = this.#child.stdin; if (!stdin || stdin.destroyed) { done(false); return; } stdin.write(encoded + "\n", "utf8", (error) => done(!error)); });
      const raw = written ? await this.#next(this.#callTimeoutMs) : "timeout";
      if (raw === "timeout") { await this.close(); throw runtimeError("browser worker timed out or stopped"); }
      if (raw === null || raw instanceof Error) { await this.close(); throw runtimeError("browser worker returned invalid output"); }
      let result: unknown;
      try { result = JSON.parse(raw); } catch { await this.close(); throw runtimeError("browser worker returned invalid JSON"); }
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Row).ok !== "boolean") { await this.close(); throw runtimeError("browser worker returned an invalid response"); }
      return result as Row;
    });
    this.#tail = run;
    return run;
  }

  /** End stdin, then the whole process tree (the scope's group kill). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#child.stdin?.end(); } catch { /* already closed */ }
    for (const waiter of this.#waiters.splice(0)) waiter(null);
    await this.#release().catch(() => {});
  }

  /** Resolves once every call queued so far has settled. */
  idle(): Promise<void> { return this.#tail.then(() => {}, () => {}); }
}
