/** Git-owned checkpoint, session-panel and clone HTTP. The host retains request protection.
 * Disabled routes owned here share `{error, plugin, code:"plugin_disabled"}`.
 * Python `plugin_runtime` and `clone_repository` omit `code`; checkpoints already
 * added it, and the panel and clone keep that body.
 */
import { isDict, pyLen, PyValueError } from "@xueness/contracts";
import { realpathSync } from "node:fs";
import { isPyOSError, isPyValueError, pyExceptionName, realish, type SessionStore } from "@xueness/sessions";
import { checkpoint, GitError, listCheckpoints, repository, restoreCheckpoint, type Row } from "./actions.ts";
import { dispatchClone, ownsClone, type CloneOptions } from "./clone.ts";
import { dispatchSessionGit, ownsSessionGit } from "./session-git.ts";
import { checkpointRecords, resolveCheckpoint } from "./turn-checkpoints.ts";
import { dispatchGitWrite, GIT_WRITE_ROUTES, ownsGitWrite } from "./write-actions.ts";
export interface GitApiOptions extends CloneOptions { store: SessionStore; stateDir: string; enabled(id: string): boolean }
export const GIT_CHECKPOINT_ROUTES = ["GET /api/sessions/:id/git/checkpoints", "POST /api/sessions/:id/git/checkpoints", "POST /api/sessions/:id/git/checkpoints/:checkpoint/restore", "GET /api/sessions/:id/git/turn-checkpoints", "POST /api/sessions/:id/git/turn-checkpoints/rewind"];
const SESSION_GIT_ROUTES = ["GET /api/sessions/:id/git/status", "GET /api/sessions/:id/git/diff", "GET /api/sessions/:id/git/log"];
function pluginDisabled(): [number, { error: string; plugin: string; code: string }] {
  return [403, { error: "plugin disabled or dependency unavailable: git", plugin: "git", code: "plugin_disabled" }];
}
const checkpointOwns = (p: readonly string[]): boolean => p[0] === "api" && p[1] === "sessions" && /^[0-9a-f]{32}$/.test(p[2] ?? "") && p[3] === "git" && (p[4] === "checkpoints" && (p.length === 5 || p.length === 7 && p[6] === "restore") || p[4] === "turn-checkpoints" && (p.length === 5 || p.length === 6 && p[5] === "rewind"));
export function createGitApi(options: GitApiOptions) {
  const owns = (_method: string, p: readonly string[]) => ownsClone(p) || ownsSessionGit(p) || ownsGitWrite(p) || checkpointOwns(p);
  return { routes: [...GIT_CHECKPOINT_ROUTES, ...SESSION_GIT_ROUTES, ...GIT_WRITE_ROUTES, "POST /api/git/clone"], owns,
    async dispatch(method: string, p: string[], _query: Row, data: unknown): Promise<[number, unknown] | null> {
      if (ownsClone(p) || ownsSessionGit(p)) {
        if (!options.enabled("git")) return pluginDisabled();
        return ownsClone(p) ? dispatchClone(options, method, data) : dispatchSessionGit(options.store, method, p);
      }
      if (ownsGitWrite(p)) return options.enabled("git") ? dispatchGitWrite(options.store, method, p, data) : pluginDisabled();
      if (!owns(method, p)) return null;
      if (!options.enabled("git")) return pluginDisabled();
      const turn = p[4] === "turn-checkpoints", sid = p[2]!;
      if (method !== (p.length === 5 ? "GET" : "POST") && !(p.length === 5 && !turn && method === "POST")) return [405, { error: "method not allowed" }];
      const body = isDict(data) ? data : {};
      if (turn && method === "POST") {
        if (!isDict(data) || Object.keys(data).some((k) => !["confirmed", "checkpoint", "latest", "root"].includes(k)) || !Object.hasOwn(data, "confirmed")) return [400, { error: "expected confirmed, with checkpoint or latest" }];
        if (body.checkpoint != null && (typeof body.checkpoint !== "string" || !/^[0-9a-f]{32}$/.test(body.checkpoint)) || typeof (Object.hasOwn(body, "latest") ? body.latest : false) !== "boolean" || body.root != null && (typeof body.root !== "string" || !pyLen(body.root) || pyLen(body.root) > 4096)) return [400, { error: "invalid rewind target" }];
        if ((body.checkpoint != null) === (body.latest === true)) return [400, { error: "expected exactly one of checkpoint or latest" }];
      }
      let lease: Awaited<ReturnType<SessionStore["lease"]>> | undefined;
      try {
        if (method === "POST") lease = await options.store.lease(sid);
        let session: Row;
        try { session = await options.store.load(sid); } catch (e) { if (turn && (isPyOSError(e) || isPyValueError(e))) throw new GitError(404, "session not found"); throw e; }
        const root = String(session.root);
        if (method === "GET") return [200, turn ? { session: sid, repository: await repository(root), turns: checkpointRecords(session).map((r) => Object.fromEntries(["turn", "checkpointId", "hash", "message", "tool", "createdAt"].map((k) => [k, r[k] ?? null]))) } : { checkpoints: await listCheckpoints(root) }];
        if (turn) {
          if (body.confirmed !== true) throw new GitError(400, "review and confirm this rewind");
          if (!await repository(root)) throw new GitError(404, "该工作区不是 git 仓库");
          if (body.root != null) {
            let requested: string, pinned: string;
            try { requested = realpathSync(body.root as string); pinned = realpathSync(root); } catch { throw new GitError(409, "工作区目录不可用"); }
            if (realish(requested) !== realish(pinned)) throw new GitError(403, "--root 与该会话的工作区不一致");
          }
          const target = resolveCheckpoint(session, body.checkpoint as string | null, body.latest === true), result = await restoreCheckpoint(root, target.checkpointId);
          return [200, { ...result, turn: target.turn ?? null, restoredFrom: target.checkpointId ?? null }];
        }
        if (body.confirmed !== true) throw new PyValueError(p.length === 7 ? "review and confirm checkpoint restore" : "review and confirm this Git operation");
        return [200, p.length === 7 ? await restoreCheckpoint(root, p[5]!) : { checkpoint: await checkpoint(root, body.message as string | undefined) }];
      } catch (e) {
        if (e instanceof GitError) return [e.status, { error: e.message }];
        if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "workspace session is in use" }];
        if (isPyOSError(e) || isPyValueError(e)) return [400, { error: turn ? method === "GET" ? "cannot list turn checkpoints" : "cannot rewind workspace" : "invalid Git operation or missing session" }];
        throw e;
      } finally { await lease?.release(); }
    } };
}
