/**
 * Workspace hook discovery and declaration digests (Python
 * `bundled_plugins/hooks/workspace_hooks.py`: `discover`, `_parse_native`,
 * `_parse_compat`, `_row`). Read-only, never executes anything, never raises.
 *
 *   <workspace>/.xueness/hooks.json   project        (flat list)
 *   <workspace>/.zcode/config.json    project-compat (ZCode nested `hooks`)
 *   <workspace>/.xueness/config.json project-compat (ZCode nested `hooks`)
 *
 * A ZCode `command` (shell string) declaration is reported, never run.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { hostRelativeTo, isLink, lexists, readCapped, real, utf8 } from "./files.ts";
import { isHookEvent, strip, type Row } from "./load.ts";

export const DIGEST_VERSION = 1;
export const MAX_HOOKS_FILE_BYTES = 256 * 1024;
export const MAX_HOOKS_PER_SOURCE = 64;
export const MAX_HOOKS_PER_WORKSPACE = 128;
export const MAX_MATCHER_GROUPS_PER_EVENT = 32;
// Append new sources only: sourceIndex participates in legacy default IDs and digests.
const SOURCES = [["project", ".xueness", "hooks.json"], ["project-compat", ".zcode", "config.json"], ["project-compat", ".xueness", "config.json"]] as const;

export interface Diagnostic { code: string; severity: string; message: string; path?: string }
export const diagnostic = (code: string, severity: string, message: string, path?: string): Diagnostic => path === undefined ? { code, severity, message } : { code, severity, message, path };

/** `canonical_workspace`: the resolved absolute workspace, or null. */
export function canonicalWorkspace(root: unknown): string | null {
  if (typeof root !== "string" || !root) return null;
  const home = process.env.HOME ?? "";
  const expanded = root === "~" ? home : root.startsWith("~/") && home ? join(home, root.slice(2)) : root;
  return real(expanded);
}

export function sha256Payload(payload: unknown): string {
  return createHash("sha256").update(pyJsonDumps(payload, { separators: [",", ":"] }), "utf8").digest("hex");
}

/** The command as shown for review: argv joined, never interpreted. */
export function displayCommand(row: Row): string {
  const parts = [String(row.command || ""), ...(Array.isArray(row.args) ? row.args.map(String) : [])];
  return parts.filter(Boolean).join(" ");
}

/** Python `round()` (half to even). */
function pyRound(value: number): number {
  const floor = Math.floor(value); const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
const isNumber = (value: unknown): value is number => typeof value === "number";

interface Place { sourceIndex: number; workspace: string; sourcePath: string; sourceRelative: string }
function row(fields: { id: string; event: string; matcher: string | null; command: string; args: string[] | null; timeout: number | null; timeoutMs: number | null; enabled: boolean; pipeline: boolean; source: string; index: number }, place: Place): Row {
  const ms = fields.timeoutMs !== null ? pyRound(fields.timeoutMs) : fields.timeout !== null ? pyRound(fields.timeout * 1000) : null;
  const digest = sha256Payload(["xueness-workspace-hook-declaration", DIGEST_VERSION, place.sourceRelative, fields.index, fields.id, fields.event, fields.matcher, fields.command, fields.args ?? [], ms, fields.pipeline]);
  const out: Row = { id: fields.id, event: fields.event, command: fields.command, enabled: fields.enabled, source: fields.source, index: fields.index,
    sourceIndex: place.sourceIndex, sourcePath: place.sourcePath, sourceRelative: place.sourceRelative, workspace: place.workspace, digest };
  if (fields.matcher) out.matcher = fields.matcher;
  if (fields.args) out.args = [...fields.args];
  if (fields.timeout !== null) out.timeout = fields.timeout;
  else if (fields.timeoutMs !== null) out.timeout = pyRound(fields.timeoutMs) / 1000;
  if (fields.pipeline) out.pipeline = true;
  return out;
}

function argsOf(value: unknown): string[] | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string")) return "invalid";
  return value.length ? value as string[] : null;
}

function nativeEntry(entry: unknown, index: number, place: Place): Row | string {
  if (!isDict(entry)) return "hook_invalid_shape";
  let id = entry.id;
  if (id === undefined || id === null) id = `workspace-hook-${place.sourceIndex}-${index}`;
  else if (typeof id !== "string" || !strip(id)) return "hook_invalid_id";
  if (!isHookEvent(entry.event)) return "hook_invalid_event";
  if (typeof entry.command !== "string" || !strip(entry.command)) return "hook_invalid_command";
  const args = argsOf(entry.args); if (args === "invalid") return "hook_invalid_args";
  let matcher = entry.matcher ?? null;
  if (matcher !== null && typeof matcher !== "string") return "hook_invalid_matcher";
  if (matcher === "") matcher = null;
  const timeout = entry.timeout ?? null;
  if (timeout !== null && (!isNumber(timeout) || timeout <= 0)) return "hook_invalid_timeout";
  const enabled = entry.enabled ?? true; if (typeof enabled !== "boolean") return "hook_invalid_enabled";
  const pipeline = entry.pipeline ?? false; if (typeof pipeline !== "boolean") return "hook_invalid_pipeline";
  return row({ id: strip(id as string), event: entry.event, matcher: matcher as string | null, command: entry.command, args, timeout: timeout as number | null, timeoutMs: null, enabled, pipeline, source: "project", index }, place);
}

