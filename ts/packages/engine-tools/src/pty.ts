/**
 * Pseudo-terminals for the terminal plugin.
 *
 * `@lydell/node-pty` ships prebuilt binaries — `conpty.node` with ConPTY's
 * `OpenConsole.exe` on Windows, `pty.node` on POSIX — so nothing is compiled
 * at install time. It is loaded lazily: a platform without a prebuild keeps
 * the plain-pipe fallback instead of failing the import, and a broken install
 * is a missing backend rather than a crash.
 *
 * Live terminals are killed when this host exits, the same guarantee
 * `process.ts` gives its children. On Windows the host job object covers a
 * host that dies without reaching its exit hook; POSIX has no equivalent, so
 * the hook is what stops a shell outliving the server.
 */
import { createRequire } from "node:module";

/** The subset of node-pty's `IPty` this runtime uses. */
interface NodePty {
  pid: number;
  onData(listener: (data: string | Buffer) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePtyModule {
  spawn(file: string, args: string[], options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
    encoding?: string | null;
  }): NodePty;
}

export interface PtySpawnOptions {
  file: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

/** A running pseudo-terminal, independent of the backend that provides it. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: Buffer) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

let cached: NodePtyModule | null | undefined;
const live = new Set<PtyProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const terminal of live) {
      try {
        terminal.kill();
      } catch {
        // already gone
      }
    }
  });
}

/**
 * The node-pty backend, or null when this platform has no prebuilt binary or
 * the module cannot be loaded. Never throws: the caller falls back to a pipe.
 */
export function nodePty(): NodePtyModule | null {
  if (cached !== undefined) return cached;
  try {
    const load = createRequire(import.meta.url);
    const loaded = load("@lydell/node-pty") as Partial<NodePtyModule> | null;
    cached = loaded && typeof loaded.spawn === "function" ? loaded as NodePtyModule : null;
  } catch {
    cached = null;
  }
  return cached;
}

function environment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === "string") env[key] = value;
  return env;
}

/** Spawn `file` on a pseudo-terminal; null when the platform has no backend. */
export function spawnPty(options: PtySpawnOptions): PtyProcess | null {
  const backend = nodePty();
  if (!backend) return null;
  const child = backend.spawn(options.file, [], {
    // A real TERM: programs ask for 256-colour capabilities and size their
    // output to the terminal window, which is what `resize` then changes.
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: environment(options.env ?? process.env),
    // Raw bytes: the HTTP surface hands the client base64 chunks, not text.
    encoding: null,
  });
  const terminal: PtyProcess = {
    pid: child.pid,
    onData: (listener) => child.onData((data) => listener(typeof data === "string" ? Buffer.from(data, "utf8") : data)),
    onExit: (listener) => child.onExit((event) => {
      live.delete(terminal);
      listener(event.exitCode);
    }),
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: () => {
      live.delete(terminal);
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
  installExitHook();
  live.add(terminal);
  return terminal;
}

/** Terminals still running under this host; for tests and diagnostics. */
export function livePtys(): number {
  return live.size;
}
