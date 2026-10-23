/**
 * Validation for implemented editor preferences and keyboard commands: a
 * port of Python `bundled_plugins/settings/preferences.py`. Values come from
 * a lossless JSON decode, so `type(x) is int` stays distinct from an
 * integral float (`7.0`), and bools never count as numbers.
 */
import { isDict, isPyIntValue, isPyNumeric, numericValue, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { realpathSync } from "node:fs";
import { which, WINDOWS } from "./paths.ts";

export const DEFAULT_BINDINGS: Readonly<Record<string, string>> = Object.freeze({
  "insert-newline": "Shift+Enter", "switch-theme": "Mod+Shift+L", "toggle-terminal": "Alt+Shift+J", "toggle-browser": "Mod+Alt+B",
  "zoom-in": "Alt+Shift+=", "zoom-out": "Alt+Shift+9", "reset-zoom": "Alt+Shift+0", "find-in-task": "Alt+Shift+F",
  "open-model-menu": "Alt+Shift+M", "open-mode-menu": "Alt+Shift+U", "open-reasoning-menu": "Alt+Shift+T", "open-workspace": "Alt+Shift+O",
  "new-session": "Mod+N", "command-palette": "Mod+K | Mod+Shift+P", "open-settings": "Mod+,", "toggle-sidebar": "Mod+B",
  "refresh-session": "Alt+Shift+R", "send-message": "Mod+Shift+Enter", "stop-generation": "Alt+Shift+S",
  "previous-session": "Mod+Shift+[", "next-session": "Mod+Shift+]", "session-back": "Mod+[", "session-forward": "Mod+]",
  "focus-previous-pane": "Alt+Shift+ArrowLeft", "focus-next-pane": "Alt+Shift+ArrowRight", "split-pane-right": "Alt+Shift+\\",
  "split-pane-down": "Alt+Shift+-", "close-pane": "Alt+Shift+W",
});
export const COMMANDS: readonly string[] = Object.freeze(Object.keys(DEFAULT_BINDINGS));
const SCOPE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  composer: ["insert-newline", "send-message", "stop-generation"],
  global: ["switch-theme", "toggle-terminal", "toggle-browser", "zoom-in", "zoom-out", "reset-zoom", "new-session", "command-palette", "open-settings", "toggle-sidebar", "refresh-session"],
  pane: ["find-in-task", "open-model-menu", "open-mode-menu", "open-reasoning-menu", "open-workspace", "focus-previous-pane", "focus-next-pane", "split-pane-right", "split-pane-down", "close-pane"],
  session: ["previous-session", "next-session", "session-back", "session-forward"],
};
export const COMMAND_SCOPES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(COMMANDS.map((command) => [command, Object.keys(SCOPE_GROUPS).find((scope) => SCOPE_GROUPS[scope]!.includes(command))!])));
export const TASK_AUTO_ARCHIVE_DAY_OPTIONS = Object.freeze([3, 7, 14, 30]);

const MODIFIER_ALIASES = new Map([["mod", "mod"], ["ctrl", "ctrl"], ["control", "ctrl"], ["meta", "meta"], ["command", "meta"], ["alt", "alt"], ["option", "alt"], ["shift", "shift"]]);
const MODIFIER_ORDER = ["mod", "ctrl", "meta", "alt", "shift"];
const KEYS = new Set([..."abcdefghijklmnopqrstuvwxyz0123456789.,/\\-=;[]`", "arrowleft", "arrowright", "arrowup", "arrowdown", "delete", "enter", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)]);
const RESERVED = new Set(["alt+f4", "ctrl+alt+delete", "mod+alt+delete", "f5", "f12", "mod+ctrl+f", "ctrl+meta+f"]);
for (const modifier of ["mod", "ctrl", "meta"]) {
  for (const key of "jlopqrstw") RESERVED.add(`${modifier}+${key}`);
  for (const key of "ijt") RESERVED.add(`${modifier}+shift+${key}`);
  for (const key of "acvxzy0=-hmf") RESERVED.add(`${modifier}+${key}`);
  RESERVED.add(`${modifier}+shift+z`);
}

