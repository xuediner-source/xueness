/**
 * `json.loads` with CPython's rules, for payloads where they matter.
 *
 * `JSON.parse` keeps the last of duplicate keys and rejects `NaN`, so code
 * ported from Python that refuses duplicate keys (`object_pairs_hook`) or
 * accepts non-finite constants needs its own scanner. This one follows
 * `json/decoder.py` and the C scanner, including the error positions
 * (`pos`, `lineno`, `colno`, counted in code points like Python).
 *
 * By default numbers become JS numbers, so integers beyond 2**53 lose
 * precision and `1.0` reads as `1`. `lossless: true` keeps both distinctions
 * (`JsonFloat`, `bigint`; see `py-float.ts`), as session journals need.
 */

import { pyJsonDecodeBytes } from "./py-codecs.ts";
import { JsonFloat } from "./py-float.ts";

export class PyJsonDecodeError extends SyntaxError {
  override name = "JSONDecodeError";
  /** Code point offset of the problem, as Python reports it. */
  readonly pos: number;
  readonly lineno: number;
  readonly colno: number;
  constructor(message: string, doc: string, index: number) {
    const pos = codePoints(doc, index);
    const before = doc.slice(0, index);
    const lineno = before.split("\n").length;
    const colno = lineno === 1 ? pos + 1 : pos - codePoints(doc, before.lastIndexOf("\n"));
    super(`${message}: line ${lineno} column ${colno} (char ${pos})`);
    this.pos = pos;
    this.lineno = lineno;
    this.colno = colno;
  }
}

/** A repeated object key under `rejectDuplicates` (Python's `ValueError`). */
export class PyJsonDuplicateKeyError extends Error {
  override name = "DuplicateKey";
  constructor() {
    super("duplicate JSON key");
  }
}

/** A NaN / Infinity constant under `rejectNonFinite` (Python's `ValueError`). */
export class PyJsonNonFiniteError extends Error {
  override name = "ValueError";
  constructor() {
    super("nonfinite JSON number");
  }
}

export interface PyJsonLoadOptions {
  /** CPython changed trailing-comma diagnostics in 3.13; default is 3.13. */
  errorDialect?: "3.11" | "3.13";
  /** Refuse repeated object keys instead of keeping the last one. */
  rejectDuplicates?: boolean;
  /** Refuse the `NaN`, `Infinity` and `-Infinity` constants. */
  rejectNonFinite?: boolean;
  /** Keep integral floats as `JsonFloat` and unsafe integers as `bigint`. */
  lossless?: boolean;
}

function codePoints(text: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < index) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

const WS = " \t\n\r";
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

class StopIteration {
  readonly index: number;
  constructor(index: number) {
    this.index = index;
  }
}

class Scanner {
  readonly #s: string;
  readonly #options: PyJsonLoadOptions;
  constructor(s: string, options: PyJsonLoadOptions) {
    this.#s = s;
    this.#options = options;
  }

  skip(end: number): number {
    while (end < this.#s.length && WS.includes(this.#s[end] as string)) end += 1;
    return end;
  }

  /** `nextchar in WHITESPACE_STR`, where the empty string counts as whitespace. */
  #isWs(index: number): boolean {
    const char = this.#s[index];
    return char === undefined || WS.includes(char);
  }

