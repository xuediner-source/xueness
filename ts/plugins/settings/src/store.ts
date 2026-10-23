/**
 * Settings persistence: a port of Python `bundled_plugins/settings/settings_store.py`.
 *
 *   GET  /api/settings            -> {settings}
 *   GET  /api/settings/<section>  -> {section, values}
 *   POST /api/settings/<section>  {values} -> {section, values}
 *
 * One `<state>/settings.json`, written atomically (mkstemp, fsync, replace)
 * with Python's `json.dump(..., ensure_ascii=False, indent=2)` bytes. Unknown
 * sections and keys are preserved verbatim: the file is decoded losslessly so
 * integral floats and large integers survive a rewrite by either backend.
 * Read-modify-write is synchronous, so it is atomic within this process; the
 * Python backend still writes the same file during the migration.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { mkstemp, replaceFile, writeAll } from "@xueness/sessions";
import { validate } from "./preferences.ts";

export const SECTION_IDS: readonly string[] = Object.freeze(["general", "appearance", "shortcuts", "browser", "agent"]);
export const SETTINGS_FILENAME = "settings.json";
export type Settings = Record<string, unknown>;
export type Reply = [number, unknown];

/** `load_settings`: missing, unreadable, corrupt or non-object files read as `{}`. */
export function loadSettings(stateDir: string): Settings {
  let raw: Buffer;
  try { raw = readFileSync(join(stateDir, SETTINGS_FILENAME)); } catch { return {}; }
  // Like `Path.read_text(encoding="utf-8")`, undecodable bytes raise (a ValueError).
  const text = pyDecodeUtf8(raw);
  let parsed: unknown;
  try { parsed = pyJsonLoads(text, { lossless: true }); } catch { return {}; }
  return isDict(parsed) ? parsed : {};
}

/** `save_settings`: mkstemp, write, fsync, replace; the temp file never survives. */
export function saveSettings(stateDir: string, settings: Settings): void {
  mkdirSync(stateDir, { recursive: true });
  // A lone surrogate fails to encode (UnicodeEncodeError) before anything is replaced.
  const bytes = pyEncodeUtf8(pyJsonDumps(settings, { indent: 2 }));
  const temp = mkstemp(stateDir, ".settings-");
  let fd: number | null = temp.fd;
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    replaceFile(temp.path, join(stateDir, SETTINGS_FILENAME));
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp.path)) unlinkSync(temp.path);
  }
}

/** `update_settings`: one read/modify/write; a throwing `mutate` saves nothing. */
export function updateSettings(stateDir: string, mutate: (settings: Settings) => void): Settings {
  const settings = loadSettings(stateDir);
  mutate(settings);
  saveSettings(stateDir, settings);
  return settings;
}

/** `settings_store.dispatch`; null leaves the request to the next owner. */
export function dispatchSettings(method: string, parts: readonly string[], data: unknown, stateDir: string): Reply | null {
  if (parts[0] !== "api" || parts[1] !== "settings" || parts.length > 3) return null;
  const verb = method.toUpperCase();
  if (parts.length === 2) return verb === "GET" ? [200, { settings: loadSettings(stateDir) }] : null;
  const section = parts[2]!;
  if (!SECTION_IDS.includes(section)) return [404, { error: `unknown settings section: ${section}` }];
  if (verb === "GET") {
    const values = loadSettings(stateDir)[section];
    return [200, { section, values: isDict(values) ? values : {} }];
  }
  if (verb !== "POST") return null;
  if (!isDict(data)) return [400, { error: "request body must be an object" }];
  const values = data.values;
  if (!isDict(values)) return [400, { error: "values must be an object" }];
  try {
    validate(section, values);
  } catch (error) {
    if (error instanceof PyValueError) return [400, { error: error.message }];
    throw error;
  }
  updateSettings(stateDir, (current) => { current[section] = values; });
  return [200, { section, values }];
}