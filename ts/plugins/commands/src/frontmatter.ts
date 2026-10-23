/**
 * Command frontmatter (Python `file_commands.parse_frontmatter` and friends):
 * flat `key: value` pairs, quoted values and `|`/`>` block scalars. Nothing is
 * evaluated; a broken block is a diagnostic, never an exception.
 */
import { pyIsSpace, pySlice, pyStrip } from "@xueness/contracts";

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const BLOCK_FOLD = /^>[-+]?$/;
const BLOCK_LITERAL = /^\|[-+]?$/;
export const DESCRIPTION_MAX_CHARS = 1024;

export const splitLines = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
const indented = (line: string): boolean => line.length > 0 && pyIsSpace(line.codePointAt(0)!);
const withoutBom = (text: string): string => text.replace(/^\uFEFF+/, "");

function unquote(value: string): string {
  for (const quote of ['"', "'"]) if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) return pyStrip(value.slice(1, -1));
  return value;
}

function blockScalar(lines: string[], start: number, end: number, literal: boolean): [string, number] {
  const collected: string[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index]!;
    if (pyStrip(line) && !indented(line)) break;
    collected.push(pyStrip(line));
    index += 1;
  }
  while (collected.length && !collected[collected.length - 1]) collected.pop();
  const joined = literal ? collected.join("\n") : collected.filter(Boolean).join(" ");
  return [pyStrip(joined), index];
}

function fenceEnd(lines: string[]): number {
  for (let index = 1; index < lines.length; index += 1) if (pyStrip(lines[index]!) === "---") return index;
  return -1;
}

export interface Frontmatter { values: Map<string, string>; keys: string[]; error: string | null }

export function parseFrontmatter(text: string): Frontmatter {
  const lines = splitLines(withoutBom(text));
  if (!lines.length || pyStrip(lines[0]!) !== "---") return { values: new Map(), keys: [], error: null };
  const end = fenceEnd(lines);
  if (end < 0) return { values: new Map(), keys: [], error: "command_unclosed_frontmatter" };
  const values = new Map<string, string>(), keys: string[] = [];
  let broken = 0, index = 1;
  while (index < end) {
    const line = lines[index]!, stripped = pyStrip(line);
    if (!stripped || stripped.startsWith("#") || indented(line)) { index += 1; continue; }
    const at = line.indexOf(":");
    const key = pyStrip(at < 0 ? line : line.slice(0, at)).toLowerCase();
    if (at < 0 || !KEY.test(key)) { broken += 1; index += 1; continue; }
    let value = pyStrip(line.slice(at + 1));
    const literal = BLOCK_LITERAL.test(value);
    if (literal || BLOCK_FOLD.test(value)) [value, index] = blockScalar(lines, index + 1, end, literal);
    else { value = unquote(value); index += 1; }
    keys.push(key); values.set(key, value);
  }
  return { values, keys, error: broken && !values.size ? "command_invalid_frontmatter" : null };
}

/** The body after the frontmatter block, or the original text when there is no closed block. */
export function stripFrontmatter(text: string): string {
  const lines = splitLines(withoutBom(text));
  if (!lines.length || pyStrip(lines[0]!) !== "---") return text;
  const end = fenceEnd(lines);
  return end < 0 ? text : lines.slice(end + 1).join("\n");
}

/** The first non-empty body line without its Markdown heading/quote/list markers. */
export function firstLineDescription(body: string): string {
  for (const candidate of splitLines(body)) {
    const stripped = pyStrip(candidate.replace(/^[#>\-*]+/, ""));
    if (stripped) return pySlice(stripped, DESCRIPTION_MAX_CHARS);
  }
  return "";
}
