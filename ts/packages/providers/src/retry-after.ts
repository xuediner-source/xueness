/**
 * `Retry-After` parsing, ported from `_retry_after` and the standard
 * library's `email._parseaddr._parsedate_tz` / `parsedate_to_datetime`.
 *
 * Server-directed sleeps are clamped to [0, 2] seconds; anything that is
 * neither a Python float nor an RFC 2822 date falls back to 0.25 seconds.
 */
import { PyIndexError, pyFloat, pyInt } from "@xueness/contracts";
import { pyClamp } from "./errors.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ZONES: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400,
  CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700,
};
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const PY_DIGIT = /^[\p{Nd}\u00b2\u00b3\u00b9]/u;

/** `str.split()` without arguments. */
function pySplit(text: string): string[] {
  return text.split(PY_SPACE).filter((part) => part !== "");
}

function tryInt(text: string): number | null {
  try {
    return pyInt(text);
  } catch {
    return null;
  }
}

/** `_parsedate_tz`: [year, month, day, hour, minute, second, tzOffsetSeconds | null] or null. */
export function parsedateTz(input: string): [number, number, number, number, number, number, number | null] | null {
  if (!input) return null;
  let data = pySplit(input);
  if (data.length === 0) return null;
  const first = data[0] as string;
  if (first.endsWith(",") || DAYS.includes(first.toLowerCase())) data.shift();
  else {
    const comma = first.lastIndexOf(",");
    if (comma >= 0) data[0] = first.slice(comma + 1);
  }
  if (data.length === 3) {
    const stuff = (data[0] as string).split("-");
    if (stuff.length === 3) data = [...stuff, ...data.slice(1)];
  }
  if (data.length === 4) {
    const s = data[3] as string;
    let index = s.indexOf("+");
    if (index === -1) index = s.indexOf("-");
    if (index > 0) data.splice(3, 1, s.slice(0, index), s.slice(index));
    else data.push("");
  }
  if (data.length < 5) return null;
  let [dd, mm, yy, tm, tz] = data.slice(0, 5) as [string, string, string, string, string];
  if (!(dd && mm && yy)) return null;
  mm = mm.toLowerCase();
  if (!MONTHS.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MONTHS.includes(mm)) return null;
  }
  let month = MONTHS.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (dd.endsWith(",")) dd = dd.slice(0, -1);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (yy.endsWith(",")) {
    yy = yy.slice(0, -1);
    if (!yy) return null;
  }
  if (!PY_DIGIT.test(yy)) [yy, tz] = [tz, yy];
  // Python indexes `tm[-1]` here; an empty token raises IndexError, which
  // `parsedate_to_datetime` does not catch. Retry-After then propagates it.
  if (tm === "") throw new PyIndexError("string index out of range");
  if (tm.endsWith(",")) tm = tm.slice(0, -1);
  let clock = tm.split(":");
  let thh: string;
  let tmm: string;
  let tss = "0";
  if (clock.length === 2) [thh, tmm] = clock as [string, string];
  else if (clock.length === 3) [thh, tmm, tss] = clock as [string, string, string];
  else if (clock.length === 1 && (clock[0] as string).includes(".")) {
    clock = (clock[0] as string).split(".");
    if (clock.length === 2) [thh, tmm] = clock as [string, string];
    else if (clock.length === 3) [thh, tmm, tss] = clock as [string, string, string];
    else return null;
  } else return null;
  const numbers = [yy, dd, thh, tmm, tss].map(tryInt);
  if (numbers.some((value) => value === null)) return null;
  let [year, day, hour, minute, second] = numbers as [number, number, number, number, number];
  if (year < 100) year += year > 68 ? 1900 : 2000;
  let offset: number | null = null;
  const zone = tz.toUpperCase();
  if (Object.hasOwn(ZONES, zone)) offset = ZONES[zone] as number;
  else {
    offset = tryInt(zone);
    if (offset === 0 && zone.startsWith("-")) offset = null;
  }
  if (offset) {
    const sign = offset < 0 ? -1 : 1;
    const magnitude = Math.abs(offset);
    offset = sign * (Math.floor(magnitude / 100) * 3600 + (magnitude % 100) * 60);
  }
  return [year, month, day, hour, minute, second, offset];
}

function validDate(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return year >= 1 && year <= 9999 && day >= 1 && day <= days && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/** `parsedate_to_datetime(raw).timestamp()`; null where Python raises a caught error. */
export function parsedateToEpochSeconds(raw: string): number | null {
  const parsed = parsedateTz(raw);
  if (parsed === null) return null;
  const [year, month, day, hour, minute, second, offset] = parsed;
  if (!validDate(year, month, day, hour, minute, second)) return null;
  if (offset !== null && Math.abs(offset) >= 86_400) return null;
  const date = new Date(0);
  if (offset === null) {
    // "-0000" disclaims a zone: Python builds a naive datetime in local time.
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, 0);
  } else {
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second - offset, 0);
  }
  return date.getTime() / 1000;
}

/** `_retry_after(headers)` for one `Retry-After` value. */
export function retryAfterSeconds(raw: string | undefined | null, nowSeconds = Date.now() / 1000): number {
  let delay: number | null = null;
  if (raw) {
    try {
      delay = pyFloat(raw);
    } catch {
      const when = parsedateToEpochSeconds(raw);
      delay = when === null ? null : when - nowSeconds;
    }
  }
  return pyClamp(delay ?? 0.25, 0, 2);
}

/**
 * ZCode `parseRetryAfterMs`: the unclamped server-directed delay in
 * milliseconds, or null. `x-should-retry: false` disables it, `retry-after-ms`
 * wins over `retry-after`, which may be seconds or an HTTP date.
 */
export function retryAfterMilliseconds(header: (name: string) => string | undefined | null, nowMs = Date.now()): number | null {
  const should = header("x-should-retry")?.trim().toLowerCase();
  if (should === "false" || should === "0") return null;
  const milliseconds = header("retry-after-ms")?.trim();
  if (milliseconds) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const raw = header("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}
