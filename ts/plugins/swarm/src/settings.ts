/**
 * Swarm limits, `<state>/swarm/settings.json`. Defaults suit a local model:
 * at most four members, one running at a time against a local server (two
 * against an API), bounded steps and turns per member, three nudges before a
 * quiet swarm is marked stalled, and a wall-clock limit.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";

export interface SwarmSettings { maxMembers: number; maxActive: number | null; memberMaxSteps: number; memberMaxTurns: number; nudgeLimit: number; wallMinutes: number }
export const DEFAULT_SWARM_SETTINGS: Readonly<SwarmSettings> = Object.freeze({ maxMembers: 4, maxActive: null, memberMaxSteps: 30, memberMaxTurns: 12, nudgeLimit: 3, wallMinutes: 60 });
const RANGES: Record<Exclude<keyof SwarmSettings, "maxActive">, [number, number]> = { maxMembers: [2, 6], memberMaxSteps: [5, 64], memberMaxTurns: [1, 40], nudgeLimit: [0, 10], wallMinutes: [5, 480] };

export class SwarmSettingsError extends Error { override name = "SwarmSettingsError"; }
const path = (stateDir: string): string => join(stateDir, "swarm", "settings.json");

export function normalizeSwarmSettings(value: unknown, base: Readonly<SwarmSettings> = DEFAULT_SWARM_SETTINGS): SwarmSettings {
  if (!isDict(value)) throw new SwarmSettingsError("settings must be an object");
  const out: SwarmSettings = { ...base };
  for (const [key, item] of Object.entries(value)) {
    if (key === "maxActive") {
      if (item !== null && (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 4)) throw new SwarmSettingsError("maxActive must be null (automatic) or an integer from 1 to 4");
      out.maxActive = item as number | null;
      continue;
    }
    const range = RANGES[key as keyof typeof RANGES];
    if (!range) throw new SwarmSettingsError(`unknown setting ${key}`);
    if (typeof item !== "number" || !Number.isInteger(item) || item < range[0] || item > range[1]) throw new SwarmSettingsError(`${key} must be an integer from ${range[0]} to ${range[1]}`);
    (out as unknown as Record<string, number>)[key] = item;
  }
  return out;
}

export function readSwarmSettings(stateDir: string): SwarmSettings {
  try {
    const stat = lstatSync(path(stateDir));
    if (!stat.isFile() || stat.size > 16_384) throw new SwarmSettingsError("swarm settings file is not usable");
    return normalizeSwarmSettings(pyJsonLoads(readFileSync(path(stateDir), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SWARM_SETTINGS };
    throw error;
  }
}

export function writeSwarmSettings(stateDir: string, patch: unknown): SwarmSettings {
  const next = normalizeSwarmSettings(patch, readSwarmSettings(stateDir));
  const directory = join(stateDir, "swarm");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new SwarmSettingsError("swarm settings directory must not be a link");
  const temporary = `${path(stateDir)}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeSync(fd, pyJsonDumps(next, { indent: 2, sortKeys: true })); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path(stateDir)); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  return next;
}
