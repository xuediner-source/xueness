/**
 * Slash-command loading and expansion (Python `commands.py`). Three families
 * share one listing: resource commands (`<state>/resources/commands/<id>.json`),
 * file commands (`file-commands.ts`) and built-in prompts (`/init`). Expansion
 * is pure text: nothing runs, nothing is written, `!`cmd`` stays literal, and
 * the result is clipped so a hostile body cannot blow up the prompt.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pyIsSpace, pyLen, pyRstrip, pySlice, pyStr, pyStrip, pyTruthy } from "@xueness/contracts";
import { isLink, jsonEntries, readJsonObject, resourceKindDir } from "@xueness/sessions";
import { builtinRows, BUILTIN_SOURCE, render } from "./builtin-prompts.ts";
import { discover, merge, publicRow, type Diagnostic, type Row } from "./file-commands.ts";
import { isDir } from "./paths.ts";

export const EXPAND_MAX_CHARS = 8000;
const TRUNCATION_SUFFIX = "\n…(truncated)";
// Python `re.match("^...$")`: `$` also matches before one trailing newline.
const ID_RE = /^[A-Za-z0-9._-]{1,64}\n?$/;
// Python `\s` in a str pattern is `str.isspace()`.
const PY_SPACE = "\\t\\n\\u000b\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const INVOCATION_RE = new RegExp(`^/([A-Za-z0-9._:-]{1,64})(?:[${PY_SPACE}]+([\\s\\S]*))?$`, "u");
const ARGUMENT_TOKEN_RE = /\$ARGUMENTS|\$([1-9])(?!\p{Nd})/gu;

export interface CommandScope {
  stateDir: string;
  root?: string | null;
  language?: unknown;
  includeCompat?: boolean;
  /** Names a bundled plugin manifest owns as an in-chat command. */
  manifestCommands?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}

export function clip(text: unknown, max: number): string {
  const value = pyStrip(pyStr(text));
  if (!max || pyLen(value) <= max) return value;
  return pyRstrip(pySlice(value, Math.max(0, max - 14))) + TRUNCATION_SUFFIX;
}

const validId = (value: unknown): value is string => typeof value === "string" && value !== "." && value !== ".." && ID_RE.test(value);

/** `_body`: `prompt` preferred, else `content`; only a non-blank string counts. */
export function commandBody(item: Row): string | null {
  for (const key of ["prompt", "content"]) {
    const value = Object.hasOwn(item, key) ? item[key] : null;
    if (typeof value === "string" && pyStrip(value)) return value;
  }
  return null;
}

/** Positional arguments: whitespace-separated runs, double quotes group; no escapes, no shell. */
export function splitArguments(text: unknown): string[] {
  const items: string[] = [];
  let current = "", quoted = false, started = false;
  for (const char of pyStr(pyTruthy(text) ? text : "")) {
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (pyIsSpace(char.codePointAt(0)!) && !quoted) {
      if (started) { items.push(current); current = ""; started = false; }
      continue;
    }
    current += char; started = true;
  }
  if (started) items.push(current);
  return items;
}

/** One pass over the body: a typed value is never rescanned; no placeholder appends the arguments. */
export function substituteArguments(body: string, args: string): string {
  const positional = splitArguments(args);
  let used = false;
  const expanded = body.replace(ARGUMENT_TOKEN_RE, (match: string, digit?: string) => {
    used = true;
    if (match === "$ARGUMENTS") return args;
    const index = Number(digit) - 1;
    return index >= 0 && index < positional.length ? positional[index]! : "";
  });
  return pyStrip(args) && !used ? body + "\n\n" + args : expanded;
}

function jsonRows(directory: string): Row[] {
  const rows: Row[] = [];
  for (const name of jsonEntries(directory)) {
    const path = join(directory, name);
    if (isLink(path)) continue;
    const item = readJsonObject(path);
    if (item === null || item.enabled === false) continue;
    const cid = Object.hasOwn(item, "id") ? item.id : null;
    if (!validId(cid)) continue;
    const body = commandBody(item);
    if (body === null) continue;
    let size = 0;
    try { size = lstatSync(path).size; } catch { size = 0; }
    const { enabled: _enabled, prompt: _prompt, content: _content, ...entry } = item;
    rows.push({ ...entry, id: cid, name: pyStr(pyTruthy(item.name) ? item.name : cid), description: pyStrip(pyStr(pyTruthy(item.description) ? item.description : "")),
      argumentHint: "", model: "", frontmatterKeys: [], source: "resource", scope: "resource", path, rootPath: directory, bytes: size, body, shadowed: false, shadowedBy: null });
  }
  return rows;
}

/** `resource_rows`: the settings-page store in the file-row shape; an unusable store lists nothing. */
export function resourceRows(stateDir: string): Row[] {
  let directory: string;
  try { directory = resourceKindDir(stateDir, "commands"); } catch { return []; }
  if (isLink(directory) || !isDir(directory)) return [];
  return jsonRows(directory);
}

export function merged(scope: CommandScope): { rows: Row[]; diagnostics: Diagnostic[] } {
  const root = scope.root ?? null;
  const found = discover(scope.stateDir, root, scope.includeCompat ?? true);
  const builtins = builtinRows(scope.language, root, scope.env);
  return { rows: merge(resourceRows(scope.stateDir), [...builtins, ...found.commands], scope.manifestCommands ?? new Set()), diagnostics: found.diagnostics };
}

/** `list_all`: every row with source, position and shadowing — no bodies. */
export function listAll(scope: CommandScope): { commands: Row[]; diagnostics: Diagnostic[] } {
  const result = merged(scope);
  return { commands: result.rows.map(publicRow), diagnostics: result.diagnostics };
}

/** `load`: the rows a turn may become (enabled, winning, non-empty), body as `prompt`. */
export function loadCommands(scope: CommandScope): Row[] {
  return merged(scope).rows.flatMap((row) => {
    if (row.enabled === false || pyTruthy(row.shadowed) || !pyStrip(pyStr(pyTruthy(row.body) ? row.body : ""))) return [];
    return [{ ...publicRow(row), prompt: row.body }];
  });
}

function findCommand(commands: readonly unknown[], name: string): Row | null {
  for (const entry of commands) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Row;
    if (row.id !== name || row.enabled === false || pyTruthy(row.shadowed)) continue;
    return row;
  }
  return null;
}

function expandBody(command: Row, args: string, env?: NodeJS.ProcessEnv): string | null {
  if (command.source === BUILTIN_SOURCE) {
    const root = command.rootPath;
    return render(pyTruthy(command.builtinName) ? command.builtinName : command.id, args, command.language, typeof root === "string" ? root : null, env);
  }
  return substituteArguments(commandBody(command)!, args);
}

/** `expand`: one slash invocation becomes its command text, or the turn passes through untouched. */
export function expandCommand(commands: readonly unknown[], text: unknown, env?: NodeJS.ProcessEnv): [unknown, { command: string; args: string } | null] {
  if (typeof text !== "string") return [text, null];
  const match = INVOCATION_RE.exec(text);
  if (!match) return [text, null];
  const name = match[1]!, args = match[2] ?? "";
  const command = findCommand(commands, name);
  if (command === null || commandBody(command) === null) return [text, null];
  const expanded = expandBody(command, args, env);
  if (expanded === null) return [text, null];
  return [clip(expanded, EXPAND_MAX_CHARS), { command: name, args }];
}
