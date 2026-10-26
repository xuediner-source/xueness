/**
 * File-shaped commands (Python `file_commands.py`): `<name>.md` with at most one
 * namespace directory, read from the project root, its `.zcode` compatibility
 * root and the user state root. Links are refused at every level, every file
 * is bounded, and a problem is a diagnostic row instead of an exception.
 */
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pyLen, pySlice, pyStr, pyStrip, pyTruthy } from "@xueness/contracts";
import { pyCodeCompare, pyOSErrorText } from "@xueness/sessions";
import { BUILTIN_SOURCE, isBuiltinName } from "./builtin-prompts.ts";
import { extraCommandRoots, namespacedCommandName } from "./extra-roots.ts";
import { DESCRIPTION_MAX_CHARS, firstLineDescription, parseFrontmatter, stripFrontmatter } from "./frontmatter.ts";
import { contained, isDir, isLink, readText, real } from "./paths.ts";

export type Row = Record<string, unknown>;
export interface Diagnostic { code: string; severity: string; message: string; path?: string }
export const MAX_COMMAND_FILE_BYTES = 64 * 1024;
export const MAX_COMMANDS_PER_ROOT = 64;
export const BODY_PREVIEW_CHARS = 2000;
const ARGUMENT_HINT_MAX_CHARS = 128;
const SEGMENT = "[A-Za-z0-9._-]{1,64}";
// Python `re.match("^...$")`: `$` also matches before one trailing newline.
const SEGMENT_RE = new RegExp(`^${SEGMENT}\\n?$`);
const NAME_RE = new RegExp(`^${SEGMENT}(?::${SEGMENT})?\\n?$`);
const SUPPORTED_KEYS = new Set(["description", "argument-hint", "model"]);
const PRIORITY = new Map<unknown, number>([["builtin", -1], ["project", 0], ["project-compat", 1], ["user", 2], ["extra", 3], ["resource", 4]]);
const SCOPE = new Map<string, string>([["builtin", "builtin"], ["project", "project"], ["project-compat", "project"], ["user", "user"], ["extra", "extra"], ["resource", "resource"]]);
/** In-chat builtin slash commands a file command can never take over. */
export const CHAT_BUILTIN_NAMES: ReadonlySet<string> = new Set(["attach", "attachments", "compact", "detach", "dwf", "effort", "end", "exit", "expert", "help", "mode", "model", "models", "paste", "paste-image", "quit", "retry", "skills", "status"]);
const INLINE_SHELL_RE = /!`[^`\n]*`/;
const FENCED_SHELL_RE = /```!\s*[\s\S]*?```/;

export function diagnostic(code: string, severity: string, message: string, path?: string | null): Diagnostic {
  return path == null ? { code, severity, message } : { code, severity, message, path };
}

const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith(".md");
const usableSegment = (stem: string): boolean => stem !== "." && stem !== ".." && SEGMENT_RE.test(stem);
const bounded = (value: unknown, max: number): string => pySlice(pyStrip(pyStr(pyTruthy(value) ? value : "")), max);

/** `is_valid_name`: `name` or `namespace:name`, never `.`/`..` segments. */
export function isValidName(name: unknown): name is string {
  if (typeof name !== "string" || !name || pyLen(name) > 64 || !NAME_RE.test(name)) return false;
  return name.split(":").every((segment) => segment !== "." && segment !== "..");
}

/** `is_reserved`: chat builtins, built-in prompts and names a plugin manifest already claims. */
export function isReserved(name: unknown, manifestCommands: ReadonlySet<string>): boolean {
  const plain = pyStr(pyTruthy(name) ? name : "").replace(/^\/+/, "");
  return CHAT_BUILTIN_NAMES.has(plain) || isBuiltinName(plain) || !!plain && manifestCommands.has(plain);
}

export function frontmatterFindings(values: Map<string, string>, keys: readonly string[], path: string): Diagnostic[] {
  const findings: Diagnostic[] = [];
  for (const key of new Set(keys)) if (!SUPPORTED_KEYS.has(key)) findings.push(diagnostic("command_unsupported_frontmatter", "warning", `frontmatter key ${key} is ignored by Xueness commands: ${basename(path)}`, path));
  if (values.has("model")) findings.push(diagnostic("command_model_not_applied", "info", `model ${bounded(values.get("model"), 128)} is shown for reference only and never selects a model`, path));
  return findings;
}

export function shellExpansionFindings(body: string, path: string): Diagnostic[] {
  const findings: Diagnostic[] = [];
  if (INLINE_SHELL_RE.test(body)) findings.push(diagnostic("command_shell_expansion_unsupported", "warning", "inline !`…` shell expansion is not supported; the text stays literal and no command is run", path));
  if (FENCED_SHELL_RE.test(body)) findings.push(diagnostic("command_shell_expansion_unsupported", "warning", "fenced ```! shell expansion is not supported; the text stays literal and no command is run", path));
  return findings;
}

