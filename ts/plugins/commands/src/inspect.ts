/**
 * Python `commands.inspect_command` and `file_commands.find/read_body`: one
 * command with its bounded body for the operator CLI; nothing is expanded.
 */
import { pyLen, pyStrip, pyTruthy } from "@xueness/contracts";
import { BUILTIN_SOURCE } from "./builtin-prompts.ts";
import { clip, EXPAND_MAX_CHARS, merged, type CommandScope } from "./commands.ts";
import { BODY_PREVIEW_CHARS, diagnostic, type Diagnostic, MAX_COMMAND_FILE_BYTES, publicRow, shellExpansionFindings, type Row } from "./file-commands.ts";
import { stripFrontmatter } from "./frontmatter.ts";
import { contained, isLink, readText, real } from "./paths.ts";

/** `find`: the winning row named by id or name (a leading `/` ignored). */
export function findCommandRow(rows: readonly Row[], key: unknown): Row | null {
  if (typeof key !== "string" || !key) return null;
  const wanted = key.replace(/^\/+/, "");
  return rows.find((row) => !pyTruthy(row.shadowed) && (wanted === row.id || wanted === row.name)) ?? null;
}

/** `read_body`: the file's text after frontmatter, refused when linked or outside its root. */
export function readCommandBody(row: Row, max = MAX_COMMAND_FILE_BYTES): { ok: true; content: string; bytesRead: number; sizeBytes: number } | { ok: false; error: string } {
  const path = String(row.path || ""), base = String(row.rootPath || "");
  if (!path) return { ok: false, error: "command path is missing" };
  if (isLink(path)) return { ok: false, error: "command file must not be a link" };
  const resolved = real(path), jail = real(base || ".");
  if (resolved === null || jail === null || !contained(resolved, jail)) return { ok: false, error: "command path leaves its command root" };
  const { text, size, failure } = readText(path, max);
  if (failure) return { ok: false, error: `command file could not be read (${failure})` };
  return { ok: true, content: pyStrip(stripFrontmatter(text ?? "")), bytesRead: size ?? 0, sizeBytes: size ?? 0 };
}

export function inspectCommand(scope: CommandScope, key: unknown): Row {
  const m = merged(scope);
  const row = findCommandRow(m.rows, key);
  if (!row) return { ok: false, error: `command not found: ${String(key)}`, available: m.rows.filter((item) => !pyTruthy(item.shadowed)).map((item) => item.id), diagnostics: m.diagnostics };
  let content: unknown, size: unknown;
  if (row.source === "resource" || row.source === BUILTIN_SOURCE) { content = row.body; size = row.bytes; }
  else {
    const found = readCommandBody(row);
    if (!found.ok) return { ok: false, error: found.error, command: publicRow(row), diagnostics: m.diagnostics };
    content = found.content; size = found.sizeBytes;
  }
  const body = String(content || ""), budget = row.source === BUILTIN_SOURCE ? pyLen(body) : BODY_PREVIEW_CHARS;
  const findings: Diagnostic[] = [...m.diagnostics];
  if (row.source === "resource") findings.push(...shellExpansionFindings(body, String(row.path)));
  if (row.source === BUILTIN_SOURCE) {
    for (const loser of m.rows) {
      if (loser.id !== row.id || !pyTruthy(loser.shadowed)) continue;
      findings.push(diagnostic("command_shadowed_by_builtin", "info", `${String(loser.path ?? "None")} is not run: the built-in command /${String(row.id)} ships its own prompt`, String(loser.path || ".")));
    }
  }
  return { ok: true, command: publicRow(row), sizeBytes: Math.trunc(Number(size)), truncated: pyLen(body) > budget, content: clip(body, budget), diagnostics: findings,
    limits: { expandChars: EXPAND_MAX_CHARS, previewChars: BODY_PREVIEW_CHARS, commandFileBytes: MAX_COMMAND_FILE_BYTES } };
}
