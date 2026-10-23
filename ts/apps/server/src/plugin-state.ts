/** Read allowlisted persisted switches on every use, failing closed on corruption. */
import { join } from "node:path";
import { BUNDLED_PLUGIN_IDS, isDict, pyJsonLoads } from "@xueness/contracts";
import { isLink, readRegularBytes } from "@xueness/sessions";
import { loadDataManifests } from "@xueness/plugin-extensions";
import { loadManifests } from "./manifests.ts";

function readChoices(stateDir: string): { enabled: Record<string, boolean>; overlay: Record<string, boolean> } | null {
  const allowed = new Set<string>(BUNDLED_PLUGIN_IDS);
  const switches = (value: unknown): Record<string, boolean> => {
    if (value === undefined || value === null) return {};
    if (!isDict(value) || Object.entries(value).some(([id, v]) => !allowed.has(id) || typeof v !== "boolean")) throw new Error("invalid plugin switches");
    return value as Record<string, boolean>;
  };
  const path = join(stateDir, "plugin-state.json");
  let value: unknown;
  try {
    if (isLink(path)) return null;
    const bytes = readRegularBytes(path);
    if (bytes.length > 65536) return null;
    value = pyJsonLoads(bytes.toString("utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") value = { apiVersion: 1 }; else return null; }
  if (!isDict(value) || value.apiVersion !== 1 || Object.keys(value).some((k) => !["apiVersion", "enabled", "profile"].includes(k))) return null;
  let overlay: Record<string, boolean> = {};
  if (value.profile != null) {
    if (!isDict(value.profile) || Object.keys(value.profile).some((k) => !["name", "overlay"].includes(k))) return null;
    const name = value.profile.name;
    if (name != null && (typeof name !== "string" || !name || [...name].length > 64)) return null;
    overlay = switches(value.profile.overlay);
  }
  return { enabled: switches(value.enabled), overlay };
}

/** The explicit switch for `id`, or null when the file leaves the manifest default. Corruption is null. */
export function explicitPluginChoice(stateDir: string, id: string): boolean | null {
  try {
    const choices = readChoices(stateDir);
    if (!choices) return null;
    if (Object.hasOwn(choices.enabled, id)) return choices.enabled[id] ?? null;
    if (Object.hasOwn(choices.overlay, id)) return choices.overlay[id] ?? null;
    return null;
  } catch { return null; }
}

export function effectivePlugins(projectRoot: string, stateDir: string): (id: string) => boolean {
  const manifests = new Map(loadManifests(projectRoot).map((item) => [item.id, item as unknown as Record<string, unknown>]));
  return (id: string): boolean => {
    try {
      const choices = readChoices(stateDir);
      if (!choices) return false;
      const chosen = choices.enabled;
      const overlay = choices.overlay;
      const resolve = (current: string, visiting: Set<string>): boolean => {
        const manifest = manifests.get(current);
        if (!manifest || visiting.has(current)) return false;
        // An optional feature package is available once its marketplace marker
        // is installed; the marker grants availability, never code or permissions.
        if (typeof manifest.installPackage === "string" ? !packageInstalled(stateDir, current, manifest.installPackage) : manifest.installPackage) return false;
        if (!(chosen[current] ?? overlay[current] ?? manifest.defaultEnabled === true)) return false;
        const next = new Set(visiting).add(current);
        return (Array.isArray(manifest.dependencies) ? manifest.dependencies : []).every((dep) => typeof dep === "string" && resolve(dep, next));
      };
      return resolve(id, new Set());
    } catch { return false; }
  };
}

/** `plugin_runtime._resolve_items`: the marketplace marker `(packageId, builtin)` is installed. */
export function packageInstalled(stateDir: string, pluginId: string, packageId: string): boolean {
  try { return loadDataManifests(stateDir).some((item) => item.id === packageId && item.builtin === pluginId); } catch { return false; }
}
