/**
 * Python operators on JSON-shaped values, raising Python's exception types.
 *
 * Provider adapters classify failures by Python exception family: a
 * `KeyError` / `TypeError` / `AttributeError` while reading a response is a
 * protocol error, never a retryable transport failure. Porting expressions
 * such as `payload["choices"][0]["message"]` or `(x or {}).get("k")` keeps
 * that classification (and the reported exception name) only if indexing,
 * `.get`, `+` and iteration fail exactly where Python's would.
 */
import { JsonFloat } from "./py-float.ts";
import { isDict, pyRepr, pyStrip } from "./python-compat.ts";

/** Base class: `name` is the Python exception type that would be raised. */
export class PyException extends Error {}
export class PyValueError extends PyException {
  override name = "ValueError";
}
export class PyTypeError extends PyException {
  override name = "TypeError";
}
export class PyKeyError extends PyException {
  override name = "KeyError";
}
export class PyIndexError extends PyException {
  override name = "IndexError";
}
export class PyAttributeError extends PyException {
  override name = "AttributeError";
}

/** Python's type name for a JSON-shaped value. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "bigint") return "int";
  if (value instanceof JsonFloat) return "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return isDict(value) ? "dict" : typeof value;
}

function codePointsOf(text: string): string[] {
  return Array.from(text);
}

/** `container[key]` for dict, list and str containers. */
export function pyGetItem(container: unknown, key: string | number): unknown {
  if (isDict(container)) {
    if (typeof key === "string" && Object.hasOwn(container, key)) return container[key];
    throw new PyKeyError(pyRepr(key));
  }
  if (Array.isArray(container) || typeof container === "string") {
    if (typeof key !== "number") throw new PyTypeError(`${pyTypeName(container)} indices must be integers or slices, not str`);
    const items = Array.isArray(container) ? container : codePointsOf(container);
    const index = key < 0 ? items.length + key : key;
    if (index < 0 || index >= items.length) throw new PyIndexError(`${pyTypeName(container)} index out of range`);
    return items[index];
  }
  throw new PyTypeError(`'${pyTypeName(container)}' object is not subscriptable`);
}

/** `value.get(key, fallback)`: an `AttributeError` unless `value` is a dict. */
export function pyDictGet(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(value)) throw new PyAttributeError(`'${pyTypeName(value)}' object has no attribute 'get'`);
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** `iter(value)` for JSON-shaped values: lists, str code points and dict keys. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return codePointsOf(value);
  if (isDict(value)) return Object.keys(value);
  throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
}

function isPyNumber(value: unknown): value is number | boolean {
  return typeof value === "number" || typeof value === "boolean";
}

/** `left + right` for str, list and numeric (bool counts as int) operands. */
export function pyAdd(left: unknown, right: unknown): unknown {
  if (typeof left === "string" && typeof right === "string") return left + right;
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (isPyNumber(left) && isPyNumber(right)) return Number(left) + Number(right);
  throw new PyTypeError(`unsupported operand type(s) for +: '${pyTypeName(left)}' and '${pyTypeName(right)}'`);
}

/** `"".join(parts)`, which requires every item to be a str. */
export function pyJoin(parts: readonly unknown[], separator = ""): string {
  parts.forEach((part, index) => {
    if (typeof part !== "string") throw new PyTypeError(`sequence item ${index}: expected str instance, ${pyTypeName(part)} found`);
  });
  return parts.join(separator);
}

/**
 * A dict key with Python hash equality: `1`, `1.0` and `True` collide,
 * while lists and dicts are unhashable. The returned string is only an
 * identity; `pySortKeys` orders the originals.
 */
export function pyHashKey(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return `n:${value ? 1 : 0}`;
  if (typeof value === "number") return `n:${Object.is(value, -0) ? 0 : value}`;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? `n:${Number(value)}` : `b:${value}`;
  if (value instanceof JsonFloat) return `n:${Object.is(value.value, -0) ? 0 : value.value}`;
  if (typeof value === "string") return `s:${value}`;
  throw new PyTypeError(`unhashable type: '${pyTypeName(value)}'`);
}

function comparePoints(left: string, right: string): number {
  const a = codePointsOf(left);
  const b = codePointsOf(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const diff = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** `sorted(keys)` for hashable JSON keys; mixing str, numbers and None raises. */
export function pySortKeys<T>(keys: readonly T[]): T[] {
  if (keys.length < 2) return [...keys];
  const kinds = new Set(keys.map((key) => (isPyNumber(key) ? "number" : typeof key === "string" ? "str" : "none")));
  if (kinds.size > 1 || kinds.has("none")) {
    throw new PyTypeError("'<' not supported between instances of different types");
  }
  if (kinds.has("str")) return [...keys].sort((a, b) => comparePoints(String(a), String(b)));
  return [...keys].sort((a, b) => Number(a) - Number(b));
}

const FLOAT_TEXT = /^[+-]?(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;
const INT_TEXT = /^[+-]?[0-9](?:_?[0-9])*$/;

const DECIMAL = /\p{Nd}/u;

function decimalValue(char: string): string {
  // Unicode assigns decimal digits only in contiguous, ascending runs of ten
  // that start at zero, so the offset into a contiguous block gives the value.
  const point = char.codePointAt(0) as number;
  let start = point;
  while (start > 0 && DECIMAL.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((point - start) % 10);
}

/** The digit half of `_PyUnicode_TransformDecimalAndSpaceToASCII`: any decimal digit becomes ASCII. */
export function pyAsciiDigits(text: string): string {
  return /[^\x00-\x7f]/.test(text) ? text.replace(/\p{Nd}/gu, decimalValue) : text;
}

/**
 * `float(text)`: Python strips its own whitespace set, accepts any Unicode
 * decimal digit and underscores between digits.
 */
export function pyFloat(text: string): number {
  const body = pyAsciiDigits(pyStrip(text));
  const special = SPECIAL_FLOAT.exec(body);
  if (special) {
    if ((special[2] ?? "").toLowerCase() === "nan") return Number.NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!FLOAT_TEXT.test(body)) throw new PyValueError(`could not convert string to float: ${pyRepr(text)}`);
  return Number(body.replaceAll("_", ""));
}

/** `int(text)` (base 10), with Python's stripping, Unicode digits and underscores. */
export function pyInt(text: string): number {
  const body = pyAsciiDigits(pyStrip(text));
  if (!INT_TEXT.test(body)) throw new PyValueError(`invalid literal for int() with base 10: ${pyRepr(text)}`);
  const value = Number(body.replaceAll("_", ""));
  return value === 0 ? 0 : value;
}
