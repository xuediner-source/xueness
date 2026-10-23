/**
 * Python value semantics needed to port the backend byte-for-byte.
 *
 * Session journals are JSON written by the Python backend. Porting code that
 * calls `str()`, slices strings, tests truthiness or strips whitespace must
 * reproduce CPython's rules, not JavaScript's:
 *
 * - `s[:n]` counts code points; `String#slice` counts UTF-16 units.
 * - `bool([])` / `bool({})` is False; `[]` and `{}` are truthy in JS.
 * - `str(None)` is "None"; `str(True)` is "True"; containers use `repr`.
 * - `str.strip()` uses Python's whitespace set, which differs from `trim()`.
 *
 * `JSON.parse` cannot tell `4` from `4.0`; journals are decoded losslessly
 * instead (`pyJsonLoads(..., { lossless: true })`), keeping integral floats as
 * `JsonFloat` and large ints as `bigint` (see `py-float.ts`).
 */
import { JsonFloat } from "./py-float.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object, the shape Python sees as `dict`. */
export function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonFloat);
}

/** `mapping.get(key, fallback)` on own keys only; prototype names never leak. */
export function pyGet(mapping: Record<string, unknown>, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(mapping, key) ? mapping[key] : fallback;
}

/** Python truthiness for JSON-shaped values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (value instanceof JsonFloat) return value.value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** `s[:n]` with code point semantics. */
export function pySlice(text: string, count: number): string {
  if (text.length <= count) return text;
  let units = 0;
  let points = 0;
  while (units < text.length && points < count) {
    const code = text.charCodeAt(units);
    const isPair = code >= 0xd800 && code <= 0xdbff && units + 1 < text.length
      && text.charCodeAt(units + 1) >= 0xdc00 && text.charCodeAt(units + 1) <= 0xdfff;
    units += isPair ? 2 : 1;
    points += 1;
  }
  return text.slice(0, units);
}

const PY_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** `str.strip()` with Python's whitespace definition (`str.isspace`). */
export function pyStrip(text: string): string {
  return pyRstrip(pyLstrip(text));
}

