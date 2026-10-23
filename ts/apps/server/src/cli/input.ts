/**
 * Chat input helpers (`sessions/cli_input.py` `multiline` and
 * `capture_clipboard_image`): bounded multi-line entry and an explicit
 * clipboard PNG snapshot taken through the platform's own tool.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { platform } from "node:os";
import { pyLen } from "@xueness/contracts";
import { snapshot } from "@xueness/plugin-sessions";
import type { Attachment } from "@xueness/sessions";

const MAX_PROMPT_CHARS = 5000, MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MACOS_SCRIPT = "on run argv\n    set outputFile to POSIX file (item 1 of argv)\n    set clipboardData to the clipboard as «class PNGf»\n    set fileRef to open for access outputFile with write permission\n    try\n        set eof fileRef to 0\n        write clipboardData to fileRef\n        close access fileRef\n    on error\n        try\n            close access fileRef\n        end try\n        error number -128\n    end try\nend run";

/** `multiline(prompt)`: lines until `/end`; null when cancelled; over 5000 characters is refused whole. */
export async function multiline(prompt: (label: string) => Promise<string | null>): Promise<string | null | undefined> {
  const lines: string[] = [];
  let size = 0, overflow = false;
  for (;;) {
    let line = await prompt("… ");
    if (line === null) return undefined;
    if (line === "/cancel") return null;
    if (line === "/end") { if (overflow) throw new Error("多行输入超过 5000 字符，整段未提交"); return lines.join("\n"); }
    if (line === "\\/end" || line === "\\/cancel") line = line.slice(1);
    size += pyLen(line) + (lines.length ? 1 : 0);
    if (size > MAX_PROMPT_CHARS) overflow = true;
    if (!overflow) lines.push(line);
  }
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try { if (statSync(join(dir, name)).isFile()) return join(dir, name); } catch { /* not here */ }
  }
  return null;
}

/** Run one capture command with secrets stripped from its environment; stdout bounded to 2 MiB. */
function capture(command: string, argv: string[], cwd: string, target: string | null): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)));
  return new Promise((done, fail) => {
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", target ? "ignore" : "pipe", "ignore"], detached: process.platform !== "win32" });
    const chunks: Buffer[] = []; let total = 0;
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } fail(new Error("clipboard image capture timed out")); }, 8000);
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_MEDIA_FILE_BYTES) { child.kill("SIGKILL"); clearTimeout(timer); fail(new Error("clipboard PNG exceeds 2 MiB")); return; }
      chunks.push(chunk);
    });
    child.on("error", () => { clearTimeout(timer); fail(new Error("clipboard image capture command failed")); });
    child.on("close", (code) => { clearTimeout(timer); if (code) fail(new Error("clipboard does not contain a PNG image")); else done(Buffer.concat(chunks)); });
  });
}

/** `capture_clipboard_image(root)`: a PNG snapshot named `clipboard-image.png`. */
export async function captureClipboardImage(root: string): Promise<Attachment> {
  try { if (!statSync(root).isDirectory()) throw new Error(); } catch { throw new Error("clipboard capture requires an existing workspace"); }
  const directory = mkdtempSync(join(root, ".xueness-clipboard-"));
  try {
    const target = join(directory, "clipboard.png");
    const system = platform();
    if (system === "darwin") {
      const osascript = which("osascript");
      if (!osascript) throw new Error("macOS clipboard image capture is unavailable");
      closeSync(openSync(target, "wx", 0o600));
      await capture(osascript, ["-e", MACOS_SCRIPT, target], root, target);
    } else if (system === "linux") {
      const wl = which("wl-paste"), xclip = which("xclip");
      if (!wl && !xclip) throw new Error("Linux PNG clipboard capture needs wl-paste or xclip");
      const data = await capture(wl ?? xclip!, wl ? ["--no-newline", "--type", "image/png"] : ["-selection", "clipboard", "-t", "image/png", "-o"], root, null);
      writeFileSync(target, data, { mode: 0o600 });
    } else throw new Error("image clipboard capture is unsupported on this platform");
    let size = 0;
    try { size = statSync(target).size; } catch { size = 0; }
    if (!(size > 0 && size <= MAX_MEDIA_FILE_BYTES)) throw new Error("clipboard PNG is empty or exceeds 2 MiB");
    const head = Buffer.alloc(8), fd = openSync(target, "r");
    try { readSync(fd, head, 0, 8, 0); } finally { closeSync(fd); }
    if (!head.equals(PNG)) throw new Error("clipboard image is not a valid PNG");
    const item = await snapshot(root, relative(root, target).split("\\").join("/"));
    return { ...item, path: "clipboard-image.png" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** `input(label)`: one visible line; EOF and Ctrl+C cancel (`EOFError`/`KeyboardInterrupt`). */
export async function visiblePrompt(label: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  try {
    return await new Promise<string>((done, fail) => {
      rl.on("close", () => fail(new Error("")));
      rl.on("SIGINT", () => fail(new Error("")));
      rl.question(label, done);
    });
  } finally { rl.close(); }
}

/** `getpass.getpass(label)`: a line read with echo off; Ctrl+C or Ctrl+D cancels. */
export async function hiddenPrompt(label: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(label);
  if (!stdin.isTTY) throw new Error("");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((done, fail) => {
    let value = "";
    const finish = (): void => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stderr.write("\n"); };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") { finish(); done(value); return; }
        if (ch === "\u0003" || ch === "\u0004") { finish(); fail(new Error("")); return; }
        if (ch === "\u007f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
