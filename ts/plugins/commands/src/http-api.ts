/**
 * Commands HTTP surface (Python `files_api.py` plus the generic resource store
 * for kind `commands`): `GET /api/resources/commands/files` lists the merged
 * rows for one fenced workspace root; `GET/POST/PUT /api/resources/commands`
 * and `PATCH/DELETE /api/resources/commands/<id>` manage the JSON store.
 */
import { isAbsolute, join, relative } from "node:path";
import { realish, resourceDispatch } from "@xueness/sessions";
import { listAll, EXPAND_MAX_CHARS } from "./commands.ts";
import { BODY_PREVIEW_CHARS, MAX_COMMAND_FILE_BYTES, MAX_COMMANDS_PER_ROOT } from "./file-commands.ts";

export interface CommandsApiOptions {
  stateDir: string;
  webRuns: string;
  projectDir: string;
  enabled(id: string): boolean;
  /** `workspaces_api.allowed_roots`: operator-declared and remembered workspace roots. */
  allowedRoots(): readonly string[];
  manifestCommands: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}
type Reply = [number, unknown];
export const COMMANDS_ROUTES = ["GET /api/resources/commands", "POST /api/resources/commands", "PUT /api/resources/commands", "PATCH /api/resources/commands/:id", "DELETE /api/resources/commands/:id", "GET /api/resources/commands/files"];

/** `parse_qs` drops blank values: the first non-blank one, or "". */
export const queryValue = (query: Record<string, readonly string[] | undefined>, name: string): string => (Object.hasOwn(query, name) ? query[name] ?? [] : []).find((value) => value !== "") ?? "";

/** `web._allowed_root`: relative roots live under web runs; the target must sit inside a permitted base. */
export function fencedRoot(value: string, o: Pick<CommandsApiOptions, "webRuns" | "projectDir" | "allowedRoots">): string {
  if (value.includes("\0")) throw new Error("embedded null byte");
  const target = realish(isAbsolute(value) ? value : join(realish(o.webRuns), value));
  const roots = [o.webRuns, o.projectDir, ...o.allowedRoots()].map((root) => realish(root));
  if (!roots.some((root) => { const rel = relative(root, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); })) throw new Error("workspace root not permitted");
  return target;
}

export function createCommandsApi(o: CommandsApiOptions) {
  const owns = (method: string, p: readonly string[]): boolean => p[0] === "api" && p[1] === "resources" && p[2] === "commands"
    && (p.length === 4 && p[3] === "files" || p.length === 3 && ["GET", "POST", "PUT"].includes(method) || p.length === 4 && ["PATCH", "DELETE"].includes(method));
  const files = (method: string, query: Record<string, readonly string[] | undefined>): Reply => {
    if (method !== "GET") return [405, { error: "method not allowed" }];
    const raw = queryValue(query, "root"), language = queryValue(query, "language"), stateDir = realish(o.stateDir);
    let root: string | null = null;
    if (raw) { try { root = fencedRoot(raw, o); } catch { return [400, { error: "workspace root not permitted" }]; } }
    let document: ReturnType<typeof listAll>;
    try { document = listAll({ stateDir, root, language, manifestCommands: o.manifestCommands, ...(o.env ? { env: o.env } : {}) }); }
    catch { return [500, { error: "command roots could not be read" }]; }
    return [200, { root, stateDir, commands: document.commands, diagnostics: document.diagnostics,
      limits: { expandChars: EXPAND_MAX_CHARS, previewChars: BODY_PREVIEW_CHARS, commandFileBytes: MAX_COMMAND_FILE_BYTES, commandsPerRoot: MAX_COMMANDS_PER_ROOT } }];
  };
  return {
    routes: COMMANDS_ROUTES,
    owns,
    /** Stored command documents keep Python's exact numbers (`1.0`, large integers). */
    lossless: (method: string, p: readonly string[]): boolean => owns(method, p) && !(p.length === 4 && p[3] === "files"),
    async dispatch(method: string, p: string[], query: Record<string, readonly string[] | undefined>, data: unknown): Promise<Reply | null> {
      if (!owns(method, p)) return null;
      if (!o.enabled("commands")) return [403, { error: "plugin disabled or dependency unavailable: commands", plugin: "commands", code: "plugin_disabled" }];
      if (p.length === 4 && p[3] === "files") return files(method, query);
      return resourceDispatch(realish(o.stateDir), method, p, data);
    },
  };
}
