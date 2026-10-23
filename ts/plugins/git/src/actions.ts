/** Local Git snapshots use a temporary index; restoration is scoped to the workspace. */
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyDecodeUtf8, pyEncodeUtf8, pyLen, pyStrip, PyValueError, uuid4Hex } from "@xueness/contracts";
export type Row = Record<string, any>;
export class GitError extends PyValueError { override name = "GitApiError"; readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export async function gitCommand(root: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string, raw = false): Promise<string> {
  const bytes = input === undefined ? undefined : pyEncodeUtf8(input);
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let length = 0, done = false;
    const finish = (error?: Error, bytes?: Buffer) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(bytes!); };
    const timer = setTimeout(() => { child.kill(); finish(new GitError(400, "Git operation failed")); }, 15_000);
    child.on("error", () => finish(new GitError(400, "Git operation failed")));
    child.stdout.on("data", (b: Buffer) => { length += b.length; if (length > 16 * 1024 * 1024) { child.kill(); finish(new GitError(400, "Git operation failed")); } else chunks.push(b); });
    child.stderr.resume(); child.stdin.on("error", () => {});
    child.once("close", (code) => finish(code !== 0 ? new GitError(409, "Git operation failed; review repository state") : undefined, Buffer.concat(chunks)));
    child.stdin.end(bytes);
  });
  let text: string; try { text = pyDecodeUtf8(output); } catch { throw new GitError(400, "Git output is not valid UTF-8"); }
  return raw ? text : pyStrip(text);
}
export async function repository(root: unknown): Promise<boolean> { if (typeof root !== "string" || !root) return false; try { await gitCommand(root, ["rev-parse", "--is-inside-work-tree"]); return true; } catch { return false; } }
export async function listCheckpoints(root: string): Promise<Row[]> {
  const raw = await gitCommand(root, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(contents:subject)", "refs/xueness/checkpoints/"]);
  return raw.split(/\r?\n/).map((line) => { const i = line.indexOf("\t"), j = line.indexOf("\t", i + 1); return i < 0 || j < 0 ? null : { id: line.slice(0, i).split("/").at(-1), hash: line.slice(i + 1, j), message: line.slice(j + 1) }; }).filter((r) => r !== null).slice(-100) as Row[];
}
export async function checkpoint(root: string, message = "Workspace checkpoint"): Promise<Row> {
  if (typeof message !== "string" || !pyStrip(message) || pyLen(message) > 500) throw new PyValueError("message required (max 500)");
  const head = await gitCommand(root, ["rev-parse", "HEAD"]), temporary = mkdtempSync(join(tmpdir(), "xueness-index-")), path = join(temporary, "index");
  const fd = openSync(path, "wx", 0o600); closeSync(fd); unlinkSync(path);
  const env = { GIT_INDEX_FILE: path, GIT_AUTHOR_NAME: "Xueness", GIT_AUTHOR_EMAIL: "local@xueness", GIT_COMMITTER_NAME: "Xueness", GIT_COMMITTER_EMAIL: "local@xueness" };
  try {
    await gitCommand(root, ["read-tree", head], env); await gitCommand(root, ["add", "--all", "--", "."], env);
    const tree = await gitCommand(root, ["write-tree"], env), hash = await gitCommand(root, ["commit-tree", tree, "-p", head], env, pyStrip(message) + "\n"), id = uuid4Hex();
    await gitCommand(root, ["update-ref", "refs/xueness/checkpoints/" + id, hash]); return { id, hash, message: pyStrip(message) };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
const paths = async (root: string, args: string[]) => new Set((await gitCommand(root, args, {}, undefined, true)).split("\0").filter(Boolean));
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b.replace(/\/+$/, "") + "/") || b.startsWith(a.replace(/\/+$/, "") + "/");
async function refuseIgnoredOverlap(root: string, head: string, target: string): Promise<void> {
  const affected = await paths(root, ["ls-tree", "-r", "--name-only", "-z", head, "--", "."]);
  for (const args of [["ls-tree", "-r", "--name-only", "-z", target, "--", "."], ["ls-files", "--cached", "-z", "--", "."]]) for (const p of await paths(root, args)) affected.add(p);
  const ignored = await paths(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "."]);
  for (const p of await paths(root, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z", "--", "."])) ignored.add(p);
  if ([...ignored].some((a) => [...affected].some((b) => overlaps(a, b)))) throw new GitError(409, "Ignored files overlap the checkpoint; move them before restoring");
}
export async function restoreCheckpoint(root: string, id: string): Promise<Row> {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new PyValueError("invalid checkpoint");
  const hash = await gitCommand(root, ["rev-parse", "refs/xueness/checkpoints/" + id + "^{commit}"]), head = await gitCommand(root, ["rev-parse", "HEAD"]);
  await refuseIgnoredOverlap(root, head, hash); const recovery = await checkpoint(root, "Recovery before restoring " + id.slice(0, 8));
  await refuseIgnoredOverlap(root, head, hash); await gitCommand(root, ["restore", "--source=" + hash, "--worktree", "--", "."]);
  return { restored: id, recovery };
}
