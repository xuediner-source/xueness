/**
 * `POST /api/git/clone` (Python `clone.dispatch`). URL forms stay https / ssh / scp.
 * `options.urlTransport` is Python's `URL_TRANSPORT`: null in production, and it
 * rewrites only a remote that `validatedUrl` already accepted. Recent-workspace
 * registration is `options.rememberWorkspace` — this plugin does not import settings.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isDict, pyLen, pyStrip, pySubstring } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, realish } from "@xueness/sessions";

const CLONE_TIMEOUT_SECONDS = 300;
const MAX_URL_CHARS = 2048;
const MAX_DEST_CHARS = 4096;
const CLONE_KEYS = new Set(["url", "dest", "confirmed", "root"]);
const WINDOWS = process.platform === "win32";
const HOST = String.raw`[A-Za-z0-9](?:[A-Za-z0-9.-]{1,253}[A-Za-z0-9])?`;
const HTTPS_URL = new RegExp(String.raw`^https://${HOST}(?::[0-9]{1,5})?/[!-~]+`);
const SSH_URL = new RegExp(String.raw`^ssh://(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}@)?${HOST}(?::[0-9]{1,5})?/[!-~]*`);
const SCP_URL = new RegExp(String.raw`^(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]:[A-Za-z0-9._~/+][A-Za-z0-9._~/+-]*`);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}/;
const WINDOWS_FIRST = ["Users", "ProgramData", "PerfLogs"];

export interface CloneOptions {
  allowedRoots?(): readonly string[];
  rememberWorkspace?(destRoot: string): void | Promise<void>;
  /** Test-only. Production leaves this null, same as Python's module global. */
  urlTransport?: ((remote: string) => string) | null;
}

export class CloneError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "CloneError"; this.status = status; }
}

function full(pattern: RegExp, text: string): boolean {
  const match = pattern.exec(text);
  return match !== null && match.index === 0 && match[0].length === text.length;
}

const norm = (path: string): string => WINDOWS ? path.replaceAll("/", "\\").toLowerCase() : path;
const same = (a: string, b: string): boolean => norm(a) === norm(b);
const rstripSlash = (text: string): string => text.replace(/\/+$/u, "");

/** `PurePath` pieces with `.` collapsed and `..` kept, so the jail sees the same parts Python does. */
function pure(raw: string): { absolute: boolean; segments: string[]; name: string; parent: string } {
  if (!WINDOWS) {
    const root = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
    const segments = raw.slice(root.length).split("/").filter((part) => part && part !== ".");
    const parentSegs = segments.slice(0, -1);
    const parent = root ? (root + parentSegs.join("/") || root) : (parentSegs.join("/") || ".");
    return { absolute: raw.startsWith("/"), segments, name: segments.at(-1) ?? "", parent };
  }
  const text = raw.replaceAll("/", "\\");
  const unc = /^\\\\[^\\]+\\[^\\]+/u.exec(text)?.[0] ?? "";
  const drive = unc || (/^[A-Za-z]:/u.exec(text)?.[0] ?? "");
  const rest = text.slice(drive.length);
  const rooted = rest.startsWith("\\");
  const segments = rest.split("\\").filter((part) => part && part !== ".");
  const anchor = unc ? unc + "\\" : drive + (rooted ? "\\" : "");
  const parentSegs = segments.slice(0, -1);
  return { absolute: /^[A-Za-z]:\\/u.test(text) || /^\\\\[^\\]+\\[^\\]+/u.test(text), segments, name: segments.at(-1) ?? "", parent: anchor + parentSegs.join("\\") || anchor || "." };
}

function expandUser(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = homedir();
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return home + path.slice(1);
  return path;
}

function strict(path: string): string {
  return realpathSync.native(path);
}

/** `is_windows_first_level_system_dir`: drive-letter `C:\Users`, not a UNC share. */
function windowsFirstLevel(path: string): boolean {
  const drive = /^[A-Za-z]:\\/u.exec(path)?.[0];
  if (!drive) return false;
  const lowered = path.replaceAll("/", "\\").toLowerCase();
  return WINDOWS_FIRST.some((name) => lowered === (drive + name).toLowerCase());
}

function isMount(path: string): boolean {
  if (WINDOWS) return /^(?:[A-Za-z]:\\|[\\/]{2}[^\\/]+[\\/][^\\/]+\\?)$/u.test(path);
  const self = lstatSync(path);
  if (self.isSymbolicLink()) return false;
  const parent = lstatSync(realish(join(path, "..")));
  return self.dev !== parent.dev || self.ino === parent.ino;
}

