/**
 * `settings_api.dispatch`: runtime probe plus cache/all clear.
 * `all` also removes direct `browser-import-old-<32 hex>` backups and nothing else.
 * A running task is refused only after the body is valid, matching Python.
 */
import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { shutdown, withBrowserLock } from "./registry.ts";
import { managedProfile } from "./worker.ts";
import { exists, isLink } from "./profile-error.ts";
import { browserRuntime, type RuntimeInfo } from "./runtime-probe.ts";
import type { BrowserHttpOptions } from "./http-api.ts";

type Row = Record<string, unknown>;
type Reply = [number, Row];
const CACHE_PATHS = ["Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "Default/Cache", "Default/Code Cache", "Default/GPUCache"];
const BACKUP = /^browser-import-old-[0-9a-f]{32}$/;
const UNAVAILABLE: Reply = [400, { error: "managed browser data unavailable or invalid" }];

class DataError extends Error {}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolvePath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try { return missing.reduceRight((base, part) => join(base, part), realpathSync(current)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function profileOf(stateDir: string): string {
  try { return managedProfile(stateDir); } catch { throw new DataError("profile"); }
}

function cacheDenied(profile: string, target: string): boolean {
  if ((exists(target) || isLink(target)) && isLink(target)) return true;
  let parent = dirname(target);
  while (inside(parent, profile)) {
    if ((exists(parent) || isLink(parent)) && isLink(parent)) return true;
    if (relative(profile, parent) === "") break;
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  try {
    const root = exists(profile) ? realpathSync(profile) : resolve(profile);
    return !inside(resolvePath(target), root);
  } catch { return true; }
}

function backups(state: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(state); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: string[] = [];
  for (const name of names) {
    if (!BACKUP.test(name)) continue;
    const candidate = join(state, name);
    if (isLink(candidate) || !statSync(candidate).isDirectory() || dirname(realpathSync(candidate)) !== state) throw new DataError("backup");
    found.push(candidate);
  }
  return found;
}

function removeTarget(target: string): void {
  if (!exists(target)) return;
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new DataError("link");
  rmSync(target, { recursive: info.isDirectory(), force: true });
}

async function clear(options: BrowserHttpOptions, body: Row, profile: string): Promise<Reply> {
  const operation = body.operation;
  const keys = Object.keys(body);
  if ((operation !== "cache" && operation !== "all") || keys.some((key) => key !== "operation" && key !== "confirmed")) return [400, { error: "expected cache or all operation" }];
  if (operation === "all" && body.confirmed !== true) return [400, { error: "confirmation required to clear all browser data" }];
  if (options.running.size > 0) return [409, { error: "stop running tasks before clearing browser data" }];
  const targets = operation === "cache"
    ? CACHE_PATHS.map((name) => join(profile, ...name.split("/"))).filter((target) => { if (cacheDenied(profile, target)) throw new DataError("cache"); return exists(target); })
    : [profile, ...backups(dirname(profile))];
  await shutdown(options.stateDir);
  for (const target of targets) removeTarget(target);
  return [200, { ok: true }];
}

/** GET/POST `/api/browser/data` and GET `/api/browser/runtime`. */
export async function dispatchSettings(options: BrowserHttpOptions, method: string, parts: readonly string[], body: Row): Promise<Reply> {
  if (parts[2] === "runtime") {
    if (method !== "GET") return [405, { error: "method not allowed" }];
    const probe: RuntimeInfo = options.runtime ? options.runtime() : browserRuntime(options.env);
    const desktop = options.desktop;
    return [200, { ...probe, desktop, importEnabled: desktop && options.enabled("desktop") }];
  }
  if (method !== "GET" && method !== "POST") return [405, { error: "method not allowed" }];
  try {
    return await withBrowserLock(options.stateDir, async () => {
      const profile = profileOf(options.stateDir);
      if (method === "GET") {
        let present = false;
        try { present = statSync(profile).isDirectory(); } catch { present = false; }
        return [200, { profilePresent: present }];
      }
      return clear(options, body, profile);
    });
  } catch (error) {
    if (error instanceof DataError || typeof (error as NodeJS.ErrnoException)?.code === "string") return UNAVAILABLE;
    throw error;
  }
}

