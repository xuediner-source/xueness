/**
 * `os_screenshot`, `os_windows` and `os_input` (F12.03): every call is
 * permission-checked against the session ledger, runs exactly one bounded
 * adapter interaction and is recorded in the evidence journal. An unwired
 * platform answers "unavailable" instead of acting.
 */
import { pyJsonDumps, type JsonSchema } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import type { EvidenceJournal } from "./journal.ts";
import type { PermissionLedger } from "./permissions.ts";
import type { OsAdapterPort, OsInputAction } from "./platform.ts";

type Row = Record<string, unknown>;
export const MAX_COORD = 32767;
export const MAX_TEXT_CHARS = 5000;
export const MAX_WINDOWS = 64;
export const MAX_PNG_BASE64 = 1_500_000;
export const KEYS = ["enter", "tab", "esc", "escape", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "space"] as const;

const BUTTONS = new Set(["left", "right", "middle"]);
const NAMED_KEYS = new Set<string>(KEYS);
const SESSION_FALLBACK = "anonymous";

const invalid = (message: string): ToolResult<Row> => ({ ok: false, output: message, error: { code: "invalid_argument", message } });
const denied = (scope: string): ToolResult<Row> => ({
  ok: false,
  output: `session has no active ${scope} grant for OS computer use`,
  error: { code: "permission_denied", message: `session has no active ${scope} grant for OS computer use` },
  user_reason: `OS computer-use ${scope} access was not granted to this session`,
});
const unavailable = (adapter: OsAdapterPort): ToolResult<Row> => {
  const message = `OS computer-use is unavailable on ${adapter.platform}${adapter.unavailableReason ? `: ${adapter.unavailableReason}` : ""}`;
  return { ok: false, output: message, error: { code: "execution_error", message }, user_reason: message };
};
const json = (data: Row): ToolResult<Row> => ({ ok: true, output: pyJsonDumps(data), data });

const coord = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COORD;
const bounded = (value: unknown, max: number): boolean => typeof value === "string" && value.length > 0 && value.length <= max;
const windowId = (value: unknown): boolean => value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 256);

/** Reject anything that is not exactly one well-formed action (no free-form scripts, ever). */
export function checkInputAction(action: unknown): OsInputAction {
  if (typeof action !== "object" || action === null || Array.isArray(action)) throw new Error("action must be an object");
  const row = action as Row;
  const allowed = new Set(["type", "windowId", ...(row.type === "click" ? ["x", "y", "button"] : row.type === "text" ? ["text"] : row.type === "key" ? ["key"] : ["x", "y", ...(row.type === "scroll" ? ["deltaY"] : [])])]);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error("unknown action field");
  const windowOk = windowId(row.windowId);
  if (row.type === "click") {
    if (!coord(row.x) || !coord(row.y) || !BUTTONS.has(String(row.button ?? "left")) || !windowOk) throw new Error("invalid click action");
    return { type: "click", x: row.x as number, y: row.y as number, ...(row.button !== undefined ? { button: row.button as "left" | "right" | "middle" } : {}), ...(row.windowId !== undefined ? { windowId: row.windowId as string } : {}) };
  }
  if (row.type === "double_click" || row.type === "scroll") {
    if (!coord(row.x) || !coord(row.y) || !windowOk) throw new Error(`invalid ${row.type} action`);
    if (row.type === "scroll" && (!Number.isSafeInteger(row.deltaY) || Math.abs(row.deltaY as number) > 10000)) throw new Error("invalid scroll action");
    return row.type === "scroll"
      ? { type: "scroll", x: row.x as number, y: row.y as number, deltaY: row.deltaY as number, ...(row.windowId !== undefined ? { windowId: row.windowId as string } : {}) }
      : { type: "double_click", x: row.x as number, y: row.y as number, ...(row.windowId !== undefined ? { windowId: row.windowId as string } : {}) };
  }
  if (row.type === "key") {
    const key = row.key;
    const single = typeof key === "string" && key.length === 1 && /\S/.test(key);
    if (!((single || (typeof key === "string" && NAMED_KEYS.has(key))) && windowOk)) throw new Error("invalid key action");
    return { type: "key", key, ...(row.windowId !== undefined ? { windowId: row.windowId as string } : {}) };
  }
  if (row.type === "text") {
    if (!bounded(row.text, MAX_TEXT_CHARS) || !windowOk) throw new Error("invalid text action");
    return { type: "text", text: row.text as string, ...(row.windowId !== undefined ? { windowId: row.windowId as string } : {}) };
  }
  throw new Error("unknown action type");
}

const screenshotSchema: JsonSchema = { type: "object", properties: { windowId: { type: "string", maxLength: 256 } }, additionalProperties: false } as JsonSchema;
const windowsSchema: JsonSchema = { type: "object", properties: {}, additionalProperties: false } as JsonSchema;
const inputSchema: JsonSchema = { type: "object", properties: { action: { type: "object" } }, required: ["action"], additionalProperties: false } as JsonSchema;

export interface OsCuaToolsOptions {
  adapter(): Promise<OsAdapterPort>;
  ledger: PermissionLedger;
  journal: EvidenceJournal;
  now?: () => number;
}

