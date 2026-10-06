/**
 * Xueness workbench settings data layer.
 *
 * Native Result-typed settings API. Reads and writes expose failures and keep
 * unknown values in each server section when saving a partial patch.
 *
 * The agent capability switches (MCP / subagents / hooks) spawn processes or
 * nested model calls, so reads are fail-closed: a missing or non-boolean value
 * is false, never true. Do not "helpfully" default them on.
 *
 * Contract: docs/xueness-workbench-slice2.md (frozen). Exported types and
 * signatures are the interface the settings UI builds against.
 */
import type { Result } from "./xuenessWorkbench";
import { getSettings, saveSettingsSection } from "./xuenessApi";

const SETTINGS_SECTIONS = ["general", "appearance", "shortcuts", "browser", "agent"] as const;
const SECTION_OF_KEY: Record<string, string> = {
  theme: "appearance", fontSize: "appearance", tabSize: "appearance", wordWrap: "appearance", terminalFontSize: "appearance",
  codePreviewSettings: "appearance",
  bindings: "shortcuts", sendShortcut: "shortcuts", browserControlEnabled: "browser",
  allowMcp: "agent", allowSubagents: "agent", allowHooks: "agent", subagentCancelOneEnabled: "agent",
};

function mergeSettings(settings: Record<string, unknown>, defaults: SettingsMap): SettingsMap {
  const flat = { ...defaults };
  for (const section of SETTINGS_SECTIONS) {
    const values = settings[section];
    if (values && typeof values === "object" && !Array.isArray(values)) Object.assign(flat, values);
  }
  return flat;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

export type SettingsMap = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AgentCapabilities = {
  allowMcp: boolean;
  allowSubagents: boolean;
  allowHooks: boolean;
};

export type ResultT<T> = Result<T>;

/**
 * Load all settings sections, merged over the caller's defaults.
 *
 * A failed read remains an error, so an unreachable host never looks like a
 * freshly initialized settings store. Later sections override earlier ones;
 * defaults fill only keys the host omits.
 */
export async function loadWorkbenchSettings(
  defaults: SettingsMap,
): Promise<Result<SettingsMap>> {
  try {
    return { ok: true, value: mergeSettings(await getSettings(), defaults) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Merge into the current server sections, propagate errors and verify persisted
 * values without using defaults as evidence. A failed initial read never writes. */
export async function saveWorkbenchSettings(
  defaults: SettingsMap,
  patch: SettingsMap,
): Promise<Result<SettingsMap>> {
  try {
    const existing = await getSettings();
    const grouped = new Map<string, SettingsMap>();
    for (const [key, value] of Object.entries(patch)) {
      const section = SECTION_OF_KEY[key] ?? "general";
      grouped.set(section, { ...grouped.get(section), [key]: value });
    }
    for (const [section, values] of grouped) {
      const stored = existing[section];
      const base = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
      await saveSettingsSection(section, { ...base, ...values });
    }
    const persisted = await getSettings();
    const missed = Object.keys(patch).filter(key => {
      const section = persisted[SECTION_OF_KEY[key] ?? "general"] as SettingsMap | undefined;
      return !section || !Object.hasOwn(section, key) || !sameValue(section[key], patch[key]);
    });
    if (missed.length) return { ok: false, error: `settings save did not take effect: ${missed.join(", ")}` };
    return { ok: true, value: mergeSettings(persisted, defaults) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Read the three capability switches from a settings map.
 *
 * Fail-closed: only a literal `true` enables a capability. These switches spawn
 * subprocesses or nested model runs, so a missing key, a string "true", or any
 * other truthy value must stay OFF. Do not loosen this to a truthiness check.
 */
export function readAgentCapabilities(values: SettingsMap): AgentCapabilities {
  const source = values && typeof values === "object" ? values : {};
  return {
    allowMcp: source.allowMcp === true,
    allowSubagents: source.allowSubagents === true,
    allowHooks: source.allowHooks === true,
  };
}

/** Build the settings patch for a capability state. */
export function capabilityPatch(caps: AgentCapabilities): SettingsMap {
  return {
    allowMcp: caps.allowMcp === true,
    allowSubagents: caps.allowSubagents === true,
    allowHooks: caps.allowHooks === true,
  };
}
