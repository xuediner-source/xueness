/**
 * Session Git writes (Python `git/actions.action` + `dispatch` for the
 * `init|stage|unstage|commit|branch|stash` verbs). No shell, remote verbs or
 * force flags; every write needs `confirmed: true` and holds the session lease.
 */
import { relative, isAbsolute } from "node:path";
import { isDict, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, realish, type SessionStore } from "@xueness/sessions";
import { GitError, gitCommand, type Row } from "./actions.ts";

export const WRITE_VERBS = new Set(["init", "stage", "unstage", "commit", "branch", "stash"]);
export const GIT_WRITE_ROUTES = [...WRITE_VERBS].map((verb) => `POST /api/sessions/:id/git/${verb}`);
export const ownsGitWrite = (p: readonly string[]): boolean => p.length === 5 && p[0] === "api" && p[1] === "sessions" && /^[0-9a-f]{32}$/.test(p[2] ?? "") && p[3] === "git" && WRITE_VERBS.has(p[4] ?? "");

function paths(root: string, values: unknown): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw new PyValueError("paths required");
  const base = realish(root);
  return values.map((name) => {
    if (typeof name !== "string" || !name || pyLen(name) > 1024 || name.startsWith("-")) throw new PyValueError("invalid path");
    const rel = relative(base, realish(base + "/" + name));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new PyValueError("invalid path");
    return name;
  });
}

export async function gitWrite(root: string, verb: string, data: Row): Promise<Row> {
  if (data.confirmed !== true) throw new PyValueError("review and confirm this Git operation");
  if (verb === "init") await gitCommand(root, ["init"]);
  else if (verb === "stage") await gitCommand(root, ["add", "--", ...paths(root, data.paths)]);
  else if (verb === "unstage") await gitCommand(root, ["restore", "--staged", "--", ...paths(root, data.paths)]);
  else if (verb === "commit") {
    const text = data.message ?? "";
    if (typeof text !== "string" || !pyStrip(text) || pyLen(text) > 5000) throw new PyValueError("commit message required");
    await gitCommand(root, ["-c", "core.hooksPath=/dev/null", "commit", "-m", text]);
  } else if (verb === "branch") {
    const name = data.name;
    if (typeof name !== "string" || pyLen(name) > 200 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(name) || name.includes("..") || name.includes("@{")) throw new PyValueError("invalid branch name");
    await gitCommand(root, ["check-ref-format", "--branch", name]);
    await gitCommand(root, ["switch", ...(data.create === true ? ["-c"] : []), name]);
  } else if (verb === "stash") await gitCommand(root, ["stash", "push", "-m", "Xueness local stash"]);
  else throw new PyValueError("unknown Git operation");
  return { ok: true };
}

export async function dispatchGitWrite(store: SessionStore, method: string, p: readonly string[], data: unknown): Promise<[number, unknown]> {
  let lease: Awaited<ReturnType<SessionStore["lease"]>> | undefined;
  try {
    const session = await store.load(p[2]!), root = String(session.root);
    if (method.toUpperCase() !== "POST") return [405, { error: "method not allowed" }];
    lease = await store.lease(p[2]!);
    return [200, await gitWrite(root, p[4]!, isDict(data) ? data : {})];
  } catch (e) {
    if (e instanceof GitError) return [e.status, { error: e.message }];
    if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "workspace session is in use" }];
    if (isPyOSError(e) || isPyValueError(e) || pyExceptionName(e) === "KeyError") return [400, { error: "invalid Git operation or missing session" }];
    throw e;
  } finally { await lease?.release(); }
}
