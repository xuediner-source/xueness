/**
 * Revision operations of the session history log (`sessions/history.py`):
 * `digest`, `difference` and `apply`, with Python's equality, slicing and
 * exception rules so both backends write and replay the same chain.
 */
import { createHash } from "node:crypto";
import {
  isDict, isPyIntValue, JsonFloat, pyDeepCopy, pyEncodeUtf8, pyEquals, PyIndexError, pyIter, pyJsonDumps, PyKeyError,
  pyRepr, pyStartsWith, pySubstring, pyTruthy, PyTypeError, pyTypeName, PyValueError, setOwn,
} from "@xueness/contracts";

export type HistoryKey = string | number;

export interface HistoryOperation {
  op: "set" | "delete" | "append";
  path: HistoryKey[];
  value?: unknown;
}

/** `sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')))`. */
export function digest(value: unknown): string {
  const text = pyJsonDumps(value, { sortKeys: true, separators: [",", ":"] });
  return createHash("sha256").update(pyEncodeUtf8(text)).digest("hex");
}

function numberKind(value: unknown): "int" | "float" | null {
  if (isPyIntValue(value)) return "int";
  if (value instanceof JsonFloat || typeof value === "number") return "float";
  return null;
}

/**
 * Equality of canonical JSON encodings (key order aside), shared with
 * Python's corrected `difference`. Numeric representation edits such as
 * `1 -> 1.0`, `True -> 1` and `0.0 -> -0.0` must emit operations so replay
 * hashes to the record's `stateHash`.
 */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return typeof left !== "number" || !Object.is(left, -0) || Object.is(right, -0);
  const kind = numberKind(left);
  if (kind !== null || numberKind(right) !== null) {
    if (kind !== numberKind(right)) return false;
    if (typeof left === "bigint" || typeof right === "bigint") return typeof left === "bigint" && typeof right === "bigint" && left === right;
    const a = left instanceof JsonFloat ? left.value : (left as number);
    const b = right instanceof JsonFloat ? right.value : (right as number);
    return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
  }
  if ((left === null || left === undefined) && (right === null || right === undefined)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (isDict(left) && isDict(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]));
  }
  return false;
}

/** Bounded-path operations from `before` to `after`, using suffixes for growing text and lists. */
export function difference(before: unknown, after: unknown, path: readonly HistoryKey[] = []): HistoryOperation[] {
  if (jsonEquals(before, after)) return [];
  if (isDict(before) && isDict(after)) {
    // Python iterates a set difference here, in hash order; dict operations
    // commute, so any deterministic order replays to the same state.
    const out: HistoryOperation[] = Object.keys(before)
      .filter((key) => !Object.hasOwn(after, key))
      .map((key) => ({ op: "delete", path: [...path, key] }));
    for (const key of Object.keys(after)) {
      if (Object.hasOwn(before, key)) out.push(...difference(before[key], after[key], [...path, key]));
      else out.push({ op: "set", path: [...path, key], value: pyDeepCopy(after[key]) });
    }
    return out;
  }
  if (typeof before === "string" && typeof after === "string" && pyStartsWith(after, before)) {
    return [{ op: "append", path: [...path], value: after.slice(before.length) }];
  }
  if (Array.isArray(before) && Array.isArray(after) && after.length >= before.length) {
    const out: HistoryOperation[] = [];
    before.forEach((value, index) => out.push(...difference(value, after[index], [...path, index])));
    if (after.length > before.length) out.push({ op: "append", path: [...path], value: pyDeepCopy(after.slice(before.length)) });
    return out;
  }
  return [{ op: "set", path: [...path], value: pyDeepCopy(after) }];
}

function integerIndex(key: unknown): number | bigint | null {
  if (typeof key === "boolean") return key ? 1 : 0;
  if (isPyIntValue(key)) return key;
  return null;
}

function hashable(key: unknown): void {
  if (Array.isArray(key) || isDict(key)) throw new PyTypeError(`unhashable type: '${pyTypeName(key)}'`);
}

/** The JSON object key Python's encoder would print for a non-str dict key. */
function jsonKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key === true) return "true";
  if (key === false) return "false";
  if (key === null || key === undefined) return "null";
  return pyJsonDumps(key);
}

