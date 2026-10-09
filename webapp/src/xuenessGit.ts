/**
 * Xueness Git panel data layer.
 *
 * Three GETs against the session-scoped git routes on the Python backend:
 * status (branch + porcelain entries), diff (real working-tree stat + patch,
 * unlike the journal-derived intent diff), recent commits, and CSRF-protected
 * local workspace actions.
 *
 * Failures surface as `{ok:false, error}` and never throw: the panel must be
 * able to render an honest state ("该工作区不是 git 仓库" comes back verbatim
 * in the 404 body so the view can show a real empty state, not a fake panel).
 */
import type { Result } from "./xuenessWorkbench";

export type GitStatus = {
  branch: string;
  entries: { code: string; path: string }[];
  clean: boolean;
};

export type GitDiff = { stat: string; patch: string; truncated: boolean };

export type GitCommit = {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
};
export type GitCheckpoint = { id: string; hash: string; message: string };

// -- transport (GET-only; mirrors the private requestGet seam of the
//    xuenessWorkbench data layer: same-origin, no-store, payload.error text) --

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let payload: unknown;
  let jsonParsed = true;
  try {
    payload = await response.json();
  } catch {
    jsonParsed = false;
  }
  if (!response.ok) {
    const detail = (payload as { error?: unknown } | null | undefined)?.error;
    throw new Error(typeof detail === "string" && detail ? detail : `HTTP ${response.status}`);
  }
  if (!jsonParsed) throw new Error("invalid JSON response");
  return payload as T;
}

function requestGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
}

async function requestPost<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const csrf = await requestGet<{ csrfToken: string }>("/api/csrf", signal);
  return requestJson<T>(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function gitPath(id: string, verb: string): string {
  return `/api/sessions/${encodeURIComponent(id)}/git/${verb}`;
}

async function gitAction<T>(id: string, verb: string, data: object): Promise<Result<T>> {
  try {
    return { ok: true, value: await requestPost<T>(gitPath(id, verb), { ...data, confirmed: true }) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

// -- reads --------------------------------------------------------------------

export async function loadGitStatus(id: string, signal?: AbortSignal): Promise<Result<GitStatus>> {
  try {
    const value = await requestGet<GitStatus>(gitPath(id, "status"), signal);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadGitDiff(id: string, signal?: AbortSignal): Promise<Result<GitDiff>> {
  try {
    const value = await requestGet<GitDiff>(gitPath(id, "diff"), signal);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadGitLog(id: string, count?: number, signal?: AbortSignal): Promise<Result<GitCommit[]>> {
  try {
    const query = count && count > 0 ? `?count=${encodeURIComponent(count)}` : "";
    const payload = await requestGet<{ commits?: GitCommit[] }>(`${gitPath(id, "log")}${query}`, signal);
    return { ok: true, value: payload.commits ?? [] };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadGitCheckpoints(id: string, signal?: AbortSignal): Promise<Result<GitCheckpoint[]>> {
  try {
    const payload = await requestGet<{ checkpoints?: GitCheckpoint[] }>(gitPath(id, "checkpoints"), signal);
    return { ok: true, value: payload.checkpoints ?? [] };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

export const initGitRepository = (id: string) => gitAction<{ ok: boolean }>(id, "init", {});
export const stageGitPaths = (id: string, paths: string[]) => gitAction<{ ok: boolean }>(id, "stage", { paths });
export const unstageGitPaths = (id: string, paths: string[]) => gitAction<{ ok: boolean }>(id, "unstage", { paths });
export const commitGitChanges = (id: string, message: string) => gitAction<{ ok: boolean }>(id, "commit", { message });
export const switchGitBranch = (id: string, name: string, create: boolean) => gitAction<{ ok: boolean }>(id, "branch", { name, create });
export const stashGitChanges = (id: string) => gitAction<{ ok: boolean }>(id, "stash", {});

export async function createGitCheckpoint(id: string, message: string): Promise<Result<GitCheckpoint>> {
  try {
    const payload = await requestPost<{ checkpoint: GitCheckpoint }>(gitPath(id, "checkpoints"), { message, confirmed: true });
    return { ok: true, value: payload.checkpoint };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

export async function restoreGitCheckpoint(id: string, checkpointId: string): Promise<Result<{ restored: string; recovery: GitCheckpoint }>> {
  try {
    const path = `${gitPath(id, "checkpoints")}/${encodeURIComponent(checkpointId)}/restore`;
    return { ok: true, value: await requestPost(path, { confirmed: true }) };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

// -- clone -------------------------------------------------------------------

export type GitCloneResult = { root: string; url: string };

/**
 * `POST /api/git/clone` with the same explicit confirmation every other write
 * uses. The host refuses local transports and destinations outside the
 * authorized workspace roots; its `error` text is surfaced verbatim.
 */
export async function cloneGitRepository(url: string, dest: string): Promise<Result<GitCloneResult>> {
  try {
    const payload = await requestPost<Partial<GitCloneResult>>("/api/git/clone", { url, dest, confirmed: true });
    if (typeof payload.root !== "string" || !payload.root) throw new Error("克隆响应缺少目标目录");
    return { ok: true, value: { root: payload.root, url: typeof payload.url === "string" ? payload.url : url } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}
