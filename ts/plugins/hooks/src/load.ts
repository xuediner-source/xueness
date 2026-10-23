/**
 * User hook resources and matcher selection (Python `xueness/hooks.py`:
 * `load`, `select`, `clip`).
 *
 * `<state>/resources/hooks/<id>.json` holds `id`, `event`, `command` and the
 * optional `matcher`, `args`, `enabled`, `timeout`, `pipeline`. The loader
 * never writes, refuses a linked directory or entry, and skips one broken
 * entry instead of failing the list.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonLoads } from "@xueness/contracts";
import { isLink, readCapped, utf8 } from "./files.ts";

export type Row = Record<string, unknown>;

/** The seven upstream events, in upstream order. */
export const HOOK_EVENTS = Object.freeze(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"] as const);
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const isHookEvent = (value: unknown): value is HookEvent => typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
/** The two Post events a hook may move onto the tool event pipeline with `"pipeline": true`. */
export const POST_PIPELINE_EVENTS: readonly string[] = Object.freeze(["PostToolUse", "PostToolUseFailure"]);
export const TOOL_EVENTS: readonly string[] = Object.freeze(["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"]);
export const TRUNCATION_SUFFIX = "…(truncated)";
/** Python reads a hook file whole; this only bounds a hostile one. */
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

/** Python `clip`: at most `max` code points, keeping the truncation marker. */
export function clip(text: unknown, max: number): string {
  const value = typeof text === "string" ? text : String(text);
  const points = Array.from(value);
  if (!max || points.length <= max) return value;
  const keep = max - Array.from(TRUNCATION_SUFFIX).length;
  if (keep <= 0) return Array.from(TRUNCATION_SUFFIX).slice(0, max).join("");
  return points.slice(0, keep).join("") + TRUNCATION_SUFFIX;
}

/** Python `str.strip()` (U+FEFF is not whitespace there). */
export function strip(text: string): string {
  const space = /[\t\n\u000b\u000c\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
  const points = Array.from(text);
  let start = 0; let end = points.length;
  while (start < end && space.test(points[start]!)) start += 1;
  while (end > start && space.test(points[end - 1]!)) end -= 1;
  return points.slice(start, end).join("");
}
function readResource(path: string): Row | null {
  if (isLink(path)) return null;
  const raw = readCapped(path, MAX_RESOURCE_BYTES);
  if (!raw || raw.length > MAX_RESOURCE_BYTES) return null;
  const text = utf8(raw);
  if (text === null) return null;
  try { const data = pyJsonLoads(text); return isDict(data) ? data : null; } catch { return null; }
}

/** Python code-point order for `sorted(...)` of names and ids. */
export const pyCompare = (a: string, b: string): number => {
  const x = Array.from(a); const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) { const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!; if (d) return d; }
  return x.length - y.length;
};

/** Every usable hook under `<state>/resources/hooks`, id ascending. */
export function loadUserHooks(stateDir: string): Row[] {
  if (!stateDir) return [];
  const state = stateDir; const resources = join(state, "resources"); const directory = join(resources, "hooks");
  if (isLink(state) || isLink(resources) || isLink(directory)) return [];
  try { if (!statSync(directory).isDirectory()) return []; } catch { return []; }
  let names: string[];
  try { names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort(pyCompare); } catch { return []; }
  const hooks: Row[] = [];
  for (const name of names) {
    const item = readResource(join(directory, name));
    if (!item) continue;
    const id = item.id;
    if (typeof id !== "string" || !strip(id)) continue;
    if (item.enabled === false) continue;
    if (!isHookEvent(item.event)) continue;
    if (typeof item.command !== "string" || !strip(item.command)) continue;
    hooks.push({ ...item, id: strip(id) });
  }
  // Python's sort is stable: equal ids keep file order.
  return hooks.sort((a, b) => pyCompare(String(a.id), String(b.id)));
}

const FLAG = /^\(\?([aiLmsux]+)\)/;
/** A Python `re` pattern as a JavaScript RegExp, or null when either side rejects it. */
export function pythonRegex(pattern: string): RegExp | null {
  let source = pattern; let flags = "";
  const leading = FLAG.exec(source);
  if (leading) {
    for (const flag of leading[1]!) { if (flag === "i" || flag === "m" || flag === "s") flags += flags.includes(flag) ? "" : flag; else if (flag !== "u" && flag !== "a") return null; }
    source = source.slice(leading[0].length);
  }
  source = source.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/g, "\\k<$1>").replace(/\\Z/g, "(?![\\s\\S])").replace(/\\A/g, "(?<![\\s\\S])");
  try { return new RegExp(source, flags); } catch { return null; }
}

/** Python `select`, searched against each subject (the Xueness tool name, then the name the model saw). */
export function select(hooks: readonly Row[], event: string, subjects: readonly string[] = []): Row[] {
  const texts = subjects.length ? subjects : [""];
  const matches: Row[] = [];
  for (const hook of hooks) {
    if (!isDict(hook) || hook.event !== event) continue;
    const matcher = hook.matcher;
    if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") { matches.push(hook); continue; }
    if (typeof matcher !== "string") continue;
    const regex = pythonRegex(matcher);
    if (regex && texts.some((text) => regex.test(text))) matches.push(hook);
  }
  return matches;
}
