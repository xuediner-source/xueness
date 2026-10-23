/** Host environment snapshot for the Environment and git-status sections (taken once per session, like ZCode). */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { release, type } from "node:os";
import type { EnvInfo } from "./env-sections.ts";

const MAX_STATUS_LINES = 40;
const git = (root: string, args: string[]): string | null => {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trimEnd(); } catch { return null; }
};
export function collectEnvInfo(root: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): EnvInfo {
  const shell = platform === "win32" ? "powershell" : basename(env.SHELL || "sh");
  const info: EnvInfo = { cwd: root, platform, shell, osVersion: `${type()} ${release()}` };
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { ...info, isGitRepository: false, gitStatus: "not_repo" };
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remoteHead = git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const main = remoteHead?.startsWith("origin/") ? remoteHead.slice(7) : ["main", "master"].find((name) => git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/" + name]) !== null);
  const user = git(root, ["config", "user.name"]);
  const status = git(root, ["status", "--short"]);
  const lines = status === null ? undefined : status.split("\n").filter(Boolean);
  const commits = git(root, ["log", "--oneline", "-n", "5"]);
  return {
    ...info, isGitRepository: true,
    ...(branch ? { gitBranch: branch } : {}), ...(main ? { gitMainBranch: main } : {}), ...(user ? { gitUser: user } : {}),
    gitStatus: lines === undefined ? "unknown" : lines.length ? "dirty" : "clean",
    gitStatusLines: lines && lines.length > MAX_STATUS_LINES ? [...lines.slice(0, MAX_STATUS_LINES), `... (${lines.length - MAX_STATUS_LINES} more)`] : lines ?? [],
    recentCommits: commits ? commits.split("\n").filter(Boolean) : [],
  };
}
const cache = new Map<string, EnvInfo>();
/** The git snapshot is "at the start of the conversation": computed once per session id and root. */
export function sessionEnvInfo(sessionId: string, root: string, collect: (root: string) => EnvInfo = collectEnvInfo): EnvInfo {
  const key = sessionId + "\0" + root;
  let info = cache.get(key);
  if (!info) {
    info = collect(root); cache.set(key, info);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
  }
  return info;
}
