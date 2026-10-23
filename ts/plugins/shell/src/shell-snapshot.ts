import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback, type ExecFileOptionsWithStringEncoding } from "node:child_process";

const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFileCallback);

export interface ShellInitSnapshotRequest {
  rootDir: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
}

export interface ShellInitSnapshot {
  path: string;
  shellPath: string;
}

export class ShellInitSnapshotManager {
  private readonly managerId = randomBytes(8).toString("hex");
  private readonly cache = new Map<string, Promise<ShellInitSnapshot>>();
  private readonly files = new Set<string>();
  private readonly directories = new Set<string>();

  getOrCreate(request: ShellInitSnapshotRequest): Promise<ShellInitSnapshot> {
    const home = request.env.HOME || request.env.USERPROFILE || "";
    const rcPath = join(home, ".bashrc");
    const pending = this.signature(request.executable, home, rcPath).then((signature) => {
      const cached = this.cache.get(signature.key);
      if (cached) return cached;
      const creation = this.create(request, rcPath, signature.fileKey);
      this.cache.set(signature.key, creation);
      return creation;
    });
    return pending;
  }

  async cleanup(): Promise<void> {
    for (const path of this.files) {
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.files.clear();
    for (const path of this.directories) {
      try { await rmdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    }
    this.directories.clear();
  }

  private async signature(executable: string, home: string, rcPath: string): Promise<{ key: string; fileKey: string }> {
    let rcStat: { mtimeMs: number; size: number } | undefined;
    try {
      const info = await stat(rcPath);
      if (info.isFile()) rcStat = { mtimeMs: info.mtimeMs, size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = JSON.stringify([executable, home, rcPath, rcStat?.mtimeMs ?? null, rcStat?.size ?? null]);
    return { key, fileKey: createHash("sha256").update(key).digest("hex").slice(0, 20) };
  }

  private async create(request: ShellInitSnapshotRequest, rcPath: string, fileKey: string): Promise<ShellInitSnapshot> {
    const directory = join(request.rootDir, "shell", `snapshots-${this.managerId}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.directories.add(directory);
    const snapshotPath = join(directory, `${fileKey}.sh`);
    this.files.add(snapshotPath);
    const shellPath = process.platform === "win32" ? windowsPathToBashPath(snapshotPath) : snapshotPath;
    const rcShellPath = process.platform === "win32" ? windowsPathToBashPath(rcPath) : rcPath;
    const script = buildSnapshotScript({ snapshotPath: shellPath, rcPath: rcShellPath, rcExists: existsSync(rcPath) });
    const options: ExecFileOptionsWithStringEncoding = {
      encoding: "utf8", env: request.env, cwd: request.cwd, ...(request.signal ? { signal: request.signal } : {}),
      maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES, timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true,
    };
    try {
      await execFileAsync(request.executable, ["--noprofile", "--norc", "-c", script], options);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(request.signal?.aborted ? "command cancelled while capturing bash initialization" : `could not capture bash initialization: ${message}`) as Error & { code: string };
      error.code = request.signal?.aborted ? "command_cancelled" : "shell_init_failed";
      throw error;
    }
    const info = await stat(snapshotPath);
    if (!info.isFile()) throw Object.assign(new Error("bash initialization snapshot was not created"), { code: "shell_init_failed" });
    return { path: snapshotPath, shellPath };
  }
}

export function buildSnapshotScript(input: { snapshotPath: string; rcPath: string; rcExists: boolean }): string {
  return [
    `SNAPSHOT_FILE=${bashQuote(input.snapshotPath)}`,
    input.rcExists ? `source ${bashQuote(input.rcPath)} < /dev/null\nsource_status=$?\nif (( source_status != 0 )); then exit "$source_status"; fi` : ":",
    "{",
    "  printf '%s\\n' '# Snapshot created by Xueness' 'unalias -a 2>/dev/null || true'",
    "  declare -f",
    "  shopt -p",
    "  set +o",
    "  printf '%s\\n' 'shopt -s expand_aliases'",
    "  alias -p | grep -v \"='winpty \" || true",
    "  printf 'export PATH=%q\\n' \"$PATH\"",
    `} > "$SNAPSHOT_FILE"`,
    "chmod 600 \"$SNAPSHOT_FILE\" 2>/dev/null || true",
    "test -f \"$SNAPSHOT_FILE\"",
  ].join("\n");
}

export function windowsPathToBashPath(path: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(path)) return path.replaceAll("\\", "/");
  const drive = path.slice(0, 1).toLowerCase();
  return `/${drive}${path.slice(2).replaceAll("\\", "/")}`;
}

export function bashQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

