/**
 * Python `str`, `round` and `datetime` behaviour that session code depends on.
 *
 * Python strings index code points, while JS strings index UTF-16 units; the
 * two only differ for astral characters and lone surrogates, so the helpers
 * keep a fast path for text without surrogates.
 */

const SURROGATE = /[\ud800-\udfff]/;

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `len(text)`: the number of code points (a lone surrogate counts as one). */
export function pyLen(text: string): number {
  if (!SURROGATE.test(text)) return text.length;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isHigh(text.charCodeAt(index)) && index + 1 < text.length && isLow(text.charCodeAt(index + 1))) index += 1;
    count += 1;
  }
  return count;
}

/** UTF-16 offset of code point `points` (clamped to the text). */
function unitOffset(text: string, points: number): number {
  let units = 0;
  let seen = 0;
  while (units < text.length && seen < points) {
    units += isHigh(text.charCodeAt(units)) && units + 1 < text.length && isLow(text.charCodeAt(units + 1)) ? 2 : 1;
    seen += 1;
  }
  return units;
}

/** `text[start:end]` with Python's code point indices (negative values count from the end). */
export function pySubstring(text: string, start = 0, end?: number): string {
  if (!SURROGATE.test(text)) return text.slice(start, end);
  const length = pyLen(text);
  const clamp = (value: number): number => (value < 0 ? Math.max(0, length + value) : Math.min(value, length));
  const from = clamp(start);
  const to = end === undefined ? length : clamp(end);
  if (to <= from) return "";
  return text.slice(unitOffset(text, from), unitOffset(text, to));
}

/** `text.startswith(prefix)`: a prefix may not end inside a surrogate pair of `text`. */
export function pyStartsWith(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  const cut = prefix.length;
  return !(cut > 0 && cut < text.length && isHigh(text.charCodeAt(cut - 1)) && isLow(text.charCodeAt(cut)));
}

/** `text.endswith(suffix)`: a suffix may not start inside a surrogate pair of `text`. */
export function pyEndsWith(text: string, suffix: string): boolean {
  if (!text.endsWith(suffix)) return false;
  const cut = text.length - suffix.length;
  return !(suffix.length > 0 && cut > 0 && isHigh(text.charCodeAt(cut - 1)) && isLow(text.charCodeAt(cut)));
}

function decompose(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0) return { mantissa: fraction, exponent: -1074 };
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/**
 * `round(value, ndigits)` for a float: the exact binary value rounded half to
 * even at `ndigits` decimals, then read back as the nearest double.
 */
export function pyRound(value: number, ndigits = 0): number {
  if (!Number.isFinite(value) || value === 0) return value;
  if (ndigits > 323) return value;
  if (ndigits < -308) return 0 * value;
  const { mantissa, exponent } = decompose(value);
  const scale = 10n ** BigInt(Math.abs(ndigits));
  let numerator = mantissa;
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  if (ndigits >= 0) numerator *= scale;
  else denominator *= scale;
  let quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  const sign = value < 0 ? "-" : "";
  const result = Number(`${sign}${quotient}e${ndigits >= 0 ? -ndigits : Math.abs(ndigits)}`);
  return result === 0 && value < 0 ? -0 : result;
}

let anchorWallMicros = BigInt(Date.now()) * 1000n;
let anchorMonotonic = process.hrtime.bigint();

/** Wall-clock microseconds since the epoch (monotonic between re-anchors). */
export function pyTimeMicros(): bigint {
  const elapsed = (process.hrtime.bigint() - anchorMonotonic) / 1000n;
  const now = anchorWallMicros + elapsed;
  const wall = BigInt(Date.now()) * 1000n;
  const drift = now - wall;
  if (drift > 2000n || drift < -2000n) {
    anchorWallMicros = wall;
    anchorMonotonic = process.hrtime.bigint();
    return wall;
  }
  return now;
}

const pad = (value: number, size = 2): string => String(value).padStart(size, "0");

/**
 * `datetime.fromtimestamp(t, timezone.utc).isoformat(timespec=...)`:
 * `auto` prints microseconds unless they are zero; `milliseconds` always
 * prints three truncated digits.
 */
export function pyUtcIsoformat(micros: bigint, timespec: "auto" | "milliseconds" | "seconds" = "auto"): string {
  const millis = micros / 1000n - (micros % 1000n < 0n ? 1n : 0n);
  const date = new Date(Number(millis));
  const fraction = Number(((micros % 1_000_000n) + 1_000_000n) % 1_000_000n);
  const base = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T`
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  let tail = "";
  if (timespec === "milliseconds") tail = "." + pad(Math.floor(fraction / 1000), 3);
  else if (timespec === "auto" && fraction !== 0) tail = "." + pad(fraction, 6);
  return `${base}${tail}+00:00`;
}

/** `datetime.now(timezone.utc).isoformat(timespec=...)`. */
export function pyUtcNow(timespec: "auto" | "milliseconds" | "seconds" = "auto"): string {
  return pyUtcIsoformat(pyTimeMicros(), timespec);
}

/** `uuid.uuid4().hex`. */
export function uuid4Hex(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
