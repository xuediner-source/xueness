/**
 * Scoped OS resources: child processes, listening servers, outgoing requests
 * and emitter subscriptions. Each one is checked against the context's guard
 * and released when the context's scope ends, so a stopped plugin leaves no
 * process, socket, timer or listener behind.
 *
 * Processes run in their own process group on POSIX. Stopping sends SIGTERM
 * to the group, then SIGKILL after the grace period, and finally SIGKILL to
 * whatever is left of the group (background grandchildren). Windows trees are
 * ended with `taskkill /T /F`.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { AddressInfo, Server, Socket } from "node:net";
import type { Context } from "./context.ts";
import { ScopeInactiveError } from "./scope.ts";

export interface ScopedSpawnOptions extends Omit<SpawnOptions, "detached"> {
  /** How long SIGTERM gets before SIGKILL when the scope ends (default 2000 ms). */
  killGraceMs?: number;
}

const POSIX = process.platform !== "win32";

/** Resolves true when `promise` settles within `ms`, false otherwise; leaves no timer behind. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (!POSIX) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is already gone
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function spawnScoped(ctx: Context, file: string, args: readonly string[], options: ScopedSpawnOptions = {}): ChildProcess {
  const { killGraceMs = 2000, ...rest } = options;
  // A shell runs whatever the arguments say, so it needs permission for any program.
  if (rest.shell) ctx.guard.program("*");
  ctx.guard.program(file);
  if (!ctx.scope.active) throw new ScopeInactiveError(`cannot spawn: scope ${ctx.name} is ${ctx.scope.state}`);
  const child = spawn(file, [...args], { windowsHide: true, ...rest, detached: POSIX });
  let finished = false;
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => {
      if (child.pid === undefined) done();
    });
  });
  const running = (): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const release = ctx.scope.add(async () => {
    if (finished) return;
    if (running()) {
      signalTree(child, "SIGTERM");
      if (!(await within(exited, killGraceMs))) {
        signalTree(child, "SIGKILL");
        await within(exited, 2000);
      }
    }
    // Background grandchildren keep the group alive after the leader exits.
    if (POSIX && child.pid !== undefined && groupAlive(child.pid)) signalTree(child, "SIGKILL");
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  });
  // A process that ended on its own (output drained, nothing left in its group) needs no disposer.
  const done = (): void => {
    if (POSIX && child.pid !== undefined && groupAlive(child.pid)) return;
    finished = true;
    void release();
  };
  child.once("close", done);
  child.once("error", () => {
    if (child.pid === undefined) done();
  });
  return child;
}

export interface ServeOptions {
  host: string;
  port: number;
}

export async function serveScoped(ctx: Context, server: Server, options: ServeOptions): Promise<AddressInfo> {
  ctx.guard.listen(options.host);
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  try {
    await new Promise<void>((ready, fail) => {
      server.once("error", fail);
      server.listen(options.port, options.host, () => {
        server.off("error", fail);
        ready();
      });
    });
  } catch (error) {
    server.off("connection", track);
    throw error;
  }
  const close = async (): Promise<void> => {
    const closed = new Promise<void>((done) => server.close(() => done()));
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    await closed;
    server.off("connection", track);
  };
  if (!ctx.scope.active) {
    await close();
    throw new ScopeInactiveError(`scope ${ctx.name} ended while a server was starting`);
  }
  ctx.scope.add(close);
  return server.address() as AddressInfo;
}

/**
 * `fetch` checked against `net.connect`. Redirects are returned, not
 * followed, so every hop goes through the guard again. The request is
 * aborted when the scope ends.
 */
export async function fetchScoped(ctx: Context, input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`unsupported protocol ${url.protocol}`);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  ctx.guard.connect(url.hostname, port);
  const signal = init.signal ? AbortSignal.any([ctx.signal, init.signal]) : ctx.signal;
  return await fetch(url, { ...init, signal, redirect: init.redirect === "error" ? "error" : "manual" });
}

export interface Subscribable {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export function subscribeScoped(ctx: Context, emitter: Subscribable, event: string, listener: (...args: any[]) => void): () => void {
  const release = ctx.scope.add(() => void emitter.off(event, listener));
  emitter.on(event, listener);
  return () => void release();
}
