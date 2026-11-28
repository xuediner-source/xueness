/**
 * Judge settings, `<state>/tool_judge/settings.json`.
 *
 * The judge is inert until a saved model profile is chosen. Verdicts only
 * advise by default (owner decision, 2026-11-14): `applyRepairs` lets a repair
 * rewrite the call's arguments, `applyRejects` lets a reject stop a call once.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";

export interface JudgeSelection { providerId: string; model: string | null }
export interface JudgeSettings {
  v: 1;
  /** The saved provider profile that judges; null keeps the judge off. */
  profile: JudgeSelection | null;
  preflightEnabled: boolean;
  applyRepairs: boolean;
  applyRejects: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
}
export const DEFAULT_JUDGE_SETTINGS: Readonly<JudgeSettings> = Object.freeze({ v: 1, profile: null, preflightEnabled: true, applyRepairs: false, applyRejects: false, timeoutMs: 10_000, maxOutputTokens: 512 });
export const TIMEOUT_RANGE = [1_000, 60_000] as const;
export const OUTPUT_RANGE = [128, 2_048] as const;
const MAX_BYTES = 16 * 1024;
const PROFILE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const KEYS = new Set(["v", "profile", "preflightEnabled", "applyRepairs", "applyRejects", "timeoutMs", "maxOutputTokens"]);

export class JudgeSettingsError extends Error { override name = "JudgeSettingsError"; }

export const settingsPath = (stateDir: string): string => join(stateDir, "tool_judge", "settings.json");

function integer(value: unknown, field: string, [low, high]: readonly [number, number]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) throw new JudgeSettingsError(`${field} must be an integer from ${low} to ${high}`);
  return value;
}

/** A profile selection, or null. Model text is bounded; an empty model means the profile's own model. */
export function normalizeSelection(value: unknown): JudgeSelection | null {
  if (value === null || value === undefined) return null;
  if (!isDict(value)) throw new JudgeSettingsError("profile must be an object or null");
  const providerId = value.providerId ?? value.provider_id;
  if (typeof providerId !== "string" || !PROFILE_ID.test(providerId)) throw new JudgeSettingsError("profile.providerId must be a saved profile id");
  const model = value.model ?? null;
  if (model !== null && (typeof model !== "string" || model.length > 200)) throw new JudgeSettingsError("profile.model must be text of at most 200 characters");
  return { providerId, model: typeof model === "string" && model.trim() ? model.trim() : null };
}

/** The full settings from a stored or submitted object; unknown keys are refused. */
export function normalizeSettings(value: unknown, base: Readonly<JudgeSettings> = DEFAULT_JUDGE_SETTINGS): JudgeSettings {
  if (!isDict(value)) throw new JudgeSettingsError("settings must be an object");
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw new JudgeSettingsError(`unknown setting ${key}`);
  const pick = <T>(key: keyof JudgeSettings): T => (Object.hasOwn(value, key) ? value[key] : base[key]) as T;
  for (const key of ["preflightEnabled", "applyRepairs", "applyRejects"] as const) if (typeof pick(key) !== "boolean") throw new JudgeSettingsError(`${key} must be true or false`);
  return {
    v: 1,
    profile: normalizeSelection(pick("profile")),
    preflightEnabled: pick<boolean>("preflightEnabled"),
    applyRepairs: pick<boolean>("applyRepairs"),
    applyRejects: pick<boolean>("applyRejects"),
    timeoutMs: integer(pick("timeoutMs"), "timeoutMs", TIMEOUT_RANGE),
    maxOutputTokens: integer(pick("maxOutputTokens"), "maxOutputTokens", OUTPUT_RANGE),
  };
}

/** Stored settings; a missing file is the defaults. A link, an oversized or an invalid file is refused. */
export function readJudgeSettings(stateDir: string): JudgeSettings {
  const path = settingsPath(stateDir);
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_JUDGE_SETTINGS }; throw error; }
  if (!stat.isFile()) throw new JudgeSettingsError("judge settings must be a regular file");
  if (stat.size > MAX_BYTES) throw new JudgeSettingsError("judge settings file is too large");
  return normalizeSettings(pyJsonLoads(readFileSync(path, "utf8")));
}

/** Merge a submitted patch into the stored settings and write them atomically. */
export function writeJudgeSettings(stateDir: string, patch: unknown): JudgeSettings {
  if (!isDict(patch)) throw new JudgeSettingsError("settings must be an object");
  const next = normalizeSettings(patch, readJudgeSettings(stateDir));
  const directory = join(stateDir, "tool_judge");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new JudgeSettingsError("judge settings directory must not be a link");
  const temporary = join(directory, `.settings-${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(temporary, "w", 0o600);
  try { writeSync(fd, pyJsonDumps(next, { indent: 2, sortKeys: true })); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, settingsPath(stateDir)); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  return next;
}
