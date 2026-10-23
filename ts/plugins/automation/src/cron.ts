/**
 * Timezone-aware five-field cron (Python `automation/scheduler.py`: `_field`,
 * `cron`, `next_run`).
 *
 * Python reads the local wall clock through `zoneinfo.ZoneInfo`. Node has no
 * zone database API, so the offset comes from a cached `Intl.DateTimeFormat`
 * bound to the same IANA key, and the local wall clock is `utc + offset` — the
 * same arithmetic `datetime.astimezone()` performs, including for a UTC instant
 * inside a repeated or skipped local hour (one UTC instant maps to exactly one
 * wall clock, so there is no `fold` ambiguity to resolve).
 *
 * `nextRun` visits exactly the candidate instants Python's minute loop visits.
 * To avoid one formatter call per minute it keeps the offset and re-reads it
 * only once the zone's next transition is reached, found by geometric probing
 * plus a second-granularity bisection (`Zone.nextChange`). Which instants are
 * visited, and which of them match, is unchanged.
 */
import { PyValueError, pyInt, pyIsSpace, pyLen } from "@xueness/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** `for _ in range(366*24*60)`. */
const SEARCH_MINUTES = 366 * 24 * 60;
/** Longest gap between two offset probes (see `Zone.nextChange`). */
const MAX_PROBE_MS = 24 * HOUR_MS;

/** Field bounds in schedule order: minute, hour, day-of-month, month, day-of-week. */
const BOUNDS: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/** `str.split()`: split on runs of Python whitespace, dropping the empty edges. */
function pyWhitespaceSplit(text: string): string[] {
  const words: string[] = [];
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (pyIsSpace(text.charCodeAt(index))) {
      if (start >= 0) {
        words.push(text.slice(start, index));
        start = -1;
      }
    } else if (start < 0) start = index;
  }
  if (start >= 0) words.push(text.slice(start));
  return words;
}

/**
 * One cron field (`_field`): `*`, `a`, `a-b`, each optionally followed by
 * `/step`, and comma-separated lists of those. The step is validated before the
 * base is read, exactly as in Python.
 */
export function cronField(text: string, lo: number, hi: number): Set<number> {
  const values = new Set<number>();
  for (const chunk of text.split(",")) {
    const slash = chunk.indexOf("/");
    const base = slash < 0 ? chunk : chunk.slice(0, slash);
    const step = slash < 0 ? 1 : pyInt(chunk.slice(slash + 1));
    if (step < 1 || step > hi + 1) throw new PyValueError("invalid cron step");
    let first: number;
    let last: number;
    if (base === "*") {
      first = lo;
      last = hi;
    } else if (base.includes("-")) {
      // `first,last=map(int,base.split('-'))`: the wrong arity is a ValueError too.
      const bounds = base.split("-");
      if (bounds.length !== 2) throw new PyValueError("too many values to unpack (expected 2)");
      first = pyInt(bounds[0] as string);
      last = pyInt(bounds[1] as string);
    } else {
      first = pyInt(base);
      last = first;
    }
    if (first < lo || last > hi || first > last) throw new PyValueError("cron field out of range");
    for (let value = first; value <= last; value += step) values.add(value);
  }
  if (values.size === 0) throw new PyValueError("empty cron field");
  return values;
}

