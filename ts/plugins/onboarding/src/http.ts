/** `GET/POST /api/onboarding/desktop`. The interactive CLI wizard stays on Python until the TS CLI round. */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, isPyIntValue, pyEncodeUtf8, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { exists, fsyncDirectory, isLink, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";

export const ONBOARDING_ROUTES = ["GET /api/onboarding/desktop", "POST /api/onboarding/desktop"] as const;

export interface OnboardingHttpOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** Truthy desktop host token. */
  desktop: boolean;
}

const METHOD = [405, { error: "method not allowed" }] as [number, { error: string }];

function refuse(message: string): never {
  const error = new Error(message);
  error.name = "ValueError";
  throw error;
}

function statePath(stateDir: string): string {
  const target = join(stateDir, "desktop-onboarding.json");
  if (isLink(stateDir) || isLink(target)) refuse("onboarding state must not be a link or reparse point");
  return target;
}

function loadState(stateDir: string): { completed: boolean; version: number } {
  const path = statePath(stateDir);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { completed: false, version: 1 }; throw error; }
  try {
    const info = lstatSync(path);
    if (!info.isFile()) refuse("invalid onboarding state file");
    const block = Buffer.alloc(4097);
    const count = readSync(fd, block, 0, block.length, 0);
    if (count > 4096) refuse("onboarding state too large");
    const value = pyJsonLoads(block.subarray(0, count).toString("utf8"));
    if (!isDict(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "completed") || !Object.hasOwn(value, "version")
      || typeof value.completed !== "boolean" || !isPyIntValue(value.version) || typeof value.version !== "number" || value.version !== 1) {
      refuse("invalid onboarding state");
    }
    return { completed: value.completed, version: 1 };
  } finally { closeSync(fd); }
}

function saveState(stateDir: string): { completed: true; version: 1 } {
  const path = statePath(stateDir);
  const value = { completed: true as const, version: 1 as const };
  mkdirSync(stateDir, { recursive: true });
  const temp = mkstemp(stateDir, ".resource-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(value, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally { closeSync(temp.fd); }
    replaceFile(temp.path, path);
  } finally { if (exists(temp.path)) unlinkSync(temp.path); }
  try { fsyncDirectory(stateDir); } catch { /* best-effort */ }
  return value;
}

export function createOnboardingHttp(options: OnboardingHttpOptions) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 3 && parts[0] === "api" && parts[1] === "onboarding" && parts[2] === "desktop";
  return {
    routes: ONBOARDING_ROUTES,
    owns,
    dispatch(method: string, parts: readonly string[], _query: Record<string, string[]>, data: unknown): [number, unknown] | null {
      if (!owns(method, parts)) return null;
      if (!options.enabled("onboarding")) return [403, { error: "plugin disabled or dependency unavailable: onboarding", plugin: "onboarding" }];
      if (!options.desktop) return [403, { error: "desktop host required" }];
      if (!options.enabled("desktop")) return [403, { error: "desktop plugin unavailable", plugin: "desktop" }];
      try {
        if (method === "GET") return [200, loadState(options.stateDir)];
        if (method === "POST") {
          if (!isDict(data) || Object.keys(data).length !== 1 || data.completed !== true) return [400, { error: "expected completed true only" }];
          return [200, saveState(options.stateDir)];
        }
        return METHOD;
      } catch {
        return [400, { error: "onboarding state could not be read or saved" }];
      }
    },
  };
}
