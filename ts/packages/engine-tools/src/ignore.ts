/**
 * .gitignore semantics (gitignore(5)): comments, escapes, trailing-space
 * trimming, `!` negation, directory-only patterns, anchoring by an inner or
 * leading slash, and `**` in leading, trailing and middle positions.
 * Rules from deeper directories win over shallower ones; within a file the
 * last matching rule wins. A path inside an ignored directory stays ignored.
 */

export interface IgnoreRule {
  pattern: string;
  negate: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end -= 1;
  return line.slice(0, end).replace(/\\ $/, " ");
}

function bracket(pattern: string, start: number): { source: string; next: number } | null {
  let index = start + 1;
  let negate = false;
  if (pattern[index] === "!" || pattern[index] === "^") {
    negate = true;
    index += 1;
  }
  let body = "";
  if (pattern[index] === "]") {
    body += "\\]";
    index += 1;
  }
  for (; index < pattern.length && pattern[index] !== "]"; index += 1) {
    const char = pattern[index] as string;
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      body += escapeRegex(pattern[index] as string);
    } else body += char === "-" ? "-" : escapeRegex(char);
  }
  if (index >= pattern.length) return null;
  return { source: `[${negate ? "^" : ""}${body}]`, next: index + 1 };
}

/**
 * Compile one glob body (no `!`, no trailing slash) to a regex source.
 * `*` and `?` stay inside a segment; `**` spans directories. Shared with the
 * glob tool, whose patterns follow the same rules.
 */
export function globBody(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index] as string;
    if (char === "*" && pattern[index + 1] === "*") {
      const atStart = index === 0 || pattern[index - 1] === "/";
      const atEnd = index + 2 === pattern.length || pattern[index + 2] === "/";
      if (atStart && atEnd) {
        if (index + 2 === pattern.length) out += ".*";
        else out += "(?:[^/]*/)*";
        index += index + 2 === pattern.length ? 2 : 3;
        continue;
      }
    }
    if (char === "*") {
      out += "[^/]*";
      index += 1;
    } else if (char === "?") {
      out += "[^/]";
      index += 1;
    } else if (char === "[") {
      const parsed = bracket(pattern, index);
      if (parsed) {
        out += parsed.source;
        index = parsed.next;
      } else {
        out += "\\[";
        index += 1;
      }
    } else if (char === "\\" && index + 1 < pattern.length) {
      out += escapeRegex(pattern[index + 1] as string);
      index += 2;
    } else {
      out += escapeRegex(char);
      index += 1;
    }
  }
  return out;
}

export function parseIgnoreRule(line: string): IgnoreRule | null {
  let text = trimTrailingSpaces(line.replace(/\r$/, ""));
  if (!text || text.startsWith("#")) return null;
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1);
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) text = text.slice(1);
  const directoryOnly = text.endsWith("/") && !text.endsWith("\\/");
  if (directoryOnly) text = text.slice(0, -1);
  if (!text) return null;
  const anchored = text.includes("/");
  if (text.startsWith("/")) text = text.slice(1);
  const body = globBody(text);
  const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  return { pattern: line, negate, directoryOnly, regex };
}

export function parseIgnoreFile(text: string): IgnoreRule[] {
  return text.split("\n").map(parseIgnoreRule).filter((rule): rule is IgnoreRule => rule !== null);
}

interface Layer {
  /** Directory of the ignore file relative to the walk root ("" for root). */
  base: string;
  /** For ignore files above the walk root: path from that directory to the root. */
  prefix?: string;
  rules: IgnoreRule[];
}

export class IgnoreMatcher {
  readonly #layers: Layer[];

  constructor(layers: Layer[] = []) {
    this.#layers = layers;
  }

  /** A matcher with the rules of one more directory appended. */
  with(base: string, rules: IgnoreRule[]): IgnoreMatcher {
    return rules.length ? new IgnoreMatcher([...this.#layers, { base, rules }]) : this;
  }

  /** A matcher with rules from a directory above the walk root. */
  withAncestor(prefix: string, rules: IgnoreRule[]): IgnoreMatcher {
    return rules.length ? new IgnoreMatcher([...this.#layers, { base: "", prefix, rules }]) : this;
  }

  get empty(): boolean {
    return this.#layers.length === 0;
  }

  /** Decide for one path, assuming its parent directories are not ignored. */
  ignoresEntry(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const { base, prefix, rules } of this.#layers) {
      if (base && !path.startsWith(`${base}/`)) continue;
      const relative = prefix ? `${prefix}/${path}` : base ? path.slice(base.length + 1) : path;
      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) continue;
        if (rule.regex.test(relative)) ignored = !rule.negate;
      }
    }
    return ignored;
  }

  /** Full decision including ignored parent directories. */
  ignores(path: string, isDirectory: boolean): boolean {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (this.ignoresEntry(parts.slice(0, depth).join("/"), true)) return true;
    }
    return this.ignoresEntry(path, isDirectory);
  }
}