const GENERAL_BOOLEANS = ["autoScroll", "showTodos", "collapseTools", "toolGroupingExploreEnabled", "toolGroupingTerminalEnabled", "toolGroupingChangesEnabled",
  "taskAutoArchiveEnabled", "messageStreamShowReasoning", "memoryEnabled", "sessionsEventsCursorEnabled", "sessionsEventResumeEnabled",
  "sessionsCancelReceiptEnabled", "sessionsCancelPropagateEnabled", "remoteFrameReplayEnabled", "remoteHandshakeEnabled",
  "desktopHostCapabilityEnabled", "desktopNotificationsEnabled", "sessionsAnswerQuestionEnabled", "sessionsAutoTitleEnabled",
  "toolsCallBudgetEnabled", "toolsDryRunEnabled"];

let shells: readonly string[] | undefined;
/** `terminal.shells.SHELL_PATHS`: fixed POSIX profiles, or the resolved Windows shells. */
export function shellPaths(): readonly string[] {
  if (shells) return shells;
  if (!WINDOWS) return shells = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].flatMap((directory) => ["sh", "bash", "zsh", "fish"].map((name) => `${directory}/${name}`));
  const found = ["pwsh.exe", "powershell.exe", "cmd.exe"].map(which).filter((value): value is string => !!value).map((value) => { try { return realpathSync.native(value); } catch { return value; } });
  return shells = [...new Set(found)];
}

/** `_normalize_shortcut`: one recorded chord in platform-neutral form, or null. */
export function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== "string" || pyLen(value) > 64) return null;
  if (value === "") return "";
  const parts = value.split("+").map((part) => pyStrip(part).toLowerCase());
  if (parts.length < 2 && parts[0] !== "enter" || parts.some((part) => !part)) return null;
  const key = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1).map((part) => MODIFIER_ALIASES.get(part));
  if (modifiers.some((modifier) => modifier === undefined) || new Set(modifiers).size !== modifiers.length || !KEYS.has(key)) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)), key].join("+");
}

/** `_is_reserved_shortcut`: `Mod` is checked as both Control and Command. */
export function isReservedShortcut(normalized: string): boolean {
  if (!normalized) return false;
  const parts = normalized.split("+");
  return RESERVED.has(normalized) || ["ctrl", "meta"].some((platform) => RESERVED.has(parts.map((part) => part === "mod" ? platform : part).join("+")));
}

function platformShortcut(normalized: string, platform: string): string {
  const parts = normalized.split("+");
  return [...parts.slice(0, -1).map((part) => part === "mod" ? platform : part).sort(), parts[parts.length - 1]].join("+");
}

function fail(message: string): never { throw new PyValueError(message); }
const has = (values: Record<string, unknown>, key: string): boolean => Object.hasOwn(values, key);
const isInt = (value: unknown, low: number, high: number): boolean => isPyIntValue(value) && (numericValue(value) as number) >= low && (numericValue(value) as number) <= high;
/** Python `value in (2, 4, 8)`: numeric equality, where `True == 1`. */
const numericIn = (value: unknown, options: readonly number[]): boolean => (isPyNumeric(value) || typeof value === "boolean") && options.includes(numericValue(value) as number);
const oneOf = (value: unknown, options: readonly string[]): boolean => typeof value === "string" && options.includes(value);

function validateBindings(bindings: unknown): void {
  if (!isDict(bindings) || Object.keys(bindings).some((key) => !COMMANDS.includes(key))) fail("unknown keyboard command");
  const effective: Record<string, unknown> = { ...DEFAULT_BINDINGS, ...(bindings as Record<string, unknown>) };
  const seen = new Map(Object.keys(SCOPE_GROUPS).map((scope) => [scope, { mac: new Set<string>(), other: new Set<string>() }]));
  for (const [command, combo] of Object.entries(effective)) {
    if (typeof combo !== "string" || pyLen(combo) > 256) fail("invalid keyboard binding");
    const alternatives = (combo as string).split("|");
    if (alternatives.length > 4) fail("too many keyboard bindings");
    for (const alternative of alternatives) {
      const normalized = normalizeShortcut(pyStrip(alternative));
      if (normalized === null || !normalized && alternatives.length > 1) fail("invalid keyboard binding");
      if (normalized === "enter" && COMMAND_SCOPES[command] !== "composer") fail("Enter is composer-only");
      if (!normalized) continue;
      if (isReservedShortcut(normalized)) fail("keyboard binding is reserved: " + combo);
      const scope = seen.get(COMMAND_SCOPES[command] ?? "global")!;
      for (const [platform, modifier] of [["mac", "meta"], ["other", "ctrl"]] as const) {
        const chord = platformShortcut(normalized, modifier);
        if (scope[platform].has(chord)) fail("keyboard binding conflict: " + combo);
        scope[platform].add(chord);
      }
    }
  }
}

