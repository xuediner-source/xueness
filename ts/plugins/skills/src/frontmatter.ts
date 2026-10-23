/**
 * SKILL.md frontmatter as plain text (Python `file_skills.parse_frontmatter`,
 * `validate_frontmatter`, `_tags`, `strip_frontmatter`): a leading `---` block
 * of top-level `key: value` lines plus folded/literal block scalars. No YAML.
 */
import { pyLen, pyStrip, splitLines, startsWithSpace } from "./text.ts";

export const NAME_MAX_CHARS = 64;
export const DESCRIPTION_MAX_CHARS = 1024;
const TAG_MAX_CHARS = 32;
const MAX_TAGS = 16;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const BLOCK_FOLD = /^>[-+]?$/;
const BLOCK_LITERAL = /^\|[-+]?$/;

export interface Diagnostic { code: string; severity: "error" | "warning"; message: string; path?: string }
export const diagnostic = (code: string, severity: Diagnostic["severity"], message: string, path?: string | null): Diagnostic =>
  ({ code, severity, message, ...(path != null ? { path } : {}) });

export type FrontmatterError = "skill_missing_frontmatter" | "skill_unclosed_frontmatter" | "skill_invalid_frontmatter";
export interface Frontmatter { values: Record<string, string>; keys: string[]; error: FrontmatterError | null }

function unquote(value: string): string {
  for (const quote of ['"', "'"]) if (pyLen(value) >= 2 && value.startsWith(quote) && value.endsWith(quote)) return pyStrip(value.slice(1, -1));
  return value;
}

function blockScalar(lines: string[], start: number, end: number, literal: boolean): [string, number] {
  const collected: string[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index]!;
    if (pyStrip(line) && !startsWithSpace(line)) break;
    collected.push(pyStrip(line));
    index += 1;
  }
  while (collected.length && !collected[collected.length - 1]) collected.pop();
  const joined = literal ? collected.join("\n") : collected.filter((item) => item).join(" ");
  return [pyStrip(joined), index];
}

const closing = (lines: string[]): number | null => {
  for (let index = 1; index < lines.length; index += 1) if (pyStrip(lines[index]!) === "---") return index;
  return null;
};
const leading = (text: string): string[] => splitLines(text.replace(/^\ufeff+/u, ""));

export function parseFrontmatter(text: string): Frontmatter {
  const lines = leading(text);
  if (!lines.length || pyStrip(lines[0]!) !== "---") return { values: {}, keys: [], error: "skill_missing_frontmatter" };
  const end = closing(lines);
  if (end === null) return { values: {}, keys: [], error: "skill_unclosed_frontmatter" };
  const values: Record<string, string> = {};
  const keys: string[] = [];
  let broken = 0;
  let index = 1;
  while (index < end) {
    const line = lines[index]!;
    const stripped = pyStrip(line);
    if (!stripped || stripped.startsWith("#") || startsWithSpace(line)) { index += 1; continue; }
    const at = line.indexOf(":");
    const key = pyStrip(at < 0 ? line : line.slice(0, at)).toLowerCase();
    if (at < 0 || !KEY.test(key)) { broken += 1; index += 1; continue; }
    let value = pyStrip(line.slice(at + 1));
    const literal = BLOCK_LITERAL.test(value);
    if (literal || BLOCK_FOLD.test(value)) [value, index] = blockScalar(lines, index + 1, end, literal);
    else { value = unquote(value); index += 1; }
    keys.push(key);
    values[key] = value;
  }
  if (broken && !Object.keys(values).length) return { values, keys, error: "skill_invalid_frontmatter" };
  return { values, keys, error: null };
}

export function tags(value: string | undefined): string[] {
  let text = pyStrip(String(value ?? ""));
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const items: string[] = [];
  for (const piece of text.split(",")) {
    const tag = unquote(pyStrip(piece));
    if (tag && pyLen(tag) <= TAG_MAX_CHARS && !items.includes(tag)) items.push(tag);
  }
  return items.slice(0, MAX_TAGS);
}

export interface SkillMeta { name: string; description: string; tags: string[]; keys: string[] }

export function validateFrontmatter(values: Record<string, string>, keys: string[], path?: string | null): { meta: SkillMeta; issue: null } | { meta: null; issue: Diagnostic } {
  const name = pyStrip(String(values.name || ""));
  if (!name) return { meta: null, issue: diagnostic("skill_missing_name", "error", "SKILL.md frontmatter needs a name", path) };
  if (pyLen(name) > NAME_MAX_CHARS || !NAME_PATTERN.test(name)) {
    return { meta: null, issue: diagnostic("skill_invalid_name", "error", `skill name must be lowercase letters, digits and dashes, at most ${NAME_MAX_CHARS} characters: ${name}`, path) };
  }
  const description = pyStrip(String(values.description || ""));
  if (!description) return { meta: null, issue: diagnostic("skill_missing_description", "error", `SKILL.md frontmatter needs a description: ${name}`, path) };
  if (pyLen(description) > DESCRIPTION_MAX_CHARS) {
    return { meta: null, issue: diagnostic("skill_description_too_long", "error", `skill description is longer than ${DESCRIPTION_MAX_CHARS} characters: ${name}`, path) };
  }
  return { meta: { name, description, tags: tags(values.tags ?? ""), keys: [...new Set(keys)] }, issue: null };
}

/** The text after the frontmatter block (the whole text when there is none). */
export function stripFrontmatter(text: string): string {
  const lines = leading(text);
  if (!lines.length || pyStrip(lines[0]!) !== "---") return text;
  const end = closing(lines);
  return end === null ? text : lines.slice(end + 1).join("\n");
}

/** The body after a validated frontmatter block (skill_validate). */
export function bodyAfterFrontmatter(text: string): string {
  const lines = text.replace(/^\ufeff+/u, "").replace(/\r\n/g, "\n").split("\n");
  const end = closing(lines);
  return pyStrip(end === null ? "" : lines.slice(end + 1).join("\n"));
}