/** `command_roots`: `(source, base, jail)` per root, project before compat before user. */
export function commandRoots(stateDir: string, root: string | null, includeCompat = true): [string, string, string][] {
  const items: [string, string, string][] = [];
  const jail = real(stateDir);
  if (root != null) {
    const workspace = real(root);
    if (workspace !== null) {
      items.push(["project", join(workspace, ".xueness", "commands"), workspace]);
      if (includeCompat) items.push(["project-compat", join(workspace, ".zcode", "commands"), workspace]);
    }
  }
  if (jail !== null && !isLink(stateDir)) items.push(["user", join(jail, "commands"), jail]);
  return items;
}

function listing(directory: string, diagnostics: Diagnostic[], code: string): string[] {
  try { return readdirSync(directory).sort(pyCodeCompare); } catch (error) {
    diagnostics.push(diagnostic(code, "warning", "command directory could not be listed: " + pyOSErrorText(error, directory), directory));
    return [];
  }
}

function commandFiles(base: string, diagnostics: Diagnostic[]): [string, string][] {
  const found: [string, string][] = [];
  for (const name of listing(base, diagnostics, "command_root_unreadable")) {
    if (name.startsWith(".")) continue;
    const entry = join(base, name);
    if (isLink(entry)) { diagnostics.push(diagnostic("command_entry_symlink", "warning", `command entry must not be a link: ${name}`, entry)); continue; }
    if (isDir(entry)) {
      if (!usableSegment(name)) { diagnostics.push(diagnostic("command_invalid_namespace", "warning", `command namespace is not usable: ${name}`, entry)); continue; }
      for (const childName of listing(entry, diagnostics, "command_namespace_unreadable")) {
        if (childName.startsWith(".")) continue;
        const child = join(entry, childName);
        if (isLink(child)) { diagnostics.push(diagnostic("command_file_symlink", "warning", `command file must not be a link: ${childName}`, child)); continue; }
        if (isDir(child)) { diagnostics.push(diagnostic("command_namespace_too_deep", "warning", `only one namespace level is read: ${name}/${childName}`, child)); continue; }
        if (isMarkdown(childName)) found.push([`${name}:${childName.slice(0, -3)}`, child]);
      }
    } else if (isMarkdown(name)) found.push([name.slice(0, -3), entry]);
  }
  return found.filter(([name, path]) => {
    if (isValidName(name)) return true;
    diagnostics.push(diagnostic("command_invalid_name", "error", `command name is not usable: ${basename(path)}`, path));
    return false;
  });
}

function readEntry(source: string, base: string, name: string, path: string): [Row | null, Diagnostic[]] {
  if (isLink(path)) return [null, [diagnostic("command_file_symlink", "warning", `command file must not be a link: ${name}`, path)]];
  const resolved = real(path);
  if (resolved === null || !contained(resolved, base)) return [null, [diagnostic("command_escapes_root", "error", `command path leaves its command root: ${name}`, path)]];
  const read = readText(path, MAX_COMMAND_FILE_BYTES);
  if (read.failure || read.text === null) {
    const detail = read.failure === "command_file_too_large" && read.size ? ` (${read.size} bytes)` : "";
    return [null, [diagnostic(read.failure ?? "command_unreadable", "error", `command file could not be read as text${detail}: ${name}`, path)]];
  }
  const front = parseFrontmatter(read.text);
  if (front.error) return [null, [diagnostic(front.error, "error", `command frontmatter is unusable: ${name}`, path)]];
  const body = pyStrip(stripFrontmatter(read.text));
  if (!body) return [null, [diagnostic("command_empty_body", "error", `command file has no body to expand: ${name}`, path)]];
  const findings = [...frontmatterFindings(front.values, front.keys, path), ...shellExpansionFindings(body, path)];
  const description = bounded(front.values.get("description"), DESCRIPTION_MAX_CHARS) || firstLineDescription(body);
  return [{ id: name, name, description, argumentHint: bounded(front.values.get("argument-hint"), ARGUMENT_HINT_MAX_CHARS), model: bounded(front.values.get("model"), 128),
    frontmatterKeys: [...new Set(front.keys)], source, scope: SCOPE.get(source) ?? "user", path, directory: dirname(path), rootPath: base, bytes: read.size ?? 0, body,
    shadowed: false, shadowedBy: null }, findings];
}