  scanOnce(idx: number): [unknown, number] {
    const s = this.#s;
    const next = s[idx];
    if (next === undefined) throw new StopIteration(idx);
    if (next === '"') return this.#string(idx + 1);
    if (next === "{") return this.#object(idx + 1);
    if (next === "[") return this.#array(idx + 1);
    if (next === "n" && s.startsWith("null", idx)) return [null, idx + 4];
    if (next === "t" && s.startsWith("true", idx)) return [true, idx + 4];
    if (next === "f" && s.startsWith("false", idx)) return [false, idx + 5];
    NUMBER.lastIndex = idx;
    const match = NUMBER.exec(s);
    if (match) {
      // Python ints have no negative zero: "-0" is 0, while "-0.0" stays -0.0.
      const value = Number(match[0]);
      const integral = match[1] === undefined && match[2] === undefined;
      const end = idx + match[0].length;
      if (this.#options.lossless) {
        if (integral) return [Number.isSafeInteger(value) ? value + 0 : BigInt(match[0]), end];
        return [Number.isInteger(value) ? new JsonFloat(value) : value, end];
      }
      return [integral && value === 0 ? 0 : value, end];
    }
    if (next === "N" && s.startsWith("NaN", idx)) return [this.#constant(Number.NaN), idx + 3];
    if (next === "I" && s.startsWith("Infinity", idx)) return [this.#constant(Infinity), idx + 8];
    if (next === "-" && s.startsWith("-Infinity", idx)) return [this.#constant(-Infinity), idx + 9];
    throw new StopIteration(idx);
  }

  #constant(value: number): number {
    if (this.#options.rejectNonFinite) throw new PyJsonNonFiniteError();
    return value;
  }

  #value(idx: number): [unknown, number] {
    try {
      return this.scanOnce(idx);
    } catch (error) {
      if (error instanceof StopIteration) throw new PyJsonDecodeError("Expecting value", this.#s, error.index);
      throw error;
    }
  }

  #string(end: number): [string, number] {
    const s = this.#s;
    const begin = end - 1;
    let out = "";
    for (;;) {
      let index = end;
      while (index < s.length) {
        const code = s.charCodeAt(index);
        if (code === 0x22 || code === 0x5c || code <= 0x1f) break;
        index += 1;
      }
      if (index >= s.length) throw new PyJsonDecodeError("Unterminated string starting at", s, begin);
      out += s.slice(end, index);
      const terminator = s[index] as string;
      end = index + 1;
      if (terminator === '"') return [out, end];
      if (terminator !== "\\") throw new PyJsonDecodeError("Invalid control character at", s, index);
      const esc = s[end];
      if (esc === undefined) throw new PyJsonDecodeError("Unterminated string starting at", s, begin);
      if (esc !== "u") {
        const char = ESCAPES[esc];
        // The C scanner reports the backslash, without the pure-Python repr suffix.
        if (char === undefined) throw new PyJsonDecodeError("Invalid \\escape", s, end - 1);
        out += char;
        end += 1;
        continue;
      }
      let uni = this.#hex4(end);
      end += 5;
      // A pair needs room for "\\uXXXX" plus one more character, as in `_json.c`.
      if (uni >= 0xd800 && uni <= 0xdbff && end + 6 < s.length && s.startsWith("\\u", end)) {
        const low = this.#hex4(end + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          uni = 0x10000 + (((uni - 0xd800) << 10) | (low - 0xdc00));
          end += 6;
        }
      }
      out += String.fromCodePoint(uni);
    }
  }

  /** Four hex digits after the `u` at `pos`; the escape must not end the document. */
  #hex4(pos: number): number {
    const digits = this.#s.slice(pos + 1, pos + 5);
    if (pos + 5 >= this.#s.length || !/^[0-9A-Fa-f]{4}$/.test(digits)) {
      throw new PyJsonDecodeError("Invalid \\uXXXX escape", this.#s, pos);
    }
    return Number.parseInt(digits, 16);
  }

  #object(end: number): [Record<string, unknown>, number] {
    const s = this.#s;
    // Like `object_pairs_hook`, duplicates are judged once the object closes,
    // so a later syntax error in the same object wins.
    const pairs: [string, unknown][] = [];
    const add = (key: string, value: unknown): void => {
      pairs.push([key, value]);
    };
    let next = s[end] ?? "";
    if (next !== '"') {
      if (this.#isWs(end)) {
        end = this.skip(end);
        next = s[end] ?? "";
      }
      if (next === "}") return [this.#build(pairs), end + 1];
      if (next !== '"') throw new PyJsonDecodeError("Expecting property name enclosed in double quotes", s, end);
    }
    end += 1;
    for (;;) {
      const [key, afterKey] = this.#string(end);
      end = afterKey;
      if (s[end] !== ":") {
        end = this.skip(end);
        if (s[end] !== ":") throw new PyJsonDecodeError("Expecting ':' delimiter", s, end);
      }
      end = this.skip(end + 1);
      const [value, afterValue] = this.#value(end);
      add(key, value);
      end = this.skip(afterValue);
      next = s[end] ?? "";
      end += 1;
      if (next === "}") break;
      if (next !== ",") throw new PyJsonDecodeError("Expecting ',' delimiter", s, end - 1);
      const comma = end - 1;
      end = this.skip(end);
      next = s[end] ?? "";
      end += 1;
      if (next !== '"') {
        if (next === "}" && this.#options.errorDialect !== "3.11") throw new PyJsonDecodeError("Illegal trailing comma before end of object", s, comma);
        throw new PyJsonDecodeError("Expecting property name enclosed in double quotes", s, end - 1);
      }
    }
    return [this.#build(pairs), end];
  }

  #build(pairs: [string, unknown][]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const [key, value] of pairs) {
      if (seen.has(key)) {
        if (this.#options.rejectDuplicates) throw new PyJsonDuplicateKeyError();
      } else seen.add(key);
      // defineProperty keeps "__proto__" an ordinary key; a repeat keeps its first position.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  #array(end: number): [unknown[], number] {
    const s = this.#s;
    const values: unknown[] = [];
    end = this.skip(end);
    if (s[end] === "]") return [values, end + 1];
    for (;;) {
      const [value, afterValue] = this.#value(end);
      values.push(value);
      end = this.skip(afterValue);
      const next = s[end] ?? "";
      end += 1;
      if (next === "]") break;
      if (next !== ",") throw new PyJsonDecodeError("Expecting ',' delimiter", s, end - 1);
      const comma = end - 1;
      end = this.skip(end);
      if (s[end] === "]" && this.#options.errorDialect !== "3.11") throw new PyJsonDecodeError("Illegal trailing comma before end of array", s, comma);
    }
    return [values, end];
  }
}

/** `json.loads(text)` for a `str` document. */
export function pyJsonLoads(text: string, options: PyJsonLoadOptions = {}): unknown {
  if (text.startsWith("\ufeff")) throw new PyJsonDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  return decodeDocument(text, options);
}

function decodeDocument(text: string, options: PyJsonLoadOptions): unknown {
  const scanner = new Scanner(text, options);
  const start = scanner.skip(0);
  let value: unknown;
  let end: number;
  try {
    [value, end] = scanner.scanOnce(start);
  } catch (error) {
    if (error instanceof StopIteration) throw new PyJsonDecodeError("Expecting value", text, error.index);
    throw error;
  }
  end = scanner.skip(end);
  if (end !== text.length) throw new PyJsonDecodeError("Extra data", text, end);
  return value;
}

/**
 * `json.loads(raw)` for bytes: `detect_encoding` (UTF-8/16/32, BOMs) and a
 * `surrogatepass` decode; undecodable input raises `UnicodeDecodeError`.
 */
export function pyJsonLoadsBytes(raw: Uint8Array, options: PyJsonLoadOptions = {}): unknown {
  return decodeDocument(pyJsonDecodeBytes(raw), options);
}
