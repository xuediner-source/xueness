/**
 * stdio transport (Python `McpClient._spawn`, `_spawn_reader`, `_kill_proc`).
 *
 * The child gets a minimal environment (POSIX: PATH and HOME; Windows also
 * the fixed public OS variables) and an argv with no shell. stdout is
 * newline-delimited JSON; lines that are not JSON are skipped. stderr is
 * drained and never shown. The process tree belongs to a forked scope, so
 * closing the connection, or the plugin, ends the whole tree.
 */
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { resolveExecutionCommand } from "@xueness/engine-tools";
import type { Context } from "@xueness/kernel";
import type { Row } from "./names.ts";
import { McpTransportError, RpcChannel } from "./rpc.ts";

const WINDOWS_ENV = new Set(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT", "USERPROFILE"]);
/** One stdout line may not exceed this; a server that floods is cut off. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function childEnvironment(source: NodeJS.ProcessEnv = process.env, windows = process.platform === "win32", configured?: unknown): Record<string, string> {
  const env: Record<string, string> = { PATH: source.PATH ?? (windows ? source.Path ?? "" : ""), HOME: source.HOME ?? "" };
  if (windows) for (const [key, value] of Object.entries(source)) if (WINDOWS_ENV.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    for (const [key, value] of Object.entries(configured)) {
      if (typeof value !== "string") continue;
      const existing = windows ? Object.keys(env).find((current) => current.toUpperCase() === key.toUpperCase()) : undefined;
      if (existing) env[existing] = value;
      else env[key] = value;
    }
  }
  return env;
}

export interface Transport {
  readonly channel: RpcChannel;
  /** A live connection: the child runs / the HTTP session is initialized. */
  readonly active: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
}

export class StdioTransport implements Transport {
  readonly #ctx: Context;
  readonly #server: Row;
  readonly #argv: [string, ...string[]];
  readonly #cwd: string;
  #scope: Context | null = null;
  #child: ChildProcess | null = null;
  channel: RpcChannel;

  constructor(ctx: Context, server: Row, cwd: string) {
    this.#ctx = ctx;
    this.#server = server;
    // The host has already validated server cwd/env and the args shape.
    const extra = Array.isArray(server.args) ? server.args.map(String) : [];
    this.#argv = [String(server.command), ...extra];
    this.#cwd = typeof server.cwd === "string" ? resolve(cwd, server.cwd) : resolve(cwd);
    this.channel = this.#newChannel();
  }

  get active(): boolean {
    const child = this.#child;
    return !!child && child.exitCode === null && child.signalCode === null && !this.channel.closed;
  }

  #newChannel(): RpcChannel {
    return new RpcChannel((message) => this.#write(message));
  }

  async #write(message: Row): Promise<void> {
    const stdin = this.#child?.stdin;
    if (!this.active || !stdin || stdin.destroyed) throw new McpTransportError("server process is not running");
    await new Promise<void>((resolve, reject) => {
      stdin.write(JSON.stringify(message) + "\n", "utf8", (error) => error ? reject(new McpTransportError(`write failed: ${error.name}`)) : resolve());
    });
  }

  async open(): Promise<void> {
    await this.close();
    this.channel = this.#newChannel();
    const scope = this.#ctx.fork("mcp-stdio");
    this.#scope = scope;
    let child: ChildProcess;
    try {
      const env = childEnvironment(process.env, process.platform === "win32", this.#server.env);
      const resolved = resolveExecutionCommand(this.#argv, { cwd: this.#cwd, env });
      child = scope.spawn(resolved.argv[0]!, resolved.argv.slice(1), {
        cwd: resolved.cwd, env: resolved.env, stdio: ["pipe", "pipe", "pipe"],
        ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      await this.close();
      throw new McpTransportError(`${error instanceof Error ? error.name : "Error"}: spawn failed`);
    }
    this.#child = child;
    const channel = this.channel;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error: NodeJS.ErrnoException) => reject(new McpTransportError(`${error.code ?? error.name}: ${this.#argv[0]}`)));
    });
    child.stderr?.resume();
    child.stdin?.on("error", () => {});
    let pending: Buffer = Buffer.alloc(0);
    child.stdout?.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (let newline = pending.indexOf(10); newline !== -1; newline = pending.indexOf(10)) {
        const line = pending.subarray(0, newline).toString("utf8").trim();
        pending = pending.subarray(newline + 1);
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        channel.receive(message);
      }
      if (pending.length > MAX_LINE_BYTES) { channel.close(new McpTransportError("server output line too long")); void this.close(); }
    });
    child.stdout?.on("end", () => channel.close());
    child.once("exit", () => channel.close());
    try {
      await spawned;
    } catch (error) {
      channel.close(error as Error);
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const scope = this.#scope;
    this.#scope = null;
    this.#child?.stdin?.end();
    this.#child = null;
    this.channel.close(new McpTransportError("server process is not running"));
    if (scope) await scope.dispose().catch(() => {});
  }
}