/** `_is_broad_directory`: anchors, Windows first-level system dirs, POSIX two-part paths, mounts. */
function broad(path: string): boolean {
  try {
    const anchor = /^\\\\[^\\]+\\[^\\]+\\/u.exec(path)?.[0] ?? (/^[A-Za-z]:\\/u.exec(path)?.[0] ?? (path.startsWith("/") ? "/" : path));
    const anchors = [realish("/"), realish(homedir()), realish(tmpdir()), realish(anchor)];
    if (anchors.some((item) => same(item, path))) return true;
    if (WINDOWS) { if (windowsFirstLevel(path)) return true; }
    else if ((path === "/" ? 1 : path.split("/").filter(Boolean).length + (path.startsWith("/") ? 1 : 0)) <= 2) return true;
    return isMount(path);
  } catch { return true; }
}

function inside(child: string, root: string): boolean {
  const c = norm(child), r = norm(root);
  if (c === r) return true;
  const sep = WINDOWS ? "\\" : "/";
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

/** `allowed_roots`: canonical directories, dropping `/` and `/tmp`. A throwing callback grants nothing. */
function allowedRoots(options: CloneOptions): string[] {
  let values: readonly string[] = [];
  try { values = options.allowedRoots?.() ?? []; }
  catch (error) { if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error) || error instanceof Error) return []; }
  const roots: string[] = [];
  const blocked = [realish("/"), realish("/tmp")];
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    try {
      const root = strict(expandUser(value));
      if (!statSync(root).isDirectory() || blocked.some((item) => same(item, root)) || roots.some((item) => same(item, root))) continue;
      roots.push(root);
    } catch { /* missing or unreadable grants are skipped */ }
  }
  return roots;
}

/** `_is_link`: a symlink or junction. An entry that cannot be inspected fails closed. */
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

export function suggestedName(url: unknown): string {
  if (typeof url !== "string") return "";
  let value = rstripSlash(pyStrip(url));
  if (!value) return "";
  const scheme = value.indexOf("://");
  if (scheme >= 0) {
    const remainder = value.slice(scheme + 3);
    const slash = remainder.indexOf("/");
    value = slash >= 0 ? remainder.slice(slash + 1) : "";
  } else if ((value.split("/")[0] ?? "").includes(":")) value = value.slice(value.indexOf(":") + 1);
  let tail = value.slice(value.lastIndexOf("/") + 1);
  if (tail.endsWith(".git")) tail = tail.slice(0, -4);
  return full(SAFE_NAME, tail) ? tail : "";
}

export function validatedUrl(url: unknown): string {
  if (typeof url !== "string") throw new CloneError("仓库地址必须是文本");
  const value = pyStrip(url);
  if (!value || value !== url) throw new CloneError("仓库地址不能为空或含首尾空白");
  if (pyLen(value) > MAX_URL_CHARS) throw new CloneError("仓库地址过长");
  if (value.startsWith("-") || /[\0\r\n\t ]/u.test(value)) throw new CloneError("仓库地址含非法字符");
  const mark = value.indexOf("://");
  if (mark >= 0) {
    const scheme = value.slice(0, mark).toLowerCase();
    if (scheme === "https") {
      if (full(HTTPS_URL, value)) return value;
      throw new CloneError("https 地址不合法（不支持内嵌凭据、端口外的冒号或空白）");
    }
    if (scheme === "ssh" && full(SSH_URL, value)) return value;
    throw new CloneError(`不支持的仓库地址协议：${scheme}（仅支持 https 与 ssh）`);
  }
  if (full(SCP_URL, value)) return value;
  throw new CloneError("仓库地址需是 https://、ssh:// 或 user@host:path 形式的远程仓库");
}

function validatedDestination(dest: unknown, options: CloneOptions, root: unknown): string {
  if (typeof dest !== "string") throw new CloneError("目标目录必须是文本");
  const raw = pyStrip(dest);
  if (!raw || raw !== dest || pyLen(raw) > MAX_DEST_CHARS || dest.includes("\0")) throw new CloneError("目标目录不合法");
  if (raw.startsWith("-")) throw new CloneError("目标目录不能以 - 开头");
  const candidate = pure(expandUser(raw));
  if (!candidate.absolute) throw new CloneError("目标目录必须是绝对路径");
  if (candidate.segments.some((part) => part === "." || part === "..")) throw new CloneError("目标目录不能包含 . 或 ..");
  if (!full(SAFE_NAME, candidate.name) || candidate.name === ".git") throw new CloneError("目标目录需要一个合法的项目名");
  let parent: string;
  try { parent = strict(candidate.parent); } catch { throw new CloneError("目标目录的上级目录不存在"); }
  let parentStat: ReturnType<typeof statSync>;
  try { parentStat = statSync(parent); } catch { throw new CloneError("目标目录的上级目录不存在"); }
  if (!parentStat.isDirectory()) throw new CloneError("目标目录的上级目录不是文件夹");
  if (broad(parent)) throw new CloneError("请选择一个项目文件夹作为上级目录，而不是系统根目录");
  try { accessSync(parent, constants.W_OK | constants.X_OK); } catch { throw new CloneError("目标目录不可写"); }
  if (root != null) {
    if (typeof root !== "string" || !(pyLen(root) > 0 && pyLen(root) <= MAX_DEST_CHARS)) throw new CloneError("root 不合法");
    let pinned: string;
    try { pinned = strict(expandUser(root)); } catch { throw new CloneError("root 目录不存在"); }
    if (!same(pinned, parent)) throw new CloneError("--root 与克隆目标的上级目录不一致", 403);
  }
  if (!allowedRoots(options).some((base) => inside(parent, base))) throw new CloneError("目标目录不在已授权的工作区内", 403);
  const target = join(parent, candidate.name);
  if (isLink(target)) throw new CloneError("目标目录是链接或重解析点，已拒绝");
  let info: ReturnType<typeof statSync> | null = null;
  try { info = statSync(target); } catch { info = null; }
  if (info) {
    if (!info.isDirectory()) throw new CloneError("目标路径已存在同名文件", 409);
    try { if (readdirSync(target).length) throw new CloneError("目标目录已存在且不为空", 409); }
    catch (error) { if (error instanceof CloneError) throw error; throw new CloneError("目标目录不可读", 409); }
  }
  return target;
}

