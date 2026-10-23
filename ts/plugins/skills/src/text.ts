/** Python string semantics the skill files rely on (code points, `str.strip`, `str.isspace`, ordering). */

// Python `str.isspace()` / `str.strip()` whitespace (JS `\s` adds U+FEFF and lacks U+001C–U+001F, U+0085).
const PY_SPACE = "\\t\\n\\u000b\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
const RSTRIP = new RegExp(`[${PY_SPACE}]+$`, "u");
const SPACE = new RegExp(`^[${PY_SPACE}]$`, "u");

export const pyStrip = (text: string): string => text.replace(STRIP, "");
export const pyRstrip = (text: string): string => text.replace(RSTRIP, "");
/** `text[:1].isspace()`. */
export const startsWithSpace = (text: string): boolean => !!text && SPACE.test(String.fromCodePoint(text.codePointAt(0)!));
export const pyLen = (text: string): number => { let n = 0; for (const _ of text) n += 1; return n; };
export const pySlice = (text: string, start: number, end?: number): string => Array.from(text).slice(start, end).join("");

/** Python `str` ordering: by code point, not UTF-16 unit. */
export function pyCompare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

/** `str.splitlines()`-free split used by the skill parser: CRLF and CR become LF first. */
export const splitLines = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
export const TRUNCATION_SUFFIX = "\n…(truncated)";

/** Python `skills.clip`: strip, then keep at most `max` code points with the marker. */
export function clip(text: string, max: number): string {
  const t = pyStrip(String(text));
  if (!max || pyLen(t) <= max) return t;
  return pyRstrip(pySlice(t, 0, Math.max(0, max - 14))) + TRUNCATION_SUFFIX;
}
