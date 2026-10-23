/**
 * Search regexes for grep. The syntax is JavaScript's, with the common Python
 * spellings the previous backend accepted translated: `(?P<name>…)`,
 * `(?P=name)`, leading inline flags `(?i)`, `(?s)`, `(?m)`, and the anchors
 * `\A` and `\Z`. Unicode mode is tried first so `\p{Script=Han}` works; a
 * pattern that is only valid without it still compiles.
 */

export class InvalidPatternError extends Error {
  override name = "InvalidPatternError";
  readonly code = "invalid_argument";
}

export interface SearchRegexOptions {
  ignoreCase?: boolean;
  /** Match across lines: `^`/`$` at line boundaries and `.` includes newlines. */
  multiline?: boolean;
}

function translatePython(pattern: string): { source: string; flags: Set<string> } {
  const flags = new Set<string>();
  let source = pattern;
  const inline = /^\(\?([aiLmsux]+)\)/.exec(source);
  if (inline) {
    for (const flag of inline[1] as string) {
      if (flag === "x") throw new InvalidPatternError("verbose (?x) patterns are not supported");
      if (flag === "i" || flag === "m" || flag === "s") flags.add(flag);
    }
    source = source.slice(inline[0].length);
  }
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\\" && index + 1 < source.length) {
      const next = source[index + 1] as string;
      out += next === "A" ? "^" : next === "Z" ? "$" : `\\${next}`;
      index += 1;
    } else if (source.startsWith("(?P<", index)) {
      out += "(?<";
      index += 3;
    } else if (source.startsWith("(?P=", index)) {
      const close = source.indexOf(")", index);
      if (close === -1) throw new InvalidPatternError("invalid regex: unterminated (?P=name)");
      out += `\\k<${source.slice(index + 4, close)}>`;
      index = close;
    } else out += char;
  }
  return { source: out, flags };
}

export function compileSearchRegex(pattern: string, options: SearchRegexOptions = {}): RegExp {
  if (typeof pattern !== "string" || !pattern) throw new InvalidPatternError("pattern must be a nonempty string");
  const { source, flags } = translatePython(pattern);
  if (options.ignoreCase) flags.add("i");
  if (options.multiline) {
    flags.add("g");
    flags.add("m");
    flags.add("s");
  }
  const base = [...flags].join("");
  try {
    return new RegExp(source, `${base}u`);
  } catch {
    try {
      return new RegExp(source, base);
    } catch (error) {
      throw new InvalidPatternError(`invalid regex: ${(error as Error).message}`);
    }
  }
}
