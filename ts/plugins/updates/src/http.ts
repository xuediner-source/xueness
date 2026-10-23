/** Desktop update bridge. Source apply is a separate export and is not called from HTTP. */
import { closeSync, fsyncSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyEncodeUtf8, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { exists, fsyncDirectory, isLink, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";

export const UPDATE_ROUTES = ["GET /api/updates/status", "GET /api/updates/settings", "POST /api/updates/prepare-install"] as const;
const ACTIONS = new Set(["status", "check", "download", "install", "cancel"]);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const UNSUPPORTED = { phase: "unsupported", reason: "应用内更新需使用桌面安装版。", canInstall: false, canDownload: false, installMode: "unsupported" };

export interface UpdateBridge { request(message: Record<string, unknown>, timeoutSeconds: number): unknown }
export interface UpdatesHttpOptions {
  stateDir: string;
  enabled: (id: string) => boolean;
  desktopToken?: string;
  bridge?: UpdateBridge | null;
  workflowsRunning?: () => boolean;
  terminalsOpen?: () => boolean;
  tasksRunning?: () => boolean;
  sessionsRunning?: () => boolean;
  schedulerAlive?: () => boolean;
  nativePolicySync?: () => void;
}

function workflowsRunning(stateDir: string): boolean {
  const directory = join(stateDir, "workflows");
  if (isLink(directory)) return false;
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json") || isLink(join(directory, name))) continue;
      const value = pyJsonLoads(readFileSync(join(directory, name), "utf8"));
      if (isDict(value) && value.status === "running") return true;
    }
  } catch { return false; }
  return false;
}

function readSettings(stateDir: string): { autoDownload: boolean } {
  const path = join(stateDir, "updates-settings.json");
  if (isLink(path)) return { autoDownload: false };
  try {
    const raw = readFileSync(path);
    if (raw.length > 4096) return { autoDownload: false };
    const value = pyJsonLoads(raw.toString("utf8"));
    return { autoDownload: isDict(value) && value.autoDownload === true };
  } catch (error) { return { autoDownload: (error as NodeJS.ErrnoException).code !== "ENOENT" ? false : true }; }
}

function writeSettings(stateDir: string, autoDownload: boolean): void {
  const path = join(stateDir, "updates-settings.json");
  if (isLink(stateDir) || isLink(path)) throw Object.assign(new Error("link"), { name: "ValueError" });
  mkdirSync(stateDir, { recursive: true });
  const temp = mkstemp(stateDir, ".resource-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps({ autoDownload }, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally { closeSync(temp.fd); }
    replaceFile(temp.path, path);
  } finally { if (exists(temp.path)) unlinkSync(temp.path); }
  try { fsyncDirectory(stateDir); } catch { /* best-effort */ }
}

export function createUpdatesHttp(options: UpdatesHttpOptions) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 3 && parts[0] === "api" && parts[1] === "updates";
  return {
    routes: UPDATE_ROUTES,
    owns,
    dispatch(method: string, parts: readonly string[], _query: Record<string, string[]>, data: unknown): [number, unknown] | null | Promise<[number, unknown]> {
      if (!owns(method, parts)) return null;
      if (!options.enabled("updates")) return [403, { error: "plugin disabled or dependency unavailable: updates", plugin: "updates" }];
      if (!options.desktopToken || !options.bridge) return [method === "GET" ? 200 : 409, UNSUPPORTED];
      if (!options.enabled("desktop")) return [403, { error: "desktop plugin disabled" }];
      const action = parts[2] ?? "";
      if (action === "settings") {
        if (method === "GET") return [200, readSettings(options.stateDir)];
        if (method === "POST" && isDict(data) && Object.keys(data).length === 1 && typeof data.autoDownload === "boolean") {
          writeSettings(options.stateDir, data.autoDownload);
          options.nativePolicySync?.();
          return [200, readSettings(options.stateDir)];
        }
        return [400, { error: "expected autoDownload boolean" }];
      }
      if (action === "policy" && method === "GET") return [200, { enabled: true }];
      if (action === "prepare-install" && method === "POST") {
        if (!(isDict(data) && (Object.keys(data).length === 0 || (Object.keys(data).length === 1 && data.checkOnly === true)))) return [400, { error: "expected empty body" }];
        if (options.sessionsRunning?.()) return [409, { ok: false, reason: "请先结束正在运行的会话，再重启更新。" }];
        if (options.workflowsRunning?.() ?? workflowsRunning(options.stateDir)) return [409, { ok: false, reason: "请先结束后台工作流，再重启更新。" }];
        if (options.terminalsOpen?.()) return [409, { ok: false, reason: "请先关闭交互式终端，再重启更新。" }];
        if (options.tasksRunning?.()) return [409, { ok: false, reason: "请先结束子任务，再重启更新。" }];
        if (data.checkOnly === true) return [200, { ok: true }];
        if (options.schedulerAlive?.()) return [409, { ok: false, reason: "定时任务尚在运行，请稍后更新。" }];
        return [200, { ok: true }];
      }
      if (!ACTIONS.has(action) || (method === "GET") !== (action === "status") || (method !== "GET" && method !== "POST")) return [405, { error: "method not allowed" }];
      const body = data == null ? {} : data;
      if (!isDict(body) || Object.keys(body).some((key) => key !== "version")) return [400, { error: "expected version only" }];
      const version = body.version;
      if (action === "download" || action === "install") {
        if (typeof version !== "string" || !VERSION.test(version)) return [400, { error: "invalid update version" }];
      } else if (version !== undefined) return [400, { error: "unexpected version" }];
      const unavailable: [number, unknown] = [503, { error: "桌面更新服务暂不可用，请稍后重试。" }];
      const answer = (result: unknown): [number, unknown] => isDict(result) && isDict(result.state) ? [200, result.state] : unavailable;
      try {
        // The desktop host answers over its stdio pipe (a promise); test bridges answer at once.
        const result = options.bridge.request({ type: "update", action, ...(typeof version === "string" ? { version } : {}) }, 35);
        return result instanceof Promise ? result.then(answer, () => unavailable) : answer(result);
      } catch { return unavailable; }
    },
  };
}
