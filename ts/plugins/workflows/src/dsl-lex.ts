/**
 * Tokeniser for the workflow expression DSL (Python `dsl.py`, which gets its
 * tokens from `ast.parse`).
 *
 * Python's tokeniser is reproduced closely enough that the same sources are
 * accepted and the same ones raise `SyntaxError`, because the interpreter
 * downstream only ever looks at node classes. Limits and message texts live
 * here so the parser and the interpreter share them without importing each
 * other.
 */
import { pyFloatValue, PyValueError } from "@xueness/contracts";

export const MAX_SCRIPT = 32_000;
export const MAX_NODES = 64;
/** CPython's parser refuses more than 200 nested brackets (`SyntaxError`). */
export const MAX_BRACKETS = 200;
/** Stands in for Python's ~1000-frame limit inside `expression()` / `literal()`. */
export const MAX_DEPTH = 400;
export const AGENT_KEYS: ReadonlySet<string> = new Set(["cwd", "timeout", "provider_id", "model", "writable"]);
export const SYNTAX = "invalid workflow expression syntax";
export const STATEMENTS = "workflow scripts only support DSL expressions and simple assignments";
export const EXPRESSIONS = "workflow expressions may only combine DSL calls and assigned stage names";
export const LITERALS = "workflow arguments must be literal values";
export const DEEP = "workflow DSL nesting is too deep";

export function fail(message: string): never {
  throw new PyValueError(message);
}

export type Kind = "name" | "num" | "str" | "other" | "op" | "nl" | "eof";

export interface Tok {
  readonly k: Kind;
  readonly t: string;
  readonly v?: unknown;
}

export const EOF: Tok = { k: "eof", t: "" };
const CLOSER: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
const OPS: readonly string[] = ["**=", "//=", ">>=", "<<=", "...", ":=", "->", "**", "//", "<<", ">>", "<=", ">=", "==", "!=",
  "+=", "-=", "*=", "/=", "%=", "@=", "&=", "|=", "^=", "(", ")", "[", "]", "{", "}", ",", ":", ";", ".",
  "=", "+", "-", "*", "/", "%", "&", "|", "^", "~", "<", ">", "@"];
const ESC: Readonly<Record<string, string>> = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const STRING = /^([A-Za-z]{0,2})('''|"""|'|")/;
const PREFIXES: ReadonlySet<string> = new Set(["", "r", "b", "u", "f", "rb", "br", "fr", "rf"]);
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9][0-9_]*)?)([jJ]?)/;

/** Decode one Python string literal; an unknown escape keeps its backslash. */
function readString(src: string, at: number): { end: number; value: string; plain: boolean } {
  const match = STRING.exec(src.slice(at))!;
  const prefix = match[1]!.toLowerCase();
  const fence = match[2]!;
  const triple = fence.length === 3;
  const raw = prefix.includes("r");
  // f-strings and bytes are not `str` constants, so the interpreter rejects them.
  const plain = !prefix.includes("b") && !prefix.includes("f");
  let cursor = at + prefix.length + fence.length;
  let value = "";
  while (cursor < src.length) {
    if (src.startsWith(fence, cursor)) return { end: cursor + fence.length, value, plain };
    const char = src[cursor]!;
    if (char === "\n" && !triple) fail(SYNTAX);
    if (char !== "\\") { value += char; cursor += 1; continue; }
    const next = src[cursor + 1];
    if (next === undefined) fail(SYNTAX);
    cursor += 2;
    if (raw) { value += "\\" + next; continue; }
    if (next === "\n") continue;
    const simple = ESC[next];
    if (simple !== undefined) { value += simple; continue; }
    if (next === "x" || next === "u" || next === "U") {
      const width = next === "x" ? 2 : next === "u" ? 4 : 8;
      const hex = src.slice(cursor, cursor + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) fail(SYNTAX);
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff) fail(SYNTAX);
      value += String.fromCodePoint(code);
      cursor += width;
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(src.slice(cursor - 1))![0];
      value += String.fromCharCode(Number.parseInt(octal, 8));
      cursor += octal.length - 1;
      continue;
    }
    // `\N{NAME}` would need Python's Unicode name table (see the module note).
    if (next === "N") fail(SYNTAX);
    value += "\\" + next;
  }
  return fail(SYNTAX);
}

/** Python int literal as a `number`, or a `bigint` past the safe range. */
function intValue(text: string): number | bigint {
  const big = BigInt(text.replace(/_/g, ""));
  const number = Number(big);
  return Number.isSafeInteger(number) ? number : big;
}

/** Split the source into tokens; newlines only matter outside brackets. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const stack: string[] = [];
  const push = (k: Kind, t: string, v?: unknown): void => { out.push(v === undefined ? { k, t } : { k, t, v }); };
  let at = 0;
  let lineStart = true;
  let block = false;
  while (at < src.length) {
    const char = src[at]!;
    if (char === "\n") {
      at += 1;
      if (stack.length) continue;
      const last = out[out.length - 1];
      // A line ending in `:` opens a suite, so the next line may be indented.
      block = last !== undefined && last.k === "op" && last.t === ":";
      push("nl", "\n");
      lineStart = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\f") {
      if (!lineStart || stack.length) { at += 1; continue; }
      let probe = at;
      while (probe < src.length && (src[probe] === " " || src[probe] === "\t")) probe += 1;
      const next = src[probe];
      // An unexpected indent is Python's IndentationError, i.e. our SYNTAX.
      if (next !== undefined && next !== "\n" && next !== "#" && !block) fail(SYNTAX);
      at = probe;
      continue;
    }
    if (char === "#") {
      while (at < src.length && src[at] !== "\n") at += 1;
      continue;
    }
    lineStart = false;
    block = false;
    if (char === "\\" && src[at + 1] === "\n") { at += 2; continue; }
    if (char === '"' || char === "'" || /[A-Za-z_]/.test(char)) {
      const match = STRING.exec(src.slice(at));
      if (match && PREFIXES.has(match[1]!.toLowerCase())) {
        const literal = readString(src, at);
        push(literal.plain ? "str" : "other", src.slice(at, literal.end), literal.value);
        at = literal.end;
        continue;
      }
      if (!/[A-Za-z_]/.test(char)) fail(SYNTAX);
      let end = at;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end]!)) end += 1;
      push("name", src.slice(at, end));
      at = end;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(src[at + 1] ?? ""))) {
      const text = NUMBER.exec(src.slice(at))![0];
      const imaginary = text.endsWith("j") || text.endsWith("J");
      const body = imaginary ? text.slice(0, -1) : text;
      if (imaginary) push("other", text);
      else if (/[.eE]/.test(body) && !/^0[xXbBoO]/.test(body)) push("num", text, pyFloatValue(Number(body.replace(/_/g, ""))));
      else push("num", text, intValue(body));
      at += text.length;
      continue;
    }
    const op = OPS.find((candidate) => src.startsWith(candidate, at));
    if (op === undefined) fail(SYNTAX);
    if (op === "(" || op === "[" || op === "{") {
      if (stack.length >= MAX_BRACKETS) fail(SYNTAX);
      stack.push(op);
    } else if (op === ")" || op === "]" || op === "}") {
      if (stack.pop() !== CLOSER[op]) fail(SYNTAX);
    }
    push("op", op);
    at += op.length;
  }
  if (stack.length) fail(SYNTAX);
  push("eof", "");
  return out;
}