/** The session the call is charged to: the caller's session id, never a shared one. */
const sessionOf = (env: { owner?: string }): string => (typeof env.owner === "string" && env.owner ? env.owner : SESSION_FALLBACK);

export function osCuaTools(options: OsCuaToolsOptions): ToolDefinition<Row, Row>[] {
  const now = options.now ?? Date.now;
  type Admitted = { admitted: true; adapter: OsAdapterPort; session: string } | { admitted: false; refusal: ToolResult<Row> };
  const guard = async (scope: "screen" | "input", env: { owner?: string }, action: string, target?: string): Promise<Admitted> => {
    const session = sessionOf(env);
    if (!options.ledger.check(session, scope, now())) return { admitted: false, refusal: denied(scope) };
    const adapter = await options.adapter();
    if (!adapter.available) {
      options.journal.record({ sessionId: session, action, ...(target ? { target } : {}), detail: { refused: "unavailable", platform: adapter.platform } });
      return { admitted: false, refusal: unavailable(adapter) };
    }
    return { admitted: true, adapter, session };
  };
  const record = (session: string, action: string, target: string | undefined, detail: Row): { seq: number; at: string } =>
    options.journal.record({ sessionId: session, action, ...(target !== undefined ? { target } : {}), detail });

  const screenshot: ToolDefinition<Row, Row> = {
    name: "os_screenshot", description: "Capture one full-screen or window screenshot as in-memory PNG evidence; requires an active session screen grant; explicitly unavailable on platforms without a wired OS adapter",
    inputSchema: screenshotSchema, gate: "exec", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (input) => pyJsonDumps({ action: "screenshot", ...(input.windowId !== undefined ? { windowId: input.windowId } : {}) }),
    async run(input, env): Promise<ToolResult<Row>> {
      if (!windowId(input.windowId)) return invalid("invalid windowId");
      const admitted = await guard("screen", env, "screenshot", input.windowId as string | undefined);
      if (!admitted.admitted) return admitted.refusal;
      const capture = await admitted.adapter.captureScreen({ ...(input.windowId !== undefined ? { windowId: input.windowId as string } : {}) });
      if (typeof capture.pngBase64 !== "string" || capture.pngBase64.length > MAX_PNG_BASE64 || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)) {
        return invalid("adapter returned an invalid capture");
      }
      const evidence = record(admitted.session, "screenshot", input.windowId as string | undefined, { width: capture.width, height: capture.height, bytes: capture.pngBase64.length });
      return json({ ok: true, pngBase64: capture.pngBase64, width: capture.width, height: capture.height, ...(input.windowId !== undefined ? { windowId: input.windowId as string } : {}), evidence });
    },
  };

  const windows: ToolDefinition<Row, Row> = {
    name: "os_windows", description: "List toplevel windows (id, title, app, bounds, focus); requires an active session screen grant; explicitly unavailable on platforms without a wired OS adapter",
    inputSchema: windowsSchema, gate: "exec", mutating: false, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: () => pyJsonDumps({ action: "windows" }),
    async run(_input, env): Promise<ToolResult<Row>> {
      const admitted = await guard("screen", env, "windows", undefined);
      if (!admitted.admitted) return admitted.refusal;
      const listed = await admitted.adapter.listWindows();
      if (!Array.isArray(listed)) return invalid("adapter returned an invalid window list");
      const boundedList = listed.slice(0, MAX_WINDOWS).map((win, index) => ({ ...win, id: String(win.id ?? index), title: String(win.title ?? "").slice(0, 300), app: String(win.app ?? "").slice(0, 200), focused: win.focused === true }));
      const evidence = record(admitted.session, "windows", undefined, { count: boundedList.length });
      return json({ ok: true, windows: boundedList, truncated: listed.length > boundedList.length, evidence });
    },
  };

  const input: ToolDefinition<Row, Row> = {
    name: "os_input", description: "Perform exactly one OS input action (click, double_click, scroll, key, text), optionally window-relative via windowId; requires an active session input grant; explicitly unavailable on platforms without a wired OS adapter",
    inputSchema: inputSchema, gate: "exec", mutating: true, concurrencySafe: false, requires: {}, subjectKind: "text",
    subject: (value) => pyJsonDumps({ action: "input", input: value.action ?? null }),
    async run(value, env): Promise<ToolResult<Row>> {
      if (Object.keys(value).some((key) => key !== "action")) return invalid("unknown input field");
      let action: OsInputAction;
      try { action = checkInputAction(value.action); }
      catch (error) { return invalid(error instanceof Error ? error.message : "invalid action"); }
      const admitted = await guard("input", env, `input:${action.type}`, action.windowId);
      if (!admitted.admitted) return admitted.refusal;
      const outcome = await admitted.adapter.performInput(action);
      if (outcome.applied !== true) return { ok: false, output: "adapter did not apply the input action", error: { code: "execution_error", message: "adapter did not apply the input action" } };
      const evidence = record(admitted.session, `input:${action.type}`, action.windowId, { ...action });
      return json({ ok: true, applied: true, action, evidence });
    },
  };

  return [screenshot, windows, input];
}