/** `validate(section, values)`: raises `ValueError` text on the first invalid value. */
export function validate(section: string, values: Record<string, unknown>): Record<string, unknown> {
  if (section === "general") {
    if (has(values, "defaultShell") && !oneOf(values.defaultShell, shellPaths())) fail("defaultShell must be a supported shell profile");
    if (has(values, "terminalFontFamily") && !oneOf(values.terminalFontFamily, ["system", "Menlo", "SFMono-Regular", "monospace"])) fail("unsupported terminal font family");
    if (has(values, "language") && !oneOf(values.language, ["zh", "en"])) fail("language must be zh or en");
    for (const key of GENERAL_BOOLEANS) if (has(values, key) && typeof values[key] !== "boolean") fail(`${key} must be boolean`);
    if (has(values, "toolsCallBudgetLimit") && !isInt(values.toolsCallBudgetLimit, 1, 10000)) fail("toolsCallBudgetLimit must be an integer from 1 to 10000");
    if (has(values, "taskAutoArchiveOlderThanDays") && !(isPyIntValue(values.taskAutoArchiveOlderThanDays) && numericIn(values.taskAutoArchiveOlderThanDays, TASK_AUTO_ARCHIVE_DAY_OPTIONS))) fail("taskAutoArchiveOlderThanDays must be 3, 7, 14 or 30");
  }
  if (section === "browser" && has(values, "browserControlEnabled") && typeof values.browserControlEnabled !== "boolean") fail("browserControlEnabled must be boolean");
  if (section === "agent" && has(values, "subagentCancelOneEnabled") && typeof values.subagentCancelOneEnabled !== "boolean") fail("subagentCancelOneEnabled must be boolean");
  if (section === "appearance") {
    if (has(values, "appZoom") && !(isPyNumeric(values.appZoom) && (numericValue(values.appZoom) as number) >= 0.75 && (numericValue(values.appZoom) as number) <= 1.5)) fail("appZoom must be .75..1.5");
    if (has(values, "theme") && !oneOf(values.theme, ["system", "light", "dark"])) fail("theme must be system, light or dark");
    if (has(values, "colorPalette") && !oneOf(values.colorPalette, ["xueness", "claude", "claudex"])) fail("colorPalette must be xueness or claudex");
    if (has(values, "fontSize") && !isInt(values.fontSize, 12, 24)) fail("fontSize must be 12..24");
    if (has(values, "terminalFontSize") && !isInt(values.terminalFontSize, 10, 24)) fail("terminalFontSize must be 10..24");
    if (has(values, "tabSize") && !numericIn(values.tabSize, [2, 4, 8])) fail("tabSize must be 2, 4 or 8");
    if (has(values, "wordWrap") && typeof values.wordWrap !== "boolean") fail("wordWrap must be boolean");
  }
  if (section === "shortcuts") {
    if (has(values, "sendShortcut") && !oneOf(values.sendShortcut, ["enter", "mod-enter"])) fail("sendShortcut must be enter or mod-enter");
    if (has(values, "bindings")) validateBindings(values.bindings);
    if (has(values, "shortcutScopes")) {
      const scopes = values.shortcutScopes;
      if (!isDict(scopes)) fail("shortcut scopes must be an object");
      for (const [command, scope] of Object.entries(scopes as Record<string, unknown>)) {
        if (!COMMANDS.includes(command) || scope !== COMMAND_SCOPES[command]) fail("shortcut scope does not match the command");
      }
    }
  }
  return values;
}