function runClone(parent: string, argv: readonly string[], timeoutSeconds: number): Promise<{ code: number | null; stderr: string } | "missing" | "timeout" | "error"> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_PAGER: "cat", LC_ALL: "C" };
    if (!Object.hasOwn(process.env, "GIT_SSH_COMMAND")) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    try { child = spawn(argv[0]!, argv.slice(1), { cwd: parent, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve("error"); return; }
    const err: Buffer[] = [];
    let errBytes = 0, done = false;
    const finish = (value: { code: number | null; stderr: string } | "missing" | "timeout" | "error"): void => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish("timeout"); }, timeoutSeconds * 1000);
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "missing" : "error"));
    child.stdout!.resume();
    child.stderr!.on("data", (part: Buffer) => { if (errBytes < 4096) { err.push(part); errBytes += part.length; } });
    child.once("close", (code) => finish({ code, stderr: Buffer.concat(err).toString("utf8") }));
  });
}

export async function cloneRepository(url: unknown, dest: unknown, options: CloneOptions, confirmed: unknown, root: unknown, timeoutSeconds = CLONE_TIMEOUT_SECONDS): Promise<{ cloned: string; root: string; url: string }> {
  if (confirmed !== true) throw new CloneError("请确认后再克隆仓库");
  const remote = validatedUrl(url);
  const target = validatedDestination(dest, options, root);
  const transport = options.urlTransport ?? null;
  const result = await runClone(join(target, ".."), ["git", "-c", "protocol.ext.allow=never", "clone", "--", transport ? transport(remote) : remote, target], timeoutSeconds);
  if (result === "missing") throw new CloneError("git 不可用：运行环境未安装 git", 501);
  if (result === "timeout") throw new CloneError(`克隆超时（超过 ${timeoutSeconds} 秒）`, 409);
  if (result === "error") throw new CloneError("克隆未能启动", 400);
  if (result.code !== 0) {
    console.error(`[git.clone] git clone rc=${result.code}: ${pySubstring(pyStrip(result.stderr), 0, 500)}`);
    throw new CloneError("克隆失败：无法访问该仓库或仓库内容无法检出", 409);
  }
  let wrote = false;
  try { wrote = statSync(target).isDirectory(); } catch { wrote = false; }
  if (!wrote) throw new CloneError("克隆未能写入目标目录", 409);
  try { await options.rememberWorkspace?.(target); }
  catch { console.error(`[git.clone] cannot register ${target} as a recent workspace`); }
  return { cloned: target, root: target, url: remote };
}

export function ownsClone(parts: readonly string[]): boolean {
  return parts.length === 3 && parts[0] === "api" && parts[1] === "git" && parts[2] === "clone";
}

export async function dispatchClone(options: CloneOptions, method: string, data: unknown): Promise<[number, unknown]> {
  if (method !== "POST") return [405, { error: "method not allowed" }];
  if (!isDict(data) || Object.keys(data).some((key) => !CLONE_KEYS.has(key)) || !Object.hasOwn(data, "confirmed")) return [400, { error: "expected url, dest and confirmed" }];
  const root = Object.hasOwn(data, "root") ? data.root : null;
  if (root !== null && (typeof root !== "string" || !(pyLen(root) > 0 && pyLen(root) <= MAX_DEST_CHARS))) return [400, { error: "invalid root" }];
  try { return [200, await cloneRepository(data.url, data.dest, options, data.confirmed, root)]; }
  catch (error) {
    if (error instanceof CloneError) return [error.status, { error: error.message }];
    if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)) return [400, { error: "cannot clone repository" }];
    throw error;
  }
}
