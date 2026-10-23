/**
 * Off-peak windows, time zones, host idleness and the immutable one-node plan
 * (Python `bundled_plugins/automation/off_peak.py`, lines 28-168).
 *
 * A window is a pair of wall-clock `HH:MM` bounds in one IANA zone; a start
 * after the end wraps past midnight. Zone conversion goes through a cached
 * `Intl.DateTimeFormat` (hour cycle h23), and a wall clock resolves back to an
 * instant under Python's `fold` rules (PEP 495): an ambiguous time is its first
 * occurrence for `fold=0`, a time skipped by a spring-forward gap uses the
 * offset in effect before the gap, and `astimezone()` keeps the fold of the
 * instant it converted, which `nextWindowOpen` carries through.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  isDict, pyEncodeUtf8, pyFloatValue, pyJsonDumps, pyJsonLoadsBytes, pyLen, pySlice, pyStr, pyStrip,
  pyTruthy, PyValueError,
} from "@xueness/contracts";
import { isLink, pyCodeCompare, realish } from "@xueness/sessions";

export type Row = Record<string, unknown>;

export const QUEUE_FILE = "offpeak.json";
export const SETTINGS_FILE = "offpeak-settings.json";
export const LOCK_FILE = ".offpeak.lock";

/** Window bounds are wall-clock minutes; a start after the end spans midnight. */
export const DEFAULT_WINDOW: Readonly<Row> = Object.freeze({ start: "00:00", end: "08:00" });
/** Python's `([01]\d|2[0-3]):([0-5]\d)\Z`; a JS `$` without `m` matches only at the very end. */
const CLOCK_FIELD = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** `Intl` accepts raw UTC offsets such as `+05:00`; `ZoneInfo` never does. */
const OFFSET_ZONE = /^[+-]/;
const WORKFLOW_ID = /^[a-f0-9]{32}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_KEYS = ["id", "status", "created_at", "updated_at", "root", "concurrency"] as const;

export const MAX_TASKS = 50;
export const MAX_HISTORY = 20;
export const MAX_QUEUE_BYTES = 2_000_000;
export const MAX_SETTINGS_BYTES = 65_536;
export const MAX_NAME = 120;
export const MAX_PROMPT = 5_000;
export const MAX_MODEL_TEXT = 200;
export const MIN_DEADLINE = 60;
export const MAX_DEADLINE = 14_400;
export const DEFAULT_DEADLINE = 3_600;
/** `validate_plan` caps one node at an hour; the row deadline bounds the whole run. */
export const MAX_NODE_TIMEOUT = 3_600;

export const ADD_FIELDS: ReadonlySet<string> = new Set([
  "name", "prompt", "root", "model", "provider_id", "window", "timezone",
  "onlyWhenIdle", "deadlineSeconds", "confirm", "allowReal",
]);
export const SETTINGS_FIELDS: ReadonlySet<string> = new Set(["window", "timezone"]);
export const QUEUED = "queued";
export const RUNNING = "running";
/** `workflows.ACTIVE`: a run in one of these states still occupies the host. */
export const ACTIVE: ReadonlySet<unknown> = new Set(["queued", "running", "stopping", "pausing"]);

/** §4 of the interface contract: the cross-plugin seam, declared locally. */
export interface WorkflowBridge {
  create(plan: unknown, root: string, reuse?: unknown, ownerSession?: unknown): Row;
  launch(wid: string, approved?: boolean, allowReal?: boolean, expectedDigest?: string | null): Row;
  control(wid: string, action: unknown, concurrency?: unknown): Row;
  load(wid: string): Row;
  list(): Row[];
}

// ------------------------------------------------------------------ plugin switch

/** `PluginDisabled`, a `ValueError`: the HTTP family answers it with 403. */
export class PluginDisabled extends PyValueError {
  override name = "PluginDisabled";
}

/** `plugin_runtime.is_enabled`. The host binds the catalog probe; unbound means on. */
let pluginProbe: ((stateDir: string, pluginId: string) => boolean) | null = null;

export function bindPluginEnabled(probe: ((stateDir: string, pluginId: string) => boolean) | null): void {
  pluginProbe = probe;
}

