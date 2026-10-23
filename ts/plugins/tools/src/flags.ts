/** Settings and plugin-switch readers. Both experimental flags default off. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, isPyIntValue, pyJsonLoads } from "@xueness/contracts";
import { isLink } from "@xueness/sessions";

const ENV_TRUE = new Set(["1", "true", "yes", "on"]);
let pluginEnabled: (id: string) => boolean = () => true;

export function bindPluginEnabled(check: (id: string) => boolean): void {
  pluginEnabled = check;
}

export function toolsPluginOn(stateDir: string | null): boolean {
  if (stateDir === null) return true;
  return pluginEnabled("tools");
}

function document(stateDir: string, name: string): Record<string, unknown> | null {
  const path = join(stateDir, name);
  try {
    if (isLink(path)) return null;
    const value = pyJsonLoads(readFileSync(path, "utf8"));
    return isDict(value) ? value : null;
  } catch { return null; }
}

export function generalFlag(stateDir: string, key: string): boolean {
  const general = document(stateDir, "settings.json")?.general;
  return isDict(general) && general[key] === true;
}

export function dryRunOn(stateDir: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = ENV_TRUE.has(String(env.XUENESS_TOOLS_DRY_RUN ?? "").trim().toLowerCase());
  const flagged = override || (stateDir !== null && generalFlag(stateDir, "toolsDryRunEnabled"));
  return flagged && toolsPluginOn(override && stateDir === null ? null : stateDir);
}

export function budgetConfig(stateDir: string | null): { enabled: boolean; limit: number } {
  if (stateDir === null || !toolsPluginOn(stateDir) || !generalFlag(stateDir, "toolsCallBudgetEnabled")) return { enabled: false, limit: 100 };
  const general = document(stateDir, "settings.json")?.general;
  const limit = isDict(general) ? general.toolsCallBudgetLimit : undefined;
  return { enabled: true, limit: isPyIntValue(limit) && typeof limit === "number" && limit >= 1 && limit <= 10_000 ? limit : 100 };
}

export function turnId(session: Record<string, unknown>): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!isDict(item) || item.role !== "user" || item._input_kind === "guide") continue;
    if (typeof item._turn_id === "string") return item._turn_id;
    break;
  }
  const count = messages.filter((item) => isDict(item) && item.role === "user" && item._input_kind !== "guide").length;
  return `turn-${Math.max(1, count)}`;
}
