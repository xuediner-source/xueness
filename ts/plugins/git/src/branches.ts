/**
 * Composer branch picker (Python `git_api._run_git`, `_git_status`,
 * `_git_branch_catalog` and `composer_api._switch_branch`): read-only probes
 * plus one hook-free `git switch`, with the Python status codes and messages.
 */
import { spawn } from "node:child_process";
import { pyStrip } from "@xueness/contracts";
import { pyCodeCompare } from "@xueness/sessions";
import { GitError } from "./actions.ts";

interface Completed { code: number | null; stdout: string }
type Outcome = Completed | { failure: "missing" | "timeout" | "error" };

function run(root: string, argv: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn("git", [...argv], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve({ failure: "error" }); return; }
    const chunks: Buffer[] = []; let done = false;
    const finish = (value: Outcome): void => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ failure: "timeout" }); }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => finish({ failure: error.code === "ENOENT" ? "missing" : "error" }));
    child.stdout!.on("data", (part: Buffer) => chunks.push(part));
    child.stderr!.resume();
    child.once("close", (code) => finish({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** `_is_git_work_tree`: `null` when the probe itself fails. */
async function workTree(root: string, timeoutMs: number): Promise<boolean | null> {
  const probe = await run(root, ["--no-optional-locks", "rev-parse", "--is-inside-work-tree"], Math.min(timeoutMs, 2000));
  if ("failure" in probe) return null;
  if (probe.code === 0) return pyStrip(probe.stdout) === "true";
  return probe.code === 128 ? false : null;
}

/** `_run_git`: a missing binary is 501, a foreign directory 404, anything else 400. */
export async function runGit(root: string, argv: readonly string[], options: { timeoutMs?: number; allowed?: readonly number[] } = {}): Promise<Completed> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = await run(root, argv, timeoutMs);
  if ("failure" in result) throw new GitError(result.failure === "missing" ? 501 : 400, result.failure === "missing" ? "git 不可用：运行环境未安装 git" : "git 命令失败");
  if (!(options.allowed ?? [0]).includes(result.code ?? -1)) {
    if (await workTree(root, timeoutMs) === false) throw new GitError(404, "该工作区不是 git 仓库");
    throw new GitError(400, "git 命令失败");
  }
  return result;
}

/** Python `os.devnull`. Node's `\\.\nul` makes Git for Windows fail the switch. */
const gitNull = process.platform === "win32" ? "nul" : "/dev/null";
const lines = (text: string): string[] => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).filter((line, index, all) => index < all.length - 1 || line !== "");

/** `_parse_branch`: the `## ` line of `status --porcelain=v1 -b`. */
function parseBranch(head: string): string {
  head = pyStrip(head);
  if (head.includes("HEAD (no branch)")) return "HEAD (detached)";
  if (head.startsWith("No commits yet on ")) return pyStrip(head.slice("No commits yet on ".length));
  const words = head.split("...", 1)[0]!.split(/\s+/u).filter(Boolean);
  return head.split(/\s+/u).filter(Boolean).length ? words[0] ?? "" : "";
}

export async function gitStatus(root: string): Promise<{ branch: string; entries: { code: string; path: string }[]; clean: boolean }> {
  const output = (await runGit(root, ["--no-optional-locks", "status", "--porcelain=v1", "-b"])).stdout;
  let branch = ""; const entries: { code: string; path: string }[] = [];
  lines(output).forEach((line, index) => {
    if (!line) return;
    if (index === 0 && line.startsWith("##")) { branch = parseBranch(line.slice(2)); return; }
    entries.push({ code: line.slice(0, 2), path: line.slice(3) });
  });
  return { branch, entries, clean: entries.length === 0 };
}

async function localBranches(root: string, timeoutMs?: number): Promise<string[]> {
  const output = (await runGit(root, ["--no-optional-locks", "for-each-ref", "--format=%(refname:short)", "refs/heads/"], timeoutMs === undefined ? {} : { timeoutMs })).stdout;
  return [...new Set(lines(output).map((line) => pyStrip(line)).filter(Boolean))].sort(pyCodeCompare);
}

/** `_git_branch_catalog`: branch metadata without scanning the working tree. */
export async function branchCatalog(root: string): Promise<{ branch: string; branches: string[] }> {
  const head = await runGit(root, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: 2000, allowed: [0, 1] });
  const branches = await localBranches(root, 2000);
  return { branch: head.code === 0 ? pyStrip(head.stdout) : "HEAD (detached)", branches };
}

/** `_switch_branch`: only an existing local branch, only from a clean tree, never running hooks. */
export async function switchBranch(root: string, branch: unknown): Promise<{ branch: string; branches: string[] }> {
  if (typeof branch !== "string" || !branch || [...branch].length > 200 || /[\x00-\x1f\x7f]/u.test(branch)) throw new GitError(400, "invalid branch selection");
  const status = await gitStatus(root);
  const branches = await localBranches(root);
  if (!branches.includes(branch)) throw new GitError(400, "branch is not available");
  if (status.entries.length) throw new GitError(409, "workspace has uncommitted changes; review them before switching branches");
  if (branch === status.branch) return { branch, branches };
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNull };
  const result = await run(root, ["-c", "core.hooksPath=" + gitNull, "switch", "--", branch], 10_000, env);
  if ("failure" in result || result.code !== 0) throw new GitError(409, "cannot switch branch; review repository state");
  return { branch: (await gitStatus(root)).branch, branches };
}