function scanRoot(source: string, base: string, jail: string, diagnostics: Diagnostic[], limit: number, namespace: string | null): Row[] {
  if (isLink(base)) { diagnostics.push(diagnostic("command_root_symlink", "error", "command root must not be a link", base)); return []; }
  const resolved = real(base);
  if (resolved === null) { diagnostics.push(diagnostic("command_root_unreadable", "warning", "command root could not be resolved", base)); return []; }
  if (!contained(resolved, jail)) { diagnostics.push(diagnostic("command_root_escapes", "error", "command root resolves outside its workspace", base)); return []; }
  if (!isDir(base)) return [];
  const rows: Row[] = [];
  for (const [plain, path] of commandFiles(resolved, diagnostics)) {
    // A namespaced extra root prefixes every command it holds (`namespace:name`);
    // a prefixed name that stops being a valid single-colon name is refused, not listed.
    const name = namespace === null ? plain : namespacedCommandName(namespace, plain);
    if (namespace !== null && !isValidName(name)) { diagnostics.push(diagnostic("command_invalid_name", "error", `command name is not usable: ${name}`, path)); continue; }
    const [row, findings] = readEntry(source, resolved, name, path);
    diagnostics.push(...findings);
    if (row === null) continue;
    if (rows.length >= limit) { diagnostics.push(diagnostic("command_root_limit", "warning", `only the first ${limit} commands are read from this root`, base)); break; }
    rows.push(row);
  }
  return rows;
}

export function discover(stateDir: string, root: string | null, includeCompat = true, limit = MAX_COMMANDS_PER_ROOT): { commands: Row[]; diagnostics: Diagnostic[] } {
  const commands: Row[] = [], diagnostics: Diagnostic[] = [];
  for (const [source, base, jail] of commandRoots(stateDir, root, includeCompat)) commands.push(...scanRoot(source, base, jail, diagnostics, limit, null));
  // F07.04: operator-listed extra directories, each its own jail, after the workspace roots.
  for (const extra of extraCommandRoots(stateDir)) {
    if (extra.base === "") { diagnostics.push(...extra.diagnostics); continue; }
    commands.push(...scanRoot("extra", extra.base, extra.jail, diagnostics, limit, extra.namespace));
  }
  return { commands, diagnostics };
}

/** `merge`: one winner per invocation name; losers stay listed with who shadowed them. */
export function merge(resourceRows: readonly Row[], fileRows: readonly Row[], manifestCommands: ReadonlySet<string>): Row[] {
  const keyed = [...fileRows, ...resourceRows].map((row, index) => ({ row, index, id: pyStr(pyTruthy(row.id) ? row.id : ""), priority: PRIORITY.get(row.source) ?? 9 }));
  keyed.sort((a, b) => pyCodeCompare(a.id, b.id) || a.priority - b.priority || a.index - b.index);
  const claimed = new Map<string, unknown>(), rows: Row[] = [];
  for (const { row, id: name } of keyed) {
    if (!name) continue;
    const source = row.source;
    if (source !== "resource" && source !== BUILTIN_SOURCE && isReserved(name, manifestCommands)) { rows.push({ ...row, body: null, shadowed: true, shadowedBy: "builtin" }); continue; }
    if (claimed.has(name)) { rows.push({ ...row, body: null, shadowed: true, shadowedBy: claimed.get(name) }); continue; }
    claimed.set(name, source);
    rows.push(row);
  }
  return rows;
}

export function publicRow(row: Row): Row {
  const { body: _body, ...rest } = row;
  return rest;
}
