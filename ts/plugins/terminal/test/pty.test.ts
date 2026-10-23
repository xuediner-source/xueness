/**
 * A real pseudo-terminal: the child sees a TTY (so line editing, colour and
 * `isatty` behave), `resize` reaches it, and the broker still bounds output.
 * `@lydell/node-pty` ships prebuilt binaries, so this runs without a compiler;
 * a platform without one keeps the pipe fallback and the tests skip.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { livePtys, nodePty, spawnPty } from "@xueness/engine-tools";
import { Broker } from "../src/index.ts";

const backend = nodePty();
const skip = backend ? false : "no prebuilt pseudo-terminal for this platform";
const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const sid = (letter: string): string => letter.repeat(32);

/**
 * Node reports the terminal itself, so the probe needs no localized command:
 * `isatty` is true only for a real PTY, and the columns/rows come from the
 * window the kernel holds for it.
 */
const PROBE = "process.stdout.write('PROBE ' + (process.stdout.isTTY ? 'tty' : 'notty') + ' ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n');";

function probeScript(): { path: string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "xueness-pty-probe-"));
  const path = join(directory, "probe.mjs");
  writeFileSync(path, PROBE);
  return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Read until `pattern` matches the decoded output, or the deadline passes. */
async function until(term: { read(cursor: number): Record<string, unknown> }, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let text = "";
  while (Date.now() < deadline) {
    const chunk = term.read(cursor);
    cursor = Number(chunk.cursor);
    text += Buffer.from(String(chunk.data), "base64").toString("utf8");
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return text;
}

describe("pseudo-terminal", { skip }, () => {
  it("runs the child on a TTY and reports its kind", async () => {
    const probe = probeScript();
    const broker = new Broker();
    try {
      const term = broker.open(process.cwd(), sid("s"), shell);
      try {
        assert.equal(term.kind, "pty", "the prebuilt binary loaded, so the terminal is a real PTY");
        // A pipe child would answer `notty`: this is the difference that matters.
        term.write(`node "${probe.path}"\r`);
        const text = await until(term, /PROBE (tty|notty) /);
        assert.match(text, /PROBE tty /, "the child sees a terminal, not a pipe");
        const listing = broker.list().map((item) => [item.sessionId, item.kind, item.closed]);
        assert.deepEqual(listing, [[sid("s"), "pty", false]]);
      } finally { term.close(); }
    } finally { broker.close(); probe.dispose(); }
  });

  it("delivers a resize to the program, which a pipe cannot", async () => {
    const probe = probeScript();
    const broker = new Broker();
    try {
      const term = broker.open(process.cwd(), sid("r"), shell);
      try {
        assert.equal(term.kind, "pty");
        term.resize(100, 40);
        // The probe prints the size the kernel reports for this terminal.
        term.write(`node "${probe.path}"\r`);
        const text = await until(term, /PROBE tty \d+x\d+/);
        assert.match(text, /PROBE tty 100x40/, "the resize reached the program's window");
      } finally { term.close(); }
    } finally { broker.close(); probe.dispose(); }
  });

  it("refuses an out-of-range size and a closed terminal", () => {
    const broker = new Broker();
    try {
      const term = broker.open(process.cwd(), sid("c"), shell);
      assert.throws(() => term.resize(5, 40), /invalid terminal dimensions/);
      assert.throws(() => term.resize(100, 400), /invalid terminal dimensions/);
      term.close();
      assert.throws(() => term.write("x"), /terminal is closed/);
      assert.equal(term.closed, true);
    } finally { broker.close(); }
  });

  it("kills the pty with the host and drops it from the live set", () => {
    const child = spawnPty({ file: shell, cwd: process.cwd(), cols: 80, rows: 24 });
    assert.ok(child, "a PTY is available on this platform");
    const before = livePtys();
    assert.ok(before >= 1);
    child!.kill();
    assert.equal(livePtys(), before - 1, "a killed terminal is no longer tracked");
  });
});