/** `require_enabled(state_dir, 'automation')`. */
export function requireEnabled(stateDir: string, pluginId = "automation"): void {
  let enabled = true;
  if (pluginProbe !== null) {
    try { enabled = pluginProbe(stateDir, pluginId) === true; } catch { enabled = false; }
  }
  if (!enabled) throw new PluginDisabled(`plugin disabled or dependency unavailable: ${pluginId}`);
}

// ------------------------------------------------------------------ small ports

/** `row.get(key, None)`. */
export const pick = (row: Row, key: string): unknown => (Object.hasOwn(row, key) ? row[key] : null);

/** `str(exc) or exc.__class__.__name__`, as `_launch` falls back to. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : pyStr(error);
  if (message) return message;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name ? name : "Exception";
}

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function isSymlink(path: string): boolean {
  return isLink(path);
}

/** `Path(value).resolve()`; a NUL byte is Python's `ValueError: embedded null byte`. */
export function resolvePath(value: string): string {
  if (value.includes("\0")) throw new PyValueError("embedded null byte");
  return realish(value);
}

/** `Path(value).is_absolute()`: on Windows a rooted path without a drive is not absolute. */
export function pyIsAbsolute(value: string): boolean {
  if (process.platform !== "win32") return isAbsolute(value);
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

/** `_text`: a bounded, nonempty string, or `None` when optional and absent. */
export function text(value: unknown, field: string, maximum: number, required = false): string | null {
  if ((value === null || value === undefined) && !required) return null;
  if (typeof value !== "string" || !pyStrip(value) || pyLen(value) > maximum) {
    throw new PyValueError(`${field} 需要是 1 到 ${maximum} 个字符的文本`);
  }
  return pyStrip(value);
}

/** `time.time()` as the queue stores it: always a float, never an int. */
export const timestamp = (seconds: number): unknown => pyFloatValue(seconds);

/** `_append_history`: at most `MAX_HISTORY` entries, newest last. */
export function appendHistory(row: Row, entry: Row): Row[] {
  const stored = pick(row, "history");
  const history = Array.isArray(stored) ? (stored as Row[]) : [];
  const kept = history.slice(-(MAX_HISTORY - 1));
  kept.push(entry);
  row.history = kept;
  return kept;
}

/** `sorted(set(data) - fields)`, in code point order like Python's `sorted`. */
export function unknownFields(data: Row, allowed: ReadonlySet<string>): string[] {
  return Object.keys(data).filter((key) => !allowed.has(key)).sort(pyCodeCompare);
}

// ------------------------------------------------------------------ wall clock

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone; `null` is the process zone, as a bare `astimezone()` is. */
function formatterFor(timeZone: string | null): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = FORMATTERS.get(key);
  if (formatter === undefined) {
    const options: Intl.DateTimeFormatOptions = {
      hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    };
    if (timeZone !== null) options.timeZone = timeZone;
    // `hourCycle: "h23"` pins midnight to 0; `hour12: false` yields "24" on some ICU builds.
    formatter = new Intl.DateTimeFormat("en-US", options);
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

function wallClock(formatter: Intl.DateTimeFormat, instantMs: number): WallClock {
  const clock: WallClock = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(instantMs)) {
    switch (part.type) {
      case "year": clock.year = Number(part.value); break;
      case "month": clock.month = Number(part.value); break;
      case "day": clock.day = Number(part.value); break;
      case "hour": clock.hour = Number(part.value); break;
      case "minute": clock.minute = Number(part.value); break;
      case "second": clock.second = Number(part.value); break;
      default: break;
    }
  }
  return clock;
}

/** The wall clock read as if it were UTC, in milliseconds. */
function wallOf(formatter: Intl.DateTimeFormat, instantMs: number): number {
  const clock = wallClock(formatter, instantMs);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
}

/** The offsets in force around `wall`; a transition is never more than a day away. */
function nearbyOffsets(formatter: Intl.DateTimeFormat, wall: number): number[] {
  const offsets = new Set<number>();
  for (const delta of [-172_800_000, -86_400_000, -3_600_000, 0, 3_600_000, 86_400_000, 172_800_000]) {
    const second = Math.floor((wall + delta) / 1000) * 1000;
    offsets.add(wallOf(formatter, second) - second);
  }
  return [...offsets];
}

/** `local.replace(...).timestamp()` for a wall clock, under Python's `fold` rules. */
function instantForWall(formatter: Intl.DateTimeFormat, wall: number, fold: 0 | 1): number {
  const candidates = nearbyOffsets(formatter, wall).map((offset) => wall - offset).sort((a, b) => a - b);
  const valid = candidates.filter((instant) => wallOf(formatter, instant) === wall);
  const first = valid[0];
  const last = valid[valid.length - 1];
  // An ambiguous wall clock: `fold=0` is the first occurrence, `fold=1` the second.
  if (first !== undefined && last !== undefined && valid.length > 1) return fold === 1 ? last : first;
  if (first !== undefined) return first;
  // A wall clock inside a spring-forward gap: `fold=0` uses the offset in effect
  // before the gap, which is the candidate that lands after it.
  const before = candidates[0];
  const after = candidates[candidates.length - 1];
  if (before === undefined || after === undefined) return wall;
  return fold === 1 ? before : after;
}

/** `astimezone()`'s fold for an instant: 1 is the second pass of a repeated hour. */
function foldOf(formatter: Intl.DateTimeFormat, instantMs: number): 0 | 1 {
  const wall = wallOf(formatter, instantMs);
  const valid = nearbyOffsets(formatter, wall).map((offset) => wall - offset).filter((instant) => wallOf(formatter, instant) === wall);
  if (valid.length < 2) return 0;
  return instantMs >= Math.max(...valid) ? 1 : 0;
}

/** `_zone`: the IANA name, or `None` for an absent or empty one. */
export function zoneOf(name: unknown): string | null {
  if (name === null || name === undefined || name === "") return null;
  if (typeof name !== "string" || pyLen(name) > 64) throw new PyValueError("时区无效");
  let canonical: string;
  try { canonical = formatterFor(name).resolvedOptions().timeZone; } catch { throw new PyValueError("时区无法解析"); }
  if (OFFSET_ZONE.test(name) || OFFSET_ZONE.test(canonical)) throw new PyValueError("时区无法解析");
  return name;
}

/** `_wall_clock_minutes`: the local minute of day, 0..1439. */
export function wallClockMinutes(now: number, timezoneName: string | null = null): number {
  const clock = wallClock(formatterFor(zoneOf(timezoneName)), Math.floor(now * 1000));
  return clock.hour * 60 + clock.minute;
}

// -------------------------------------------------------------------- windows

/** `_clock_minutes`: an `HH:MM` wall-clock bound as a minute of day. */
export function clockMinutes(value: unknown, field: string): number {
  if (typeof value !== "string" || !CLOCK_FIELD.test(value)) throw new PyValueError(`${field} 需要是 HH:MM 时间`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

/** `window_span` as its bounds in minutes of day; the validation every caller shares. */
export function windowBounds(window: unknown): [number, number] {
  if (!isDict(window) || Object.keys(window).some((key) => key !== "start" && key !== "end")) {
    throw new PyValueError("闲时窗口只包含 start 与 end");
  }
  const start = clockMinutes(pick(window, "start"), "闲时窗口开始");
  const end = clockMinutes(pick(window, "end"), "闲时窗口结束");
  if (start === end) throw new PyValueError("闲时窗口的开始与结束时间不能相同");
  return [start, end];
}

/** The window's length in minutes; `22:00 -> 06:00` is `1440 - 22*60 + 6*60`. */
export function windowSpan(window: Row): number {
  const [start, end] = windowBounds(window);
  return start < end ? end - start : 24 * 60 - start + end;
}

/** `in_window`: half-open `[start, end)`, wrapping when start follows end. */
export function inWindow(now: number, window: Row, timezoneName: string | null = null): boolean {
  const [start, end] = windowBounds(window);
  const minute = wallClockMinutes(now, timezoneName);
  return start < end ? start <= minute && minute < end : minute >= start || minute < end;
}

/** `next_window_open`: the next instant the window starts, always strictly after `now`. */
export function nextWindowOpen(now: number, window: Row, timezoneName: string | null = null): number {
  const [start] = windowBounds(window);
  const formatter = formatterFor(zoneOf(timezoneName));
  const instant = Math.floor(now * 1000);
  const clock = wallClock(formatter, instant);
  // `opening += timedelta(days=1)` resets the fold; a bare `replace()` keeps it.
  const advance = clock.hour * 60 + clock.minute >= start;
  const midnight = Date.UTC(clock.year, clock.month - 1, clock.day) + (advance ? 86_400_000 : 0);
  const day = new Date(midnight);
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Math.floor(start / 60), start % 60, 0);
  return instantForWall(formatter, wall, advance ? 0 : foldOf(formatter, instant)) / 1000;
}

// ------------------------------------------------------------------ host idle

/**
 * `WorkflowStore(state).list()` without importing the workflows plugin: the same
 * directory, id filter, required fields and per-record `except ...: continue`.
 */
function runViews(state: string): Row[] {
  const directory = join(realish(state), "workflows");
  if (isSymlink(directory)) throw new PyValueError("workflow directory cannot be a symlink");
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const rows: Row[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !WORKFLOW_ID.test(name.slice(0, -5)) || isSymlink(join(directory, name))) continue;
    try {
      const record = pyJsonLoadsBytes(readFileSync(join(directory, name)));
      if (!isDict(record) || RUN_KEYS.some((key) => !Object.hasOwn(record, key))) continue;
      if (!isDict(record.plan) || !Object.hasOwn(record.plan, "name")) continue;
      rows.push(record);
    } catch { continue; }
  }
  return rows;
}

/**
 * `host_is_idle`: nothing else of this host is busy, i.e. no active workflow run
 * is in flight. An unreadable store counts as busy, as Python's
 * `except (OSError, ValueError)` does.
 */
export function hostIsIdle(state: string, bridge: WorkflowBridge | null = null): boolean {
  try {
    const runs = bridge === null ? runViews(state) : bridge.list();
    return !runs.some((run) => isDict(run) && ACTIVE.has(pick(run, "status")));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------- plan

/**
 * The single agent node `validate_plan` accepts for a task, in the key order
 * Python's `dict(node, kind=..., needs=..., cwd=..., timeout=...)` produces:
 * existing keys keep their place, and `needs` is new, so it lands last.
 */
function cleanNode(node: Row): Row {
  if (typeof node.id !== "string" || !NODE_ID.test(node.id)) throw new PyValueError("node ids must be unique names");
  if (node.kind !== "agent") throw new PyValueError("kind must be command or agent");
  const prompt = node.prompt;
  if (typeof prompt !== "string" || pyLen(prompt) < 1 || pyLen(prompt) > MAX_PROMPT) {
    throw new PyValueError("agent prompt must be 1..5000 characters");
  }
  const timeout = node.timeout;
  if (typeof timeout !== "number" || !(timeout > 0) || timeout > MAX_NODE_TIMEOUT) {
    throw new PyValueError("node timeout must be 0..3600 seconds");
  }
  for (const field of ["provider_id", "model"]) {
    const value = node[field];
    if (value !== undefined && (typeof value !== "string" || !value || pyLen(value) > MAX_MODEL_TEXT)) {
      throw new PyValueError("invalid model selection");
    }
  }
  return node;
}

/**
 * The digest an approval binds to. Python hashes `json.dumps(...)` with its
 * defaults (`ensure_ascii=True`, `", "`/`": "` separators), so the digest covers
 * the ASCII-escaped form — unlike `workflow_plan_digest`, which passes
 * `ensure_ascii=False`.
 */
export function planDigest(root: string, plan: Row): string {
  const body = pyJsonDumps({ root: realish(root), plan }, { sortKeys: true, ensureAscii: true });
  return createHash("sha256").update(pyEncodeUtf8(body)).digest("hex");
}

/** `plan_for(row)`: the one-node agent plan and the digest its approval binds to. */
export function planFor(row: Row): Row {
  const root = resolvePath(pyStr(pick(row, "root")));
  if (!isDirectory(root)) throw new PyValueError("工作区目录不存在");
  const node: Row = {
    id: "off_peak", kind: "agent", prompt: pick(row, "prompt"), cwd: ".",
    timeout: Math.min(Number(pick(row, "deadlineSeconds")), MAX_NODE_TIMEOUT),
  };
  for (const field of ["model", "provider_id"]) if (pyTruthy(pick(row, field))) node[field] = pick(row, field);
  node.needs = [];
  const plan: Row = { name: pySlice(pyStr(pick(row, "name")), MAX_NAME), nodes: [cleanNode(node)], concurrency: 1 };
  return { plan, digest: planDigest(root, plan) };
}
