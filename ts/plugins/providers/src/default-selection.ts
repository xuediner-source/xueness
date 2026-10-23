import { closeSync, existsSync, fsyncSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { isLink, mkstemp, readRegularBytes, replaceFile, writeAll } from "@xueness/sessions";
import { ProfileStore, REASONING_LEVELS, validId, type Dict, type Reply } from "./profile-store.ts";
import { validateEffort } from "./provider-config.ts";

export function loadSettings(stateDir: string): Dict {
  const path = join(stateDir, "settings.json");
  if (isLink(path)) return {};
  try { const v = pyJsonLoads(readRegularBytes(path).toString("utf8")); return isDict(v) ? v : {}; } catch { return {}; }
}
function updateSettings(stateDir: string, mutate: (settings: Dict) => void): void {
  const settings = loadSettings(stateDir); mutate(settings);
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "settings.json");
  if (isLink(path)) throw new PyValueError("settings file must not be a link");
  const temp = mkstemp(stateDir, ".settings-");
  let fd: number | null = temp.fd;
  try { writeAll(fd, Buffer.from(pyJsonDumps(settings, { indent: 2 }))); fsyncSync(fd); closeSync(fd); fd = null; replaceFile(temp.path, path); }
  finally { if (fd !== null) closeSync(fd); if (existsSync(temp.path)) unlinkSync(temp.path); }
}
export function loadDefault(store: ProfileStore): Dict {
  const raw = loadSettings(store.stateDir).modelDefault;
  if (!isDict(raw)) return {};
  const providerId = validId(raw.providerId) ? raw.providerId : null;
  const model = typeof raw.model === "string" && pyStrip(raw.model) && pyLen(raw.model) <= 200 ? raw.model : null;
  const reasoningEffort = typeof raw.reasoningEffort === "string" && REASONING_LEVELS.includes(raw.reasoningEffort) ? raw.reasoningEffort : null;
  if (providerId === null && model === null || providerId && !store.record(providerId)) return {};
  const result: Dict = { providerId, model, reasoningEffort };
  if (typeof raw.updatedAt === "string" && pyStrip(raw.updatedAt)) result.updatedAt = pyStrip(raw.updatedAt);
  return result;
}
export function defaultSelection(method: string, data: unknown, store: ProfileStore): Reply | null {
  if (method === "GET") { const selection = loadDefault(store); return [200, { default: Object.keys(selection).length ? selection : null }]; }
  if (method !== "POST") return null;
  if (!isDict(data)) return [400, { error: "body must be a JSON object" }];
  if (Object.keys(data).join(",") === "clear" && data.clear === true) {
    let cleared = false;
    updateSettings(store.stateDir, (settings) => { cleared = Object.hasOwn(settings, "modelDefault"); delete settings.modelDefault; });
    return [200, { default: null, cleared }];
  }
  try {
    const unknown = Object.keys(data).filter((k) => !["providerId", "provider_id", "model", "reasoningEffort", "reasoning_effort"].includes(k)).sort();
    if (unknown.length) throw new PyValueError("unknown selection keys: " + unknown.join(", "));
    const clean = (v: unknown, max = 200): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") throw new PyValueError("model selection values must be strings");
      const s = pyStrip(v);
      if (!s) return null;
      if (pyLen(s) > max) throw new PyValueError("model selection value is too long");
      return s;
    };
    const id = clean(Object.hasOwn(data, "providerId") ? data.providerId : data.provider_id, 64);
    const model = clean(data.model);
    const effort = clean(Object.hasOwn(data, "reasoningEffort") ? data.reasoningEffort : data.reasoning_effort);
    if (!id && !model) throw new PyValueError("a default selection needs a provider id or a model");
    const profile = id ? store.record(id) : null;
    if (id && !profile) throw new PyValueError("provider profile not found");
    if (profile?.protocol === "anthropic" && effort) throw new PyValueError("Anthropic provider does not declare reasoning-effort support");
    validateEffort(model || profile?.model, profile?.reasoningLevels, effort, profile?.baseUrl ?? process.env.XUENESS_API_BASE);
    const selection = { providerId: id, model, reasoningEffort: effort, updatedAt: new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z") };
    updateSettings(store.stateDir, (settings) => { settings.modelDefault = selection; });
    return [200, { default: selection }];
  } catch (error) { if ((error as Error).name === "ValueError") return [400, { error: (error as Error).message }]; throw error; }
}
