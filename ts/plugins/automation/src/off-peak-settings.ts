/**
 * The off-peak window/time-zone settings (Python `OffPeakQueue.settings` and
 * `save_settings`). The document is one JSON file under
 * `<state>/offpeak-settings.json`, read and replaced through the same bounded
 * state layer the queue uses.
 */
import { isDict, PyValueError } from "@xueness/contracts";
import {
  DEFAULT_WINDOW, MAX_SETTINGS_BYTES, pick, requireEnabled, SETTINGS_FILE, SETTINGS_FIELDS,
  windowBounds, zoneOf, type Row,
} from "./off-peak.ts";
import { readStateFile, withQueueLock, writeStateJson } from "./off-peak-state.ts";

/** `_read(self.settings_path, MAX_SETTINGS_BYTES, '设置')` plus the default. */
export function readSettings(state: string): Row {
  const path = `${state}/${SETTINGS_FILE}`;
  const document = readStateFile(path, MAX_SETTINGS_BYTES, "设置");
  if (document === undefined) return { window: { ...DEFAULT_WINDOW }, timezone: null };
  if (!isDict(document) || Object.keys(document).some((key) => !SETTINGS_FIELDS.has(key))) {
    throw new PyValueError("闲时设置包含未知字段");
  }
  const window = isDict(document.window) ? document.window : { ...DEFAULT_WINDOW };
  windowBounds(window);
  const timezoneName = pick(document, "timezone");
  if (timezoneName !== null) zoneOf(timezoneName);
  return { window: { start: window.start, end: window.end }, timezone: timezoneName || null };
}

/** `save_settings`: validate against the current document, then atomically replace. */
export function writeSettings(state: string, data: unknown): Row {
  requireEnabled(state);
  if (!isDict(data) || Object.keys(data).some((key) => !SETTINGS_FIELDS.has(key))) {
    throw new PyValueError("闲时设置包含未知字段");
  }
  const current = readSettings(state);
  const currentWindow = current.window as Row;
  const rawWindow = Object.hasOwn(data, "window") ? data.window : currentWindow;
  if (!isDict(rawWindow)) throw new PyValueError("闲时窗口只包含 start 与 end");
  const window: Row = {
    start: pick(rawWindow, "start") || currentWindow.start,
    end: pick(rawWindow, "end") || currentWindow.end,
  };
  windowBounds(window);
  let timezoneName = Object.hasOwn(data, "timezone") ? data.timezone : (current.timezone as unknown);
  if (timezoneName !== null && timezoneName !== undefined) {
    zoneOf(timezoneName);
    timezoneName = timezoneName || null;
  } else {
    timezoneName = current.timezone ?? null;
  }
  const document: Row = { window, timezone: timezoneName };
  withQueueLock(state, () => writeStateJson(`${state}/${SETTINGS_FILE}`, document));
  return document;
}
