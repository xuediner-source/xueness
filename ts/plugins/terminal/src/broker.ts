/**
 * Terminal broker: one bounded, polled terminal per open.
 *
 * A real pseudo-terminal (`@xueness/engine-tools`' `spawnPty`, backed by
 * `@lydell/node-pty`'s prebuilt ConPTY/`pty.node`) when the platform has one,
 * so an interactive program sees a TTY: line editing, colour, `isatty`, and
 * `resize` that actually reaches the program. A platform without a prebuilt
 * binary falls back to plain pipes, which still runs commands but gives the
 * child no terminal.
 *
 * The HTTP surface only polls: output is kept in a bounded buffer addressed by
 * an absolute cursor, so a reconnecting client resumes where it stopped.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isPyIntValue } from "@xueness/contracts";
import { spawnPty, type PtyProcess } from "@xueness/engine-tools";

const CAP = 1_000_000;
const READ = 65_536;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function refuse(message: string): never {
  const error = new Error(message);
  error.name = "ValueError";
  throw error;
}

/** The bounded output buffer both backends feed. */
class OutputBuffer {
  private buffer = Buffer.alloc(0);
  private offset = 0;

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > CAP) {
      const excess = this.buffer.length - CAP;
      this.buffer = this.buffer.subarray(excess);
      this.offset += excess;
    }
  }

  /** Up to `READ` bytes from `cursor`, plus where the next read resumes. */
  read(cursor: number): { data: Buffer; cursor: number; truncated: boolean } {
    const start = Math.min(Math.max(cursor - this.offset, 0), this.buffer.length);
    const data = this.buffer.subarray(start, start + READ);
    return { data, cursor: this.offset + start + data.length, truncated: cursor < this.offset };
  }
}

export class Terminal {
  readonly id = randomBytes(16).toString("hex");
  readonly sessionId: string;
  readonly shell: string;
  /** `pty` when the platform's prebuilt binary loaded; `pipe` is the fallback. */
  readonly kind: "pty" | "pipe";
  closed = false;
  touched = performance.now();
  private readonly output = new OutputBuffer();
  private readonly pty: PtyProcess | null;
  private readonly child: ChildProcess | null;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;

  constructor(root: string, sessionId: string, shell: string) {
    this.sessionId = sessionId;
    this.shell = shell;
    const pty = shell ? spawnPty({ file: shell, cwd: root, cols: this.cols, rows: this.rows }) : null;
    if (pty) {
      this.kind = "pty";
      this.pty = pty;
      this.child = null;
      pty.onData((data) => this.output.push(data));
      pty.onExit(() => { this.closed = true; });
      return;
    }
    this.kind = "pipe";
    this.pty = null;
    this.child = spawn(shell, [], { cwd: root, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk: Buffer) => this.output.push(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.output.push(chunk));
    this.child.on("exit", () => { this.closed = true; });
    this.child.on("error", () => { this.closed = true; });
  }

  /** Bytes the terminal produced since `cursor`, base64 for the wire. */
  read(cursor: number): Record<string, unknown> {
    this.touched = performance.now();
    const chunk = this.output.read(cursor);
    return { id: this.id, session_id: this.sessionId, kind: this.kind, data: chunk.data.toString("base64"),
      cursor: chunk.cursor, truncated: chunk.truncated, closed: this.closed };
  }

  write(text: unknown): void {
    if (typeof text !== "string" || Buffer.byteLength(text) > READ) refuse("terminal input too large");
    if (this.closed) refuse("terminal is closed");
    this.touched = performance.now();
    // A PTY takes keystrokes, not lines: the client sends what the user typed,
    // and the shell's own line discipline decides when it is complete.
    if (this.pty) this.pty.write(text);
    else this.child?.stdin?.write(text);
  }

  resize(cols: unknown, rows: unknown): void {
    if (!isPyIntValue(cols) || typeof cols !== "number" || !isPyIntValue(rows) || typeof rows !== "number" || cols < 10 || cols > 500 || rows < 2 || rows > 200) refuse("invalid terminal dimensions");
    this.touched = performance.now();
    this.cols = cols;
    this.rows = rows;
    // A pipe has no window to resize; the dimensions are still recorded so the
    // surface answers the same way for both backends.
    if (this.pty) this.pty.resize(cols, rows);
  }

  close(): void {
    if (this.closed && (this.pty !== null || this.child?.exitCode !== null)) return;
    this.closed = true;
    if (this.pty) {
      this.pty.kill();
      return;
    }
    const pid = this.child?.pid;
    if (process.platform === "win32" && pid) spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    else try { this.child?.kill(); } catch { /* already gone */ }
  }
}

export class Broker {
  private readonly items = new Map<string, Terminal>();

  openCount(): number {
    return [...this.items.values()].filter((item) => !item.closed).length;
  }

  open(root: string, sessionId: string, shell?: unknown): Terminal {
    const now = performance.now();
    for (const [id, term] of this.items) {
      if (term.closed || now - term.touched > 1_800_000) { term.close(); this.items.delete(id); }
    }
    if (this.items.size >= 4) refuse("at most four terminals may be open");
    const term = new Terminal(root, sessionId, typeof shell === "string" ? shell : "");
    this.items.set(term.id, term);
    return term;
  }

  get(id: string): Terminal | undefined { return this.items.get(id); }
  list(): Terminal[] { return [...this.items.values()]; }
  close(): void { for (const term of this.items.values()) term.close(); this.items.clear(); }
}
