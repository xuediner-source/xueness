/**
 * Python numbers that a JS `number` cannot represent faithfully.
 *
 * Session journals are rewritten by both backends during the migration, and
 * the history log hashes the canonical JSON of every revision. A JS number
 * cannot tell Python's `2.0` (a float) from `2` (an int), and loses integers
 * beyond 2**53. Lossless decoding therefore keeps:
 *
 * - integral floats (`2.0`, `-0.0`, `1e16`) as `JsonFloat`;
 * - integers outside the safe range as `bigint`;
 * - every other number as a plain `number` (ints when integral, floats otherwise).
 *
 * Encoders print `JsonFloat` with `repr(float)` and `bigint` as decimal digits,
 * so a decode/encode round trip reproduces Python's bytes.
 */

/** A Python float whose value is integral, kept distinct from an int. */
export class JsonFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }

  valueOf(): number {
    return this.value;
  }

  toJSON(): number {
    return this.value;
  }
}

/** A value Python would create as a float: integral results stay floats. */
export function pyFloatValue(value: number): number | JsonFloat {
  return Number.isInteger(value) || Object.is(value, -0) ? new JsonFloat(value) : value;
}

/** `type(value) is int`: an integral JS number or a bigint (never a bool or `JsonFloat`). */
export function isPyIntValue(value: unknown): value is number | bigint {
  return (typeof value === "number" && Number.isInteger(value)) || typeof value === "bigint";
}

/** `type(value) is float`: a non-integral JS number or a `JsonFloat`. */
export function isPyFloatValue(value: unknown): value is number | JsonFloat {
  return value instanceof JsonFloat || (typeof value === "number" && !Number.isInteger(value));
}

/** `type(value) in (int, float)` (bools excluded). */
export function isPyNumeric(value: unknown): value is number | bigint | JsonFloat {
  return typeof value === "number" || typeof value === "bigint" || value instanceof JsonFloat;
}

/** The numeric value of an int, float or bool (`True == 1` in Python). */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof JsonFloat) return value.value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}
