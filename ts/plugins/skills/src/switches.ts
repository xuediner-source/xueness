/** Per-skill user choices; no modifications to shipped SKILL.md files. */
import { closeSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDict, PyValueError } from "@xueness/contracts";
import { mkstemp, protectPrivateDirectory, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";
import { isLink, readText, lexists } from "./paths.ts";

export const INITIAL_SKILL_NAMES = ["seagull-game-security", "seagull-lab", "seagull-license-security", "seagull-memory", "seagull-pentest", "seagull-reverse", "ask-user-question"] as const;
const defaultsOff = new Set<string>(INITIAL_SKILL_NAMES);
const validId = (id: unknown): id is string => typeof id === "string" && id.length <= 256 && /^file:(?:project|project-compat|user|extra|bundled):[a-z0-9:_-]+$/.test(id);
type Switches = { enabled: Record<string, boolean>; broken: boolean };

export function fileSkillSwitches(stateDir: string): Switches {
  const path = join(stateDir, "skill-state.json");
  if (!lexists(path)) return { enabled: {}, broken: false };
  try {
    if (isLink(stateDir) || isLink(path)) throw new Error("linked skill state");
    const read = readText(path, 128 * 1024);
    if (read.failure || read.text === null) throw new Error("unreadable skill state");
    const value: unknown = JSON.parse(read.text);
    if (!isDict(value) || value.apiVersion !== 1 || Object.keys(value).sort().join(",") !== "apiVersion,enabled" || !isDict(value.enabled)
      || Object.keys(value.enabled).length > 1024 || Object.entries(value.enabled).some(([id, enabled]) => !validId(id) || typeof enabled !== "boolean")) throw new Error("invalid skill state");
    return { enabled: value.enabled as Record<string, boolean>, broken: false };
  } catch { return { enabled: {}, broken: true }; }
}

export function fileSkillEnabled(row: { id: string; name: string; source: string }, switches: Switches): boolean {
  if (row.source === "resource") return true;
  if (switches.broken) return false;
  return switches.enabled[row.id] ?? !(row.source === "bundled" && defaultsOff.has(row.name));
}

export function setFileSkillEnabled(stateDir: string, id: string, enabled: boolean): void {
  if (!validId(id) || typeof enabled !== "boolean") throw new PyValueError("invalid skill switch");
  const state = fileSkillSwitches(stateDir);
  if (state.broken) throw new PyValueError("skill-state.json is invalid; repair it before changing skill switches");
  if (Object.keys(state.enabled).length >= 1024 && !Object.hasOwn(state.enabled, id)) throw new PyValueError("too many skill switches");
  if (isLink(stateDir)) throw new PyValueError("skill state directory cannot be a link");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 }); protectPrivateDirectory(stateDir);
  const path = join(stateDir, "skill-state.json");
  if (isLink(path)) throw new PyValueError("skill state cannot be a link");
  const temporary = mkstemp(stateDir, ".skill-state-");
  try {
    try { protectPrivateFile(temporary.fd); writeAll(temporary.fd, Buffer.from(JSON.stringify({ apiVersion: 1, enabled: { ...state.enabled, [id]: enabled } }))); }
    finally { closeSync(temporary.fd); }
    replaceFile(temporary.path, path);
  } finally { rmSync(temporary.path, { force: true }); }
}
