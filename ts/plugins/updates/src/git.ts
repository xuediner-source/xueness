/** Fast-forward source check. Callers must pass a checkout; this never guesses the Xueness tree. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const gitNull = process.platform === "win32" ? "nul" : "/dev/null";
const FILTER = /^filter\.[A-Za-z0-9._-]+\.(?:smudge|process)$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const SHA = /^[0-9a-fA-F]{40,64}$/;

function refuse(message: string): never {
  const error = new Error(message);
  error.name = "ValueError";
  throw error;
}

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = gitNull;
  env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10";
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return env;
}

function run(root: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("git", [...args], { cwd: root, env: environment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.length > 1_000_000 || stderr.length > 100_000) reject(Object.assign(new Error("git response exceeded safety limits"), { name: "ValueError" }));
      else resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function git(root: string, args: readonly string[], check = true): Promise<{ code: number; stdout: string; stderr: string }> {
  const filters = await run(root, ["config", "--local", "--name-only", "--get-regexp", String.raw`^filter\..*\.(smudge|process)$`], 10_000);
  if (filters.code !== 0 && filters.code !== 1) refuse("could not inspect local Git filters");
  const prefix = ["-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "remote.origin.uploadpack=git-upload-pack", "-c", "core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10"];
  for (const key of filters.stdout.split(/\r?\n/)) if (FILTER.test(key)) prefix.push("-c", `${key}=`);
  const result = await run(root, [...prefix, ...args], 45_000);
  if (check && result.code !== 0) refuse(`git command failed: ${(result.stderr.trim() || "unknown error").slice(0, 300)}`);
  return result;
}

export function safeOrigin(remote: string): boolean {
  if (remote.length > 2048 || /\s/.test(remote)) return false;
  if (remote.startsWith("https://") || remote.startsWith("ssh://")) {
    try {
      const url = new URL(remote);
      if ((url.protocol !== "https:" && url.protocol !== "ssh:") || !url.hostname || url.password || url.search || url.hash) return false;
      if (url.protocol === "https:" && url.username) return false;
      if (url.protocol === "ssh:" && url.username && url.username !== "git") return false;
      return true;
    } catch { return false; }
  }
  return /^(?:git@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}:[A-Za-z0-9._/-]{1,1000}$/.test(remote);
}

async function configured(root: string): Promise<string> {
  const top = resolve((await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (top !== resolve(root)) refuse("update must run from the Xueness source checkout root");
  const remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
  if (!remote || !safeOrigin(remote)) refuse("origin must be a configured HTTPS or SSH Git remote");
  const branch = (await git(root, ["branch", "--show-current"])).stdout.trim();
  if (!BRANCH.test(branch)) refuse("current branch is not configured for updates");
  const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], false);
  if (upstream.code !== 0 || upstream.stdout.trim() !== `origin/${branch}`) refuse("current branch must track its origin branch");
  return branch;
}

export async function check(root: string): Promise<Record<string, unknown>> {
  const branch = await configured(root);
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const remote = (await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).stdout.trim();
  const remoteHead = remote ? remote.split(/\s+/)[0] : null;
  if (remoteHead && !SHA.test(remoteHead)) refuse("origin returned an invalid revision");
  const clean = !(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
  return { branch, current: head, origin: remoteHead, originDiffers: Boolean(remoteHead && remoteHead !== head), clean, relation: remoteHead === head ? "same" : "unknown" };
}

export async function apply(root: string): Promise<Record<string, unknown>> {
  const branch = await configured(root);
  if ((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim()) refuse("source checkout has local changes; update refused");
  if ((await git(root, ["ls-files", "--stage"])).stdout.split(/\r?\n/).some((line) => line.startsWith("160000 "))) refuse("source checkout with submodules is not supported");
  await git(root, ["fetch", "--no-tags", "--recurse-submodules=no", "origin", branch]);
  const remoteRef = `refs/remotes/origin/${branch}`;
  const ancestor = await git(root, ["merge-base", "--is-ancestor", "HEAD", remoteRef], false);
  if (ancestor.code === 1) refuse("origin is not a fast-forward; update refused");
  if (ancestor.code !== 0) refuse("could not verify the origin fast-forward");
  const old = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await git(root, ["merge", "--ff-only", remoteRef]);
  const current = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  return { updated: old !== current, previous: old, current, message: old !== current ? "source updated; restart Xueness to load the new version" : "already current" };
}
