/**
 * Python value equality and copying for decoded JSON trees.
 *
 * Journal code compares and copies sessions the way Python does: `1 == 1.0`
 * and `True == 1` hold, dict equality ignores key order, and `copy.deepcopy`
 * keeps key order. `JsonFloat` and `bigint` (see `py-float.ts`) take part as
 * numbers.
 */
import { JsonFloat } from "./py-float.ts";
import { isDict } from "./python-compat.ts";

type Numeric = number | bigint | JsonFloat | boolean;

function isNumeric(value: unknown): value is Numeric {
  return typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof JsonFloat;
}

function numericEquals(left: Numeric, right: Numeric, nested: boolean): boolean {
  const a = typeof left === "boolean" ? (left ? 1 : 0) : left instanceof JsonFloat ? left.value : left;
  const b = typeof right === "boolean" ? (right ? 1 : 0) : right instanceof JsonFloat ? right.value : right;
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    const float = (typeof a === "bigint" ? b : a) as number;
    const integer = (typeof a === "bigint" ? a : b) as bigint;
    return Number.isInteger(float) && BigInt(float) === integer;
  }
  // json.loads hands out one shared NaN object, and container equality checks
  // identity first, so a NaN inside a list or dict equals that same NaN.
  if (Number.isNaN(a) && Number.isNaN(b)) return nested;
  return a === b;
}

/** Python `left == right` for JSON-shaped values. */
export function pyEquals(left: unknown, right: unknown, nested = false): boolean {
  if (left === right) return true;
  if (isNumeric(left) && isNumeric(right)) return numericEquals(left, right, nested);
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  if (typeof left === "string" || typeof right === "string") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => pyEquals(item, right[index], true));
  }
  if (isDict(left) && isDict(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && pyEquals(left[key], right[key], true));
  }
  return false;
}

/** Set `key` as an ordinary own property, even for `"__proto__"`. */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

/** `copy.deepcopy` for JSON-shaped values; key order is kept. */
export function pyDeepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => pyDeepCopy(item)) as T;
  if (isDict(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) setOwn(out, key, pyDeepCopy(value[key]));
    return out as T;
  }
  return value;
}

/** `dict(value)`: a shallow copy that keeps key order and `"__proto__"` keys. */
export function pyDictCopy(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) setOwn(out, key, value[key]);
  return out;
}