function parseNative(document: unknown, place: Place, diagnostics: Diagnostic[]): Row[] {
  const entries = Array.isArray(document) ? document : isDict(document) && Array.isArray(document.hooks) ? document.hooks : null;
  if (!entries) { diagnostics.push(diagnostic("hook_invalid_shape", "error", "hooks.json must hold a list of hook entries", place.sourcePath)); return []; }
  const rows: Row[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (rows.length >= MAX_HOOKS_PER_SOURCE) { diagnostics.push(diagnostic("hook_limit", "warning", `only the first ${MAX_HOOKS_PER_SOURCE} hooks are read from this file`, place.sourcePath)); break; }
    const parsed = nativeEntry(entries[index], index, place);
    if (typeof parsed === "string") { diagnostics.push(diagnostic(parsed, "error", `hook entry ${index} was refused`, place.sourcePath)); continue; }
    rows.push(parsed);
  }
  return rows;
}

function compatEntry(hook: unknown, event: string, matcher: string | null, index: number, place: Place, rootEnabled: boolean, rootTimeoutMs: number | null): Row | string {
  if (!isDict(hook)) return "hook_invalid_shape";
  if (hook.type === "command") return "hook_unsupported_type";
  if (hook.type !== "process") return "hook_invalid_shape";
  if (typeof hook.command !== "string" || !strip(hook.command)) return "hook_invalid_command";
  const args = argsOf(hook.args); if (args === "invalid") return "hook_invalid_args";
  let timeoutMs = hook.timeoutMs ?? null;
  if (timeoutMs === null) timeoutMs = rootTimeoutMs;
  else if (!isNumber(timeoutMs) || timeoutMs <= 0) return "hook_invalid_timeout";
  const enabled = hook.enabled ?? true; if (typeof enabled !== "boolean") return "hook_invalid_enabled";
  return row({ id: `workspace-hook-${place.sourceIndex}-${index}`, event, matcher, command: hook.command, args, timeout: null, timeoutMs: timeoutMs as number | null, enabled: rootEnabled && enabled, pipeline: false, source: "project-compat", index }, place);
}

function parseCompat(document: unknown, place: Place, diagnostics: Diagnostic[]): Row[] | null {
  if (!isDict(document) || !Object.hasOwn(document, "hooks")) return null;
  const hooks = document.hooks;
  const refuse = (message: string): Row[] => { diagnostics.push(diagnostic("hook_invalid_shape", "error", message, place.sourcePath)); return []; };
  if (!isDict(hooks)) return refuse("the hooks value must be an object");
  const rootEnabled = hooks.enabled ?? true;
  if (typeof rootEnabled !== "boolean") return refuse("hooks.enabled must be a boolean");
  const timeoutMs = hooks.timeoutMs ?? null;
  if (timeoutMs !== null && (!isNumber(timeoutMs) || timeoutMs <= 0)) return refuse("hooks.timeoutMs must be a positive number");
  const events = hooks.events ?? null;
  if (events === null) return [];
  if (!isDict(events)) return refuse("hooks.events must be an object");
  const rows: Row[] = [];
  let index = 0;
  for (const [event, value] of Object.entries(events)) {
    if (!isHookEvent(event)) { diagnostics.push(diagnostic("hook_invalid_event", "error", `unknown hook event: ${event}`, place.sourcePath)); continue; }
    if (!Array.isArray(value)) { diagnostics.push(diagnostic("hook_invalid_shape", "error", `event ${event} must hold a list of matcher groups`, place.sourcePath)); continue; }
    let groups = value;
    if (groups.length > MAX_MATCHER_GROUPS_PER_EVENT) {
      groups = groups.slice(0, MAX_MATCHER_GROUPS_PER_EVENT);
      diagnostics.push(diagnostic("hook_limit", "warning", `only the first ${MAX_MATCHER_GROUPS_PER_EVENT} matcher groups are read for ${event}`, place.sourcePath));
    }
    for (const group of groups) {
      if (!isDict(group) || !Array.isArray(group.hooks) || !group.hooks.length) { diagnostics.push(diagnostic("hook_invalid_shape", "error", `matcher group under ${event} is unusable`, place.sourcePath)); continue; }
      let matcher = group.matcher ?? null;
      if (matcher !== null && typeof matcher !== "string") { diagnostics.push(diagnostic("hook_invalid_matcher", "error", `matcher under ${event} must be a string`, place.sourcePath)); continue; }
      if (matcher === "") matcher = null;
      for (const hook of group.hooks) {
        if (rows.length >= MAX_HOOKS_PER_SOURCE) {
          diagnostics.push(diagnostic("hook_limit", "warning", `only the first ${MAX_HOOKS_PER_SOURCE} hooks are read from this file`, place.sourcePath));
          return rows;
        }
        const parsed = compatEntry(hook, event, matcher as string | null, index, place, rootEnabled, timeoutMs as number | null);
        index += 1;
        if (typeof parsed === "string") { diagnostics.push(diagnostic(parsed, "error", `hook declaration under ${event} was refused`, place.sourcePath)); continue; }
        rows.push(parsed);
      }
    }
  }
  return rows;
}

