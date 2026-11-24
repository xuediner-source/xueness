/**
 * Turn-level tool execution status for the completion check.
 *
 * A failed call no longer fails the turn when later work in the same turn supersedes it:
 * - file change (edit, write, apply_patch): a later successful change to the same file(s);
 * - lookup (read, list, glob, grep): any later successful call;
 * - command (exec) and any other tool: a later success of the same target, or any later
 *   successful file change. An exec target is the program and operands of its first simple
 *   command, ignoring options, `NAME=value` / `env` / `timeout` wrappers, leading `cd DIR &&`
 *   segments and everything from the first pipe, chain or redirection on; another tool's
 *   target is its exact name and arguments.
 * So a failure that only fed trial and error does not count, while the last failed attempt
 * at a target, an edit that never landed, or a check that failed after the last change does.
 * Every identical successful retry is a same-target success, so this only relaxes the
 * former identical-call rule.
 */
import { resolve } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
import { internalToolName } from "./tool-contract/names.ts";

type Row = Record<string, unknown>;
export type ToolExecutionStatus = "not_applicable" | "incomplete" | "failed" | "succeeded";
interface Action { kind: "change" | "lookup" | "other"; targets: string[] }

const CHANGES = new Set(["edit", "write", "apply_patch"]);
const LOOKUPS = new Set(["read", "list", "glob", "grep"]);
const PATCH_HEADER = /^\*\*\* (?:(?:Add|Delete|Update) File|Move to):[ \t]*(.+?)[ \t]*$/gm;
const SHELL_TOKEN = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||&>>?|[|;&]|\d*>>?(?:&\d+)?|\d*<)|([^\s"'|;&<>]+)/g;
interface Word { text: string; op: boolean }

function fileTarget(root: string, path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const absolute = resolve(root, path.trim());
  return "file\0" + (process.platform === "win32" ? absolute.toLowerCase().replaceAll("/", "\\") : absolute);
}

function shellWords(command: string): Word[] {
  return [...command.matchAll(SHELL_TOKEN)].map((match) => match[3] !== undefined ? { text: match[3], op: true } : { text: match[1] ?? match[2] ?? match[4]!, op: false });
}

/** Program and operands of the first simple command, without wrappers, options or later segments. */
function commandTarget(words: Word[]): string | null {
  let index = 0;
  const at = (offset = 0): Word | undefined => words[index + offset];
  for (;;) {
    const word = at();
    if (!word || word.op) return null;
    const lower = word.text.toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) index += 1;
    else if (lower === "env") {
      index += 1;
      while (at() && !at()!.op && (at()!.text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(at()!.text))) index += at()!.text === "-u" || at()!.text === "--unset" ? 2 : 1;
    } else if (lower === "timeout") {
      index += 1;
      while (at() && !at()!.op && at()!.text.startsWith("-")) index += 1;
      index += 1;
    } else if (lower === "cd" || lower === "pushd") {
      const next = words.findIndex((item, position) => position > index && item.op && (item.text === "&&" || item.text === ";"));
      if (next < 0) break;
      index = next + 1;
    } else break;
  }
  const program = words[index]!.text.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
  const operands: string[] = [];
  for (const word of words.slice(index + 1)) {
    if (word.op) break;
    if (!word.text.startsWith("-")) operands.push(word.text);
  }
  return "exec\0" + [program, ...operands].join(" ");
}

function classify(call: Row | undefined, root: string): Action {
  const fn = call && isDict(call.function) ? call.function : {};
  const name = internalToolName(typeof fn.name === "string" ? fn.name.trim() : "");
  let args: unknown = fn.arguments ?? "";
  try { if (typeof args === "string") args = pyJsonLoads(args); } catch { /* keep the raw text */ }
  const input: Row = isDict(args) ? args : {};
  let canonical: string;
  try { canonical = typeof args === "string" ? args : pyJsonDumps(args, { sortKeys: true }); } catch { canonical = String(args); }
  const exact = "call\0" + pyJsonDumps([name, canonical]);
  if (CHANGES.has(name)) {
    const paths: unknown[] = name !== "apply_patch" ? [input.path]
      : typeof input.patch_text === "string" ? [...input.patch_text.matchAll(PATCH_HEADER)].map((match) => match[1]) : [];
    return { kind: "change", targets: [...new Set(paths.map((path) => fileTarget(root, path)).filter((target): target is string => target !== null))] };
  }
  if (LOOKUPS.has(name)) return { kind: "lookup", targets: [] };
  if (name === "exec") {
    const words = typeof input.command === "string" ? shellWords(input.command)
      : Array.isArray(input.argv) ? input.argv.filter((item): item is string => typeof item === "string").map((text) => ({ text, op: false })) : [];
    const target = commandTarget(words);
    return { kind: "other", targets: target ? [target, exact] : [exact] };
  }
  return { kind: "other", targets: [exact] };
}

export function toolExecutionStatus(session: Session, callIds: string[]): ToolExecutionStatus {
  if (!callIds.length) return "not_applicable";
  const results = isDict(session.results) ? session.results : {};
  const root = typeof session.root === "string" ? session.root : "";
  const calls = new Map<unknown, Row>();
  for (const message of (Array.isArray(session.messages) ? session.messages : []).filter(isDict)) {
    for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).filter(isDict)) calls.set(call.id, call);
  }
  const succeededLater = new Set<string>();
  let changedLater = false;
  let anySuccessLater = false;
  let failed = false;
  let incomplete = false;
  for (const cid of [...callIds].reverse()) {
    const result = results[cid];
    const action = classify(calls.get(cid), root);
    if (isDict(result) && result.ok === true) {
      for (const target of action.targets) succeededLater.add(target);
      changedLater ||= action.kind === "change";
      anySuccessLater = true;
    } else if (isDict(result) && result.ok === false) {
      const superseded = action.kind === "change" ? (action.targets.length ? action.targets.every((target) => succeededLater.has(target)) : changedLater)
        : action.kind === "lookup" ? anySuccessLater
          : changedLater || action.targets.some((target) => succeededLater.has(target));
      if (!superseded) failed = true;
    } else incomplete = true;
  }
  return incomplete ? "incomplete" : failed ? "failed" : "succeeded";
}
