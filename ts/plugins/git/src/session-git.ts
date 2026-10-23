/**
 * Read-only session git panel (Python `git_api.dispatch`, `_git_diff`, `_git_log`).
 * `gitStatus` / `runGit` stay as branches.ts shipped them: `runGit` has no
 * `empty_repo_ok`, so log uses a local runner and leaves composer behavior alone.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { pyLen, pyStrip, pySubstring } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, type SessionStore } from "@xueness/sessions";
import { GitError } from "./actions.ts";
import { gitStatus, runGit } from "./branches.ts";

export const MAX_PATCH_CHARS = 200_000;
const VERBS = new Set(["status", "diff", "log"]);
const SID = /^[0-9a-f]{32}$/;

interface Completed { code: number | null; stdout: string; stderr: string }
type Outcome = Completed | { failure: "missing" | "timeout" | "error" };

/** `subprocess` text mode: `\r\n` and `\r` become `\n` before git_api reads stdout. */
function universal(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function spawnGit(root: string, argv: readonly string[], timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn("git", [...argv], { cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve({ failure: "error" }); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let errBytes = 0, done = false;
    const finish = (value: Outcome): void => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ failure: "timeout" }); }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => finish({ failure: error.code === "ENOENT" ? "missing" : "error" }));
    child.stdout!.on("data", (part: Buffer) => out.push(part));
    child.stderr!.on("data", (part: Buffer) => { if (errBytes < 4096) { err.push(part); errBytes += part.length; } });
    child.once("close", (code) => finish({ code, stdout: universal(Buffer.concat(out).toString("utf8")), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

async function workTree(root: string, timeoutMs: number): Promise<boolean | null> {
  const probe = await spawnGit(root, ["--no-optional-locks", "rev-parse", "--is-inside-work-tree"], Math.min(timeoutMs, 2000));
  if ("failure" in probe) return null;
  if (probe.code === 0) return pyStrip(probe.stdout) === "true";
  return probe.code === 128 ? false : null;
}

/** `_has_head`: exit 1 and empty stdout is an empty repository, not a probe failure. */
async function hasHead(root: string, timeoutMs: number): Promise<boolean | null> {
  const probe = await spawnGit(root, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD"], Math.min(timeoutMs, 2000));
  if ("failure" in probe) return null;
  const text = pyStrip(probe.stdout);
  if (probe.code === 0) return text.length > 0;
  if (probe.code === 1 && text === "") return false;
  return null;
}

/** `_run_git` with `empty_repo_ok`. A missing binary is 501; a foreign directory is 404. */
async function runReadOnly(root: string, argv: readonly string[], options: { timeoutMs?: number; allowed?: readonly number[]; emptyRepoOk?: boolean } = {}): Promise<Completed> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = await spawnGit(root, argv, timeoutMs);
  if ("failure" in result) throw new GitError(result.failure === "missing" ? 501 : 400, result.failure === "missing" ? "git 不可用：运行环境未安装 git" : "git 命令失败");
  if ((options.allowed ?? [0]).includes(result.code ?? -1)) return result;
  const tree = await workTree(root, timeoutMs);
  if (tree === false) throw new GitError(404, "该工作区不是 git 仓库");
  if (options.emptyRepoOk && result.code === 128 && tree === true && await hasHead(root, timeoutMs) === false) return result;
  console.error(`[git_api] git ${argv.join(" ")} rc=${result.code}: ${pySubstring(pyStrip(result.stderr), 0, 500)}`);
  throw new GitError(400, "git 命令失败");
}

export async function gitDiff(root: string, maxPatchChars = MAX_PATCH_CHARS): Promise<{ stat: string; patch: string; truncated: boolean }> {
  const stat = universal((await runGit(root, ["--no-optional-locks", "diff", "--stat"])).stdout);
  const full = universal((await runGit(root, ["--no-optional-locks", "diff", "-U3"])).stdout);
  const truncated = pyLen(full) > maxPatchChars;
  return { stat, patch: truncated ? pySubstring(full, 0, maxPatchChars) : full, truncated };
}

function stripNewlines(text: string): string {
  let start = 0, end = text.length;
  while (start < end && text.charCodeAt(start) === 10) start += 1;
  while (end > start && text.charCodeAt(end - 1) === 10) end -= 1;
  return text.slice(start, end);
}

/** `_git_log`: the last 20 commits. An empty repository is `commits: []`, not an error. */
export async function gitLog(root: string): Promise<{ commits: { hash: string; short: string; author: string; date: string; subject: string }[] }> {
  const proc = await runReadOnly(root, ["--no-optional-locks", "log", "-n", "20", "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"], { emptyRepoOk: true });
  const commits: { hash: string; short: string; author: string; date: string; subject: string }[] = [];
  for (const record of proc.stdout.split("\x1e")) {
    const fields = stripNewlines(record).split("\x1f");
    if (fields.length !== 5 || fields.some((field) => field === "")) continue;
    commits.push({ hash: fields[0]!, short: fields[1]!, author: fields[2]!, date: fields[3]!, subject: fields[4]! });
  }
  return { commits };
}

/** Owns only the three verbs with a 32-hex sid. A bad sid or unknown verb stays unowned. */
export function ownsSessionGit(parts: readonly string[]): boolean {
  return parts.length === 5 && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "git" && SID.test(parts[2] ?? "") && VERBS.has(parts[4] ?? "");
}

function isDir(root: unknown): root is string {
  if (typeof root !== "string" || !root) return false;
  try { return statSync(root).isDirectory(); } catch { return false; }
}

export async function dispatchSessionGit(store: SessionStore, method: string, parts: readonly string[]): Promise<[number, unknown]> {
  if (method !== "GET") return [405, { error: "method not allowed" }];
  const sid = parts[2]!;
  let session: Record<string, unknown>;
  try { session = await store.load(sid); }
  catch (error) {
    if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)) return [404, { error: "session not found" }];
    throw error;
  }
  const root = session.root;
  if (!isDir(root)) return [404, { error: "该工作区不是 git 仓库" }];
  try {
    const verb = parts[4];
    if (verb === "status") return [200, await gitStatus(root)];
    if (verb === "diff") return [200, await gitDiff(root)];
    return [200, await gitLog(root)];
  } catch (error) {
    if (error instanceof GitError) return [error.status, { error: error.message }];
    throw error;
  }
}