export interface Discovery { hooks: Row[]; diagnostics: Diagnostic[]; sources: Row[]; bundleDigest: string | null; workspace: string | null }

/** Every usable workspace hook declaration; read-only, never raises. */
export function discover(root: unknown): Discovery {
  const workspace = canonicalWorkspace(root);
  const rows: Row[] = []; const diagnostics: Diagnostic[] = []; const sources: Row[] = [];
  if (workspace === null) return { hooks: [], diagnostics, sources, bundleDigest: null, workspace: null };
  SOURCES.forEach(([kind, dirName, fileName], sourceIndex) => {
    const directory = join(workspace, dirName);
    if (lexists(directory) && isLink(directory)) { diagnostics.push(diagnostic("hook_root_symlink", "error", `${dirName} must not be a link`, directory)); return; }
    const path = join(directory, fileName);
    if (!lexists(path)) return;
    if (isLink(path)) { diagnostics.push(diagnostic("hook_file_symlink", "error", `${fileName} must not be a link`, path)); return; }
    const resolved = real(path);
    const relative = resolved === null ? null : hostRelativeTo(resolved, workspace);
    if (relative === null) { diagnostics.push(diagnostic("hook_escapes_workspace", "error", "hook file resolves outside the workspace", path)); return; }
    const raw = readCapped(path, MAX_HOOKS_FILE_BYTES);
    const failure = raw === null ? "hook_unreadable" : raw.length > MAX_HOOKS_FILE_BYTES ? "hook_file_too_large" : null;
    const text = raw && !failure ? utf8(raw) : null;
    if (failure || text === null) { diagnostics.push(diagnostic(failure ?? "hook_invalid_encoding", "error", `${fileName} could not be read`, path)); return; }
    let document: unknown;
    try { document = pyJsonLoads(text); } catch { diagnostics.push(diagnostic("hook_invalid_json", "error", `${fileName} is not valid JSON`, path)); return; }
    const place: Place = { sourceIndex, workspace, sourcePath: path, sourceRelative: relative };
    let parsed: Row[] | null; let sourceEnabled = true;
    if (kind === "project") parsed = parseNative(document, place, diagnostics);
    else {
      parsed = parseCompat(document, place, diagnostics);
      if (isDict(document) && isDict(document.hooks)) { const declared = document.hooks.enabled; sourceEnabled = typeof declared === "boolean" ? declared : true; }
    }
    if (parsed === null) return;
    if (rows.length + parsed.length > MAX_HOOKS_PER_WORKSPACE) {
      parsed = parsed.slice(0, MAX_HOOKS_PER_WORKSPACE - rows.length);
      diagnostics.push(diagnostic("hook_limit", "warning", `only the first ${MAX_HOOKS_PER_WORKSPACE} workspace hooks are read`, path));
    }
    sources.push({ kind, path: relative, file: path, enabled: sourceEnabled });
    rows.push(...parsed);
  });
  const seen = new Set<string>(); const unique: Row[] = [];
  for (const item of rows) {
    const id = String(item.id);
    if (seen.has(id)) { diagnostics.push(diagnostic("hook_duplicate_id", "error", `duplicate workspace hook id: ${id}`, String(item.sourcePath))); continue; }
    seen.add(id); unique.push(item);
  }
  const bundleDigest = unique.length ? sha256Payload(["xueness-workspace-hook-bundle", DIGEST_VERSION, sources.map((source) => [source.path, source.kind, source.enabled]), unique.map((item) => [item.digest, item.enabled])]) : null;
  return { hooks: unique, diagnostics, sources, bundleDigest, workspace };
}