/** `str.lstrip()` with Python's whitespace definition. */
export function pyLstrip(text: string): string {
  let start = 0;
  while (start < text.length && PY_WHITESPACE.has(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/** `str.rstrip()` with Python's whitespace definition. */
export function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && PY_WHITESPACE.has(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** `str.isspace()` for one UTF-16 unit (every Python whitespace is in the BMP). */
export function pyIsSpace(code: number): boolean {
  return PY_WHITESPACE.has(code);
}

/** `re.fullmatch(r"turn-[1-9][0-9]*", value)`. */
export function isTurnId(value: unknown): value is string {
  return typeof value === "string" && /^turn-[1-9][0-9]*$/.test(value);
}

/** `repr(float)`: shortest round-trip digits, exponent outside [-4, 16). */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa = "0", exponentText = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number.parseInt(exponentText, 10);
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? "." + digits.slice(1) : "";
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? "-" : "+"}${magnitude}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction || "0"}`;
}

/** `str(number)`, treating integral values as Python ints (see module note). */
export function pyNumberStr(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return BigInt(value).toString();
  return pyFloatRepr(value);
}

const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** `repr(str)`, following CPython's `unicode_repr`. */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === quote || char === "\\") out += "\\" + char;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else if (code < 0x7f) out += char;
    else if (!NON_PRINTABLE.test(char)) out += char;
    else if (code <= 0xff) out += "\\x" + code.toString(16).padStart(2, "0");
    else if (code <= 0xffff) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += "\\U" + code.toString(16).padStart(8, "0");
  }
  return out + quote;
}

/** `repr(value)` for JSON-shaped values. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumberStr(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof JsonFloat) return pyFloatRepr(value.value);
  if (typeof value === "string") return pyStrRepr(value);
  if (Array.isArray(value)) return "[" + value.map(pyRepr).join(", ") + "]";
  if (isDict(value)) {
    return "{" + Object.entries(value).map(([key, item]) => pyStrRepr(key) + ": " + pyRepr(item)).join(", ") + "}";
  }
  return String(value);
}

/** `str(value)` for JSON-shaped values. */
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

export interface PyJsonOptions {
  /** Python's default is `(", ", ": ")`, or `(",", ": ")` with `indent`; compact is `(",", ":")`. */
  separators?: readonly [string, string];
  /** `ensure_ascii=True` (Python's default); this port defaults to False. */
  ensureAscii?: boolean;
  /** `allow_nan=False` raises for NaN and infinities. */
  allowNan?: boolean;
  /** `indent=n`: newline plus n spaces per level; empty containers stay `[]` / `{}`. */
  indent?: number;
  /** `sort_keys=True`: keys in code point order. */
  sortKeys?: boolean;
}

/** `ValueError` from `json.dumps(..., allow_nan=False)`. */
export class PyJsonRangeError extends RangeError {
  override name = "ValueError";
}

const ASCII_ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** `encode_basestring_ascii`: escape everything outside printable ASCII. */
function asciiString(text: string): string {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e && char !== '"' && char !== "\\") out += char;
    else out += ASCII_ESCAPES[char] ?? "\\u" + code.toString(16).padStart(4, "0");
  }
  return out + '"';
}

/** `encode_basestring`: only quotes, backslashes and C0 controls; lone surrogates stay raw. */
function plainString(text: string): string {
  // eslint-disable-next-line no-control-regex
  return `"${text.replace(/[\u0000-\u001f"\\]/g, (char) => ASCII_ESCAPES[char] ?? "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))}"`;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const diff = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** `json.dumps(value, ensure_ascii=False)` for JSON-shaped values (see `PyJsonOptions`). */
export function pyJsonDumps(value: unknown, options: PyJsonOptions = {}): string {
  const indent = options.indent === undefined ? null : " ".repeat(options.indent);
  const [itemSeparator, keySeparator] = options.separators ?? (indent === null ? [", ", ": "] : [",", ": "]);
  const string = options.ensureAscii ? asciiString : plainString;
  const float = (item: number): string => {
    if (!Number.isFinite(item) && options.allowNan === false) {
      throw new PyJsonRangeError("Out of range float values are not JSON compliant");
    }
    if (Number.isNaN(item)) return "NaN";
    if (!Number.isFinite(item)) return item > 0 ? "Infinity" : "-Infinity";
    return pyFloatRepr(item);
  };
  const encode = (item: unknown, level: number): string => {
    if (item === null || item === undefined) return "null";
    if (item === true) return "true";
    if (item === false) return "false";
    if (typeof item === "number") return Number.isInteger(item) ? pyNumberStr(item) : float(item);
    if (typeof item === "bigint") return item.toString();
    if (item instanceof JsonFloat) return float(item.value);
    if (typeof item === "string") return string(item);
    let parts: string[];
    let open: string;
    let close: string;
    if (Array.isArray(item)) {
      if (item.length === 0) return "[]";
      parts = item.map((child) => encode(child, level + 1));
      [open, close] = ["[", "]"];
    } else if (isDict(item)) {
      let keys = Object.keys(item);
      if (keys.length === 0) return "{}";
      if (options.sortKeys) keys = keys.sort(compareCodePoints);
      parts = keys.map((key) => string(key) + keySeparator + encode(item[key], level + 1));
      [open, close] = ["{", "}"];
    } else {
      throw new TypeError(`Object of type ${typeof item} is not JSON serializable`);
    }
    if (indent === null) return open + parts.join(itemSeparator) + close;
    const inner = "\n" + indent.repeat(level + 1);
    return open + inner + parts.join(itemSeparator + inner) + "\n" + indent.repeat(level) + close;
  };
  return encode(value, 0);
}

/**
 * `str.casefold()` approximated by upper-then-lower case mapping, which
 * covers the full foldings that matter for ASCII prefixes (`ß`, `ſ`, `ﬁ`,
 * `K`). Cherokee and contextual final-sigma folding are not ported.
 */
export function pyCasefold(text: string): string {
  return text.toUpperCase().toLowerCase();
}
