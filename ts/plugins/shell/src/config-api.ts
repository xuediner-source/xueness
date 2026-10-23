/** State-bound shell configuration; saving never executes initialization code. */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict } from "@xueness/contracts";
import { writeFileAtomic } from "@xueness/engine-tools";
import { shellConfig, type ShellConfig } from "./index.ts";

function settingsPath(stateDir: string): string {
  const path = join(stateDir, "shell-config.json");
  try { if (!lstatSync(path).isFile()) throw new TypeError("shell config must be a regular file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path;
}

export function loadShellConfig(stateDir: string): ShellConfig {
  const path = settingsPath(stateDir);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (value !== undefined && !isDict(value)) throw new TypeError("shell config must be an object");
  return shellConfig(value);
}

export function createShellSettingsApi(options: { stateDir: string; enabled(id: string): boolean }) {
  const owns = (_method: string, parts: readonly string[]) => parts.length === 3 && parts[0] === "api" && parts[1] === "shell" && parts[2] === "settings";
  return {
    owns, routes: ["GET /api/shell/settings", "POST /api/shell/settings"],
    async dispatch(method: string, parts: readonly string[], _query: unknown, data: unknown): Promise<[number, unknown] | null> {
      if (!owns(method, parts)) return null;
      if (!options.enabled("shell")) return [403, { error: "plugin disabled: shell" }];
      if (method !== "GET" && method !== "POST") return [405, { error: "method not allowed" }];
      try {
        if (method === "GET") return [200, { settings: loadShellConfig(options.stateDir) }];
        if (!isDict(data)) return [400, { error: "settings must be an object" }];
        const settings = shellConfig({ ...loadShellConfig(options.stateDir), ...data });
        await writeFileAtomic(settingsPath(options.stateDir), Buffer.from(JSON.stringify(settings, null, 2) + "\n"), { mode: 0o600 });
        return [200, { settings }];
      } catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) return [400, { error: error.message }];
        throw error;
      }
    },
  };
}