/** `cron(schedule)`: exactly five whitespace-separated fields, at most 200 characters. */
export function cron(schedule: unknown): Set<number>[] {
  if (typeof schedule !== "string" || pyLen(schedule) > 200) throw new PyValueError("schedule must have five cron fields");
  const words = pyWhitespaceSplit(schedule);
  if (words.length !== 5) throw new PyValueError("schedule must have five cron fields");
  return words.map((word, index) => cronField(word, BOUNDS[index]![0], BOUNDS[index]![1]));
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of `daysFromCivil`: `[month, day]` (`civil_from_days`). */
function civilFromDays(days: number): [number, number] {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return [month, day];
}

/** One IANA zone, read through `Intl.DateTimeFormat`. */
class Zone {
  readonly #format: Intl.DateTimeFormat;

  constructor(tz: string) {
    this.#format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  /** `utcoffset()` at one instant, in milliseconds (`local wall clock - utc`). */
  offsetAt(utcMs: number): number {
    let year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0;
    for (const part of this.#format.formatToParts(utcMs)) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
      else if (part.type === "hour") hour = Number(part.value);
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "second") second = Number(part.value);
    }
    const local = daysFromCivil(year, month, day) * DAY_MS + ((hour * 60 + minute) * 60 + second) * 1000;
    return local - utcMs;
  }

  /**
   * The first instant in `(from, limit]` whose offset differs from `offset`, or
   * `limit` when the offset holds to the end of the window.
   *
   * Probes widen geometrically up to a day, then the bracketing second is found
   * by bisection. Every IANA transition falls on a whole second, so the result
   * is the exact transition. A zone that changed offset and changed back inside
   * one probe gap would be missed; no IANA zone does that between transitions a
   * day or less apart.
   */
  nextChange(from: number, offset: number, limit: number): number {
    let low = from;
    let step = HOUR_MS;
    let high = Math.min(from + step, limit);
    for (;;) {
      if (this.offsetAt(high) !== offset) break;
      if (high >= limit) return limit;
      low = high;
      step = Math.min(step * 2, MAX_PROBE_MS);
      high = Math.min(low + step, limit);
    }
    while (high - low > 1000) {
      const middle = low + Math.round((high - low) / 2000) * 1000;
      if (middle <= low || middle >= high) break;
      if (this.offsetAt(middle) === offset) low = middle;
      else high = middle;
    }
    return high;
  }
}

const ZONES = new Map<string, Zone>();

/** `ZoneInfoNotFoundError`: the key is well formed but no such zone is installed. */
function unknownZone(tz: string): never {
  throw new PyValueError(`No time zone found with key ${tz}`);
}

/**
 * `ZoneInfo(tz)`. Python raises `ZoneInfoNotFoundError` (a `KeyError`) for an
 * unknown key and `ValueError` for a key that is not a normalized relative
 * path; both are `PyValueError` here, which every caller maps to the same 400.
 *
 * `Intl` is more permissive than the zone database in two ways, both closed
 * below: it accepts UTC-offset keys (`+05:00`) and it matches names
 * case-insensitively. Case is still decided by `Intl`, so a key Python would
 * reject as unnormalized (`asia/shanghai`) is accepted here — there is no
 * case-sensitive zone index in Node to check against.
 */
function zoneFor(tz: string): Zone {
  const cached = ZONES.get(tz);
  if (cached) return cached;
  if (tz.split("/").some((component) => component === "" || component === "." || component === "..")) {
    throw new PyValueError(`ZoneInfo keys must be normalized relative paths, got: ${tz}`);
  }
  if (tz.startsWith("+") || tz.startsWith("-")) unknownZone(tz);
  let zone: Zone;
  try {
    zone = new Zone(tz);
  } catch {
    unknownZone(tz);
  }
  ZONES.set(tz, zone);
  return zone;
}

/**
 * Return `tz` when the zone database knows it. Python raises
 * `ZoneInfoNotFoundError` (a `KeyError`); this port raises `PyValueError`,
 * which the automation routes turn into the same 400.
 */
export function validZone(tz: unknown): string {
  if (typeof tz !== "string") throw new PyValueError("invalid timezone");
  zoneFor(tz);
  return tz;
}

/**
 * `next_run(schedule, tz, after)`: the first matching UTC instant strictly
 * after `after`'s minute, in seconds.
 *
 * The day matches with AND when either the day-of-month or the day-of-week
 * field is `*`, and with OR when both are restricted — Python's
 * `day = dom and dow if dom_any or dow_any else dom or dow`. `weekday()` is
 * Monday=0 there, so `(weekday + 1) % 7` yields the cron numbering, Sunday=0.
 *
 * `after` is a `datetime.fromtimestamp` argument, so it is first rounded to the
 * nearest microsecond, as CPython does, and only then truncated to the minute.
 * The two differ only within half a microsecond of a minute boundary.
 */
export function nextRun(schedule: string, tz: string, after: number): number {
  const fields = cron(schedule);
  const zone = zoneFor(tz);
  const words = pyWhitespaceSplit(schedule);
  const domAny = words[2] === "*";
  const dowAny = words[4] === "*";
  const minutes = fields[0] as Set<number>;
  const hours = fields[1] as Set<number>;
  const daysOfMonth = fields[2] as Set<number>;
  const months = fields[3] as Set<number>;
  const daysOfWeek = fields[4] as Set<number>;
  const start = Math.floor(Math.round(after * 1_000_000) / (60 * 1_000_000)) * MINUTE_MS + MINUTE_MS;
  const limit = start + SEARCH_MINUTES * MINUTE_MS;
  let cursor = start;
  let offset = zone.offsetAt(cursor);
  let until = zone.nextChange(cursor, offset, limit);
  while (cursor < limit) {
    if (cursor >= until) {
      offset = zone.offsetAt(cursor);
      until = zone.nextChange(cursor, offset, limit);
    }
    const local = cursor + offset;
    const days = Math.floor(local / DAY_MS);
    const millisOfDay = local - days * DAY_MS;
    const [month, dayOfMonth] = civilFromDays(days);
    const dom = daysOfMonth.has(dayOfMonth);
    const dow = daysOfWeek.has((((days + 4) % 7) + 7) % 7);
    const day = domAny || dowAny ? dom && dow : dom || dow;
    if (day && minutes.has(Math.floor(millisOfDay / MINUTE_MS) % 60)
      && hours.has(Math.floor(millisOfDay / HOUR_MS)) && months.has(month)) {
      return cursor / 1000;
    }
    cursor += MINUTE_MS;
  }
  throw new PyValueError("schedule has no occurrence in the next year");
}
