/**
 * Workspace browser tabs (`tabs_api.dispatch`). Opening a tab does not start
 * Chromium. Each action is challenged, then run once on the shared worker.
 * Remote sessions and plan mode never reach the worker.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDict, pyLen, pySlice, pyTruthy } from "@xueness/contracts";
import { browserSubject, checkArguments, MAX_SCREENSHOT_PNG, shapeResult, type BrowserAction } from "./tools.ts";
import { currentWorker, withBrowserLock, workerFor } from "./registry.ts";
import { isLink } from "./profile-error.ts";
import { type BrowserTab, type TabReceipt, tabsFor } from "./tabs-state.ts";
import type { BrowserHttpOptions } from "./http-api.ts";
import type { WorkerSpawn } from "./worker.ts";

type Row = Record<string, unknown>;
type Reply = [number, Row];
const SID = /^[A-Za-z0-9_-]{1,160}$/;
const ACTIONS = new Set(["navigate", "refresh", "inspect", "snapshot", "click", "fill", "screenshot"]);
const FIELDS: Record<string, readonly string[]> = { navigate: ["url"], click: ["selector"], fill: ["selector", "text"] };
const ALLOWED = new Set(["action", "url", "selector", "text", "approvalId"]);
const WORKER_DOWN: Reply = [409, { error: "browser worker unavailable; close this tab and open a new one" }];

const defaultSpawn: WorkerSpawn = (file, args, options) => {
  const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  return { child, release: () => new Promise((done) => { if (child.exitCode !== null || child.signalCode !== null) { done(); return; } child.once("exit", () => done()); child.kill(); }) };
};

function canonical(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function contained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function defaultLoad(stateDir: string, id: string): Row {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("invalid session id");
  const path = join(stateDir, `${id}.json`);
  if (isLink(path)) throw new Error("session file is a symbolic link or reparse point");
  try { const value = JSON.parse(readFileSync(path, "utf8")) as unknown; if (!isDict(value)) throw new Error("invalid session"); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`[Errno 2] No such file or directory: '${path}'`); throw error; }
}

function resolveWorkspace(candidate: string, webRuns: string, projectDir: string, extra: readonly string[]): string {
  const runs = canonical(webRuns);
  const bases = [runs, canonical(projectDir), ...extra.map(canonical)];
  const target = isAbsolute(candidate) ? canonical(candidate) : canonical(join(runs, candidate));
  if (!bases.some((base) => contained(target, base))) throw new Error("workspace root not permitted");
  return target;
}

function sessionOf(options: BrowserHttpOptions, sid: unknown): { session: Row; root: string } {
  if (typeof sid !== "string" || !SID.test(sid)) throw new Error("invalid session");
  const session = (options.loadSession ?? defaultLoad)(options.stateDir, sid);
  if (!isDict(session) || session.id !== sid) throw new Error("session binding changed");
  if (Object.hasOwn(session, "remote_connection")) throw new Error("remote browser adapter unavailable");
  if (!options.projectDir || !options.webRuns) throw new Error("workspace root not permitted");
  return { session, root: resolveWorkspace(typeof session.root === "string" ? session.root : "", options.webRuns, options.projectDir, options.workspaceRoots ?? []) };
}

function pub(tab: BrowserTab): Row {
  return { pageId: tab.pageId, workspaceId: tab.workspaceId, sessionId: tab.sessionId, title: tab.title, url: tab.url };
}
function sameKeys(body: Row, keys: readonly string[]): boolean {
  const got = Object.keys(body).filter((key) => key !== "action" && key !== "approvalId").sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((key, index) => key === want[index]);
}
function runtimeFailure(error: unknown): boolean { return error instanceof Error && (error as { code?: string }).code === "execution_error"; }
function clientError(error: unknown): Reply {
  const message = error instanceof Error ? error.message : String(error);
  return [400, { error: pySlice(message, 300) || "browser operation unavailable" }];
}

async function runAction(options: BrowserHttpOptions, tab: BrowserTab, action: string, args: Row, approval: string, root: string): Promise<Reply> {
  const now = options.now ?? (() => performance.now());
  const subject = browserSubject({ action, ...args, pageId: tab.pageId });
  const pending = tab.pending;
  if (!pending || approval !== pending.approvalId || subject !== pending.subject || now() > pending.expiresAt) return [409, { error: "approval expired or action changed; request again" }];
  delete tab.pending;
  const receipts = tab.receipts ??= [];
  const receipt: TabReceipt = { approvalId: approval, action, approved: true, executed: false };
  receipts.push(receipt);
  if (receipts.length > 20) receipts.splice(0, receipts.length - 20);
  const command: Row = { action, ...args, pageId: tab.pageId };
  if (action === "navigate" || action === "click" || action === "fill") checkArguments(action, command);
  if (action === "screenshot") command.maxPngBytes = MAX_SCREENSHOT_PNG;
  const worker = await workerFor(options.stateDir, root, options.spawn ?? defaultSpawn, { env: options.env, bridge: options.bridge, startTimeoutMs: options.startTimeoutMs, callTimeoutMs: options.callTimeoutMs });
  let result = await worker.call(command);
  if (action === "screenshot" || action === "snapshot") result = shapeResult(action as BrowserAction, result);
  receipt.executed = true;
  receipt.ok = result.ok === true;
  if (result.ok === true) {
    tab.url = typeof result.url === "string" ? pySlice(result.url, 4096) : "";
    tab.title = pySlice(result.title == null ? "Browser" : String(result.title), 500);
  }
  return [200, { ...result, receipt: { ...receipt } }];
}

async function mutate(options: BrowserHttpOptions, tab: BrowserTab, operation: string, body: Row): Promise<Reply> {
  if (operation === "close") {
    if (pyTruthy(body)) throw new Error("close body must be empty");
    const worker = currentWorker(options.stateDir);
    if (worker) {
      const result = await worker.call({ action: "close", pageId: tab.pageId });
      if (result.ok !== true) throw Object.assign(new Error("browser page closure unconfirmed"), { code: "execution_error" });
    }
    tabsFor(options.stateDir).delete(tab.pageId);
    return [200, { ok: true }];
  }
  if (operation === "cancel") {
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes("approvalId") || !keys.includes("subject") || typeof body.approvalId !== "string" || typeof body.subject !== "string") throw new Error("exact pending approval required");
    const { root } = sessionOf(options, tab.sessionId);
    if (root !== tab.workspaceId) throw new Error("workspace binding changed");
    const now = options.now ?? (() => performance.now());
    const pending = tab.pending;
    if (pending && body.approvalId === pending.approvalId && body.subject === pending.subject) {
      delete tab.pending;
      return [200, { ok: true, cancelled: true, status: now() > pending.expiresAt ? "expired" : "cancelled" }];
    }
    if ((tab.receipts ?? []).some((receipt) => receipt.approvalId === body.approvalId)) return [200, { ok: false, cancelled: false, status: "already_submitted", error: "Action was already submitted; cancellation cannot undo its effects." }];
    return [409, { ok: false, cancelled: false, error: "Pending approval changed or is no longer available; cancellation not confirmed." }];
  }
  if (operation !== "action") return [404, { error: "browser operation not found" }];
  if (Object.keys(body).some((key) => !ALLOWED.has(key))) throw new Error("unknown action fields");
  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) throw new Error("unsupported browser action");
  const fields = FIELDS[action] ?? [];
  if (!sameKeys(body, fields)) throw new Error("invalid action fields");
  const args: Row = {};
  for (const key of fields) args[key] = body[key];
  if (Object.entries(args).some(([key, value]) => typeof value !== "string" || pyLen(value) > (key === "text" ? 5000 : key === "url" ? 4096 : 1000))) throw new Error("action exceeds bounds");
  const { session, root } = sessionOf(options, tab.sessionId);
  if (root !== tab.workspaceId) throw new Error("workspace binding changed");
  if (session.permission_mode === "plan" || session.mode === "plan") return [403, { error: "browser actions denied in plan mode" }];
  const subject = browserSubject({ action, ...args, pageId: tab.pageId });
  if (body.approvalId == null) {
    const approvalId = randomBytes(16).toString("hex");
    tab.pending = { approvalId, subject, expiresAt: (options.now ?? (() => performance.now()))() + 120_000 };
    return [200, { approvalRequired: true, approvalId, subject }];
  }
  if (typeof body.approvalId !== "string") return [409, { error: "approval expired or action changed; request again" }];
  return runAction(options, tab, action, args, body.approvalId, root);
}

async function handle(options: BrowserHttpOptions, method: string, parts: readonly string[], body: Row): Promise<Reply> {
  const table = tabsFor(options.stateDir);
  if (parts.length === 3) {
    if (method === "GET") return [200, { tabs: [...table.values()].map(pub) }];
    if (method !== "POST") return [405, { error: "method not allowed" }];
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "sessionId") || table.size >= 8) throw new Error("at most eight browser tabs may be open");
    const { session, root } = sessionOf(options, body.sessionId);
    const pageId = randomBytes(16).toString("hex");
    const tab: BrowserTab = { pageId, workspaceId: root, sessionId: String(session.id), title: "Browser", url: "" };
    table.set(pageId, tab);
    return [200, pub(tab)];
  }
  if (parts.length !== 5 || method !== "POST") return [405, { error: "method not allowed" }];
  const tab = table.get(parts[3] ?? "");
  if (!tab) return [404, { error: "browser tab not found" }];
  return mutate(options, tab, parts[4] ?? "", body);
}

/** Every `/api/browser/tabs` shape. Plugin disable is decided by `createBrowserHttp` before this runs. */
export async function dispatchTabs(options: BrowserHttpOptions, method: string, parts: readonly string[], body: Row): Promise<Reply> {
  try { return await withBrowserLock(options.stateDir, () => handle(options, method, parts, body)); }
  catch (error) { return runtimeFailure(error) ? WORKER_DOWN : clientError(error); }
}