function position(length: number, key: unknown, kind: string, assignment = false): number {
  const index = integerIndex(key);
  if (index === null) {
    throw new PyTypeError(kind === "str" ? `string indices must be integers, not '${pyTypeName(key)}'`
      : `list indices must be integers or slices, not ${pyTypeName(key)}`);
  }
  const resolved = typeof index === "bigint" ? (index < 0n ? BigInt(length) + index : index) : (index < 0 ? length + index : index);
  if (resolved < 0 || resolved >= length) {
    throw new PyIndexError(`${kind === "str" ? "string" : "list"}${assignment ? " assignment" : ""} index out of range`);
  }
  return Number(resolved);
}

/** `container[key]` with Python's lookup rules for any JSON key. */
export function getItem(container: unknown, key: unknown): unknown {
  if (isDict(container)) {
    hashable(key);
    if (typeof key === "string" && Object.hasOwn(container, key)) return container[key];
    throw new PyKeyError(pyRepr(key));
  }
  if (Array.isArray(container)) return container[position(container.length, key, "list")];
  if (typeof container === "string") {
    const points = Array.from(container);
    return points[position(points.length, key, "str")];
  }
  throw new PyTypeError(`'${pyTypeName(container)}' object is not subscriptable`);
}

function setItem(container: unknown, key: unknown, value: unknown): void {
  if (isDict(container)) {
    hashable(key);
    setOwn(container, jsonKey(key), value);
    return;
  }
  if (Array.isArray(container)) {
    container[position(container.length, key, "list", true)] = value;
    return;
  }
  throw new PyTypeError(`'${pyTypeName(container)}' object does not support item assignment`);
}

function deleteItem(container: unknown, key: unknown): void {
  if (isDict(container)) {
    hashable(key);
    if (typeof key !== "string" || !Object.hasOwn(container, key)) throw new PyKeyError(pyRepr(key));
    delete container[key];
    return;
  }
  if (Array.isArray(container)) {
    container.splice(position(container.length, key, "list", true), 1);
    return;
  }
  throw new PyTypeError(`'${pyTypeName(container)}' object doesn't support item deletion`);
}

/** `path[:-1]` and `path[-1]` for a list or str path (other types raise like Python). */
function splitPath(path: unknown): [unknown[], unknown] {
  if (Array.isArray(path)) return [path.slice(0, -1), path[path.length - 1]];
  if (typeof path === "string") return [Array.from(pySubstring(path, 0, -1)), pySubstring(path, -1)];
  // Slices are hashable since Python 3.12, so a dict path is a failed lookup.
  if (isDict(path)) throw new PyKeyError("slice(None, -1, None)");
  throw new PyTypeError(`'${pyTypeName(path)}' object is not subscriptable`);
}

/** Replay `operations` onto `state`, raising where Python's `apply` raises. */
export function apply(state: unknown, operations: unknown): unknown {
  for (const item of pyIter(operations)) {
    const path = getItem(item, "path");
    if (!pyTruthy(path)) {
      if (!pyEquals(getItem(item, "op"), "set")) throw new PyValueError("invalid history root operation");
      state = pyDeepCopy(getItem(item, "value"));
      continue;
    }
    const [parents, key] = splitPath(path);
    let parent = state;
    for (const step of parents) parent = getItem(parent, step);
    if (pyEquals(getItem(item, "op"), "delete")) {
      deleteItem(parent, key);
    } else if (pyEquals(getItem(item, "op"), "set")) {
      setItem(parent, key, pyDeepCopy(getItem(item, "value")));
    } else if (pyEquals(getItem(item, "op"), "append")) {
      const target = getItem(parent, key);
      if (Array.isArray(target)) {
        target.push(...pyIter(pyDeepCopy(getItem(item, "value"))));
      } else if (typeof getItem(parent, key) === "string" && typeof getItem(item, "value") === "string") {
        setItem(parent, key, (getItem(parent, key) as string) + (getItem(item, "value") as string));
      } else {
        throw new PyValueError("invalid history append");
      }
    } else {
      throw new PyValueError("invalid history operation");
    }
  }
  return state;
}

/** Numeric comparison for `seq` values that may be bigints. */
export function compareInts(left: number | bigint, right: number | bigint): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Python ints stay JS numbers when safe, like the lossless decoder. */
export function normalizeInt(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}
