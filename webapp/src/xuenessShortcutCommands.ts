import { t as tr } from "./i18n";
import { isMacPlatform } from "./xuenessShortcutDisplay";

export type ShortcutCommandId =
  | "new-session"
  | "command-palette"
  | "open-settings"
  | "toggle-sidebar"
  | "refresh-session";

export type ShortcutCommand = {
  id: ShortcutCommandId;
  label: string;
  description: string;
  scope: "global";
  defaultBinding: string;
};

/**
 * Keep this registry aligned with the real handlers in
 * XuenessWorkbenchContainer. A command must not be added until that handler is
 * wired; the settings page never advertises inert shortcuts.
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  { id: "new-session", label: "新建任务", description: "开始一个新的任务。", scope: "global", defaultBinding: "Mod+N" },
  { id: "command-palette", label: "打开命令面板", description: "搜索任务和可用命令。", scope: "global", defaultBinding: "Mod+K" },
  { id: "open-settings", label: "打开设置", description: "打开工作台设置。", scope: "global", defaultBinding: "Mod+," },
  { id: "toggle-sidebar", label: "切换侧栏", description: "显示或收起任务侧栏。", scope: "global", defaultBinding: "Mod+B" },
  { id: "refresh-session", label: "刷新任务", description: "重新加载任务列表和当前任务。", scope: "global", defaultBinding: "Alt+Shift+R" },
] as const;

export const DEFAULT_SHORTCUT_BINDINGS: Readonly<Record<ShortcutCommandId, string>> =
  Object.fromEntries(SHORTCUT_COMMANDS.map((command) => [command.id, command.defaultBinding])) as Record<ShortcutCommandId, string>;

export type ShortcutEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { code?: string };
export type ShortcutRecordingResult =
  | { kind: "pending"; preview: string }
  | { kind: "invalid"; reason: "modifier-required" | "unsupported-key" | "reserved" }
  | { kind: "binding"; binding: string };

const MODIFIER_KEYS = new Set(["control", "ctrl", "shift", "alt", "meta", "command"]);
const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  Esc: "Escape",
  Del: "Delete",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
};
const MODIFIER_ORDER = ["Mod", "Ctrl", "Meta", "Alt", "Shift"] as const;

/** Browser/OS-owned keys should not be stored as app shortcuts. */
const RESERVED_SHORTCUTS = new Set([
  "alt+f4",
  "ctrl+alt+delete",
  "mod+alt+delete",
  "meta+alt+delete",
  "f5",
  "f12",
  "mod+j",
  "mod+l",
  "mod+o",
  "mod+p",
  "mod+q",
  "mod+r",
  "mod+s",
  "mod+shift+i",
  "mod+shift+j",
  "mod+shift+t",
  "mod+t",
  "mod+w",
]);

function canonicalKey(key: string): string | null {
  const alias = KEY_ALIASES[key] ?? key;
  if (/^[a-z]$/i.test(alias)) return alias.toUpperCase();
  if (/^[0-9]$/.test(alias)) return alias;
  if (/^F(?:[1-9]|1[0-2])$/i.test(alias)) return alias.toUpperCase();
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete"].includes(alias)) return alias;
  if ([".", ",", "/", "\\", "-", "=", ";", "[", "]", "`"].includes(alias)) return alias;
  return null;
}

function canonicalPhysicalKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const named: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Minus: "-", Equal: "=",
    Semicolon: ";", BracketLeft: "[", BracketRight: "]", Backquote: "`",
  };
  return named[code] ?? null;
}

export function normalizeShortcutBinding(value: string): string | null {
  if (!value.trim()) return "";
  const parts = value.split("+").map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  const rawKey = parts.pop()!;
  const key = canonicalKey(rawKey);
  if (!key) return null;
  const modifiers = parts.map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === "mod") return "Mod";
    if (normalized === "ctrl" || normalized === "control") return "Ctrl";
    if (normalized === "meta" || normalized === "command") return "Meta";
    if (normalized === "alt" || normalized === "option") return "Alt";
    if (normalized === "shift") return "Shift";
    return "";
  });
  if (modifiers.some((modifier) => !modifier) || new Set(modifiers).size !== modifiers.length) return null;
  if (modifiers.length === 0) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)), key].join("+");
}

export function isReservedShortcut(binding: string): boolean {
  const normalized = normalizeShortcutBinding(binding);
  return Boolean(normalized && RESERVED_SHORTCUTS.has(normalized.toLowerCase()));
}

export function recordShortcutEvent(event: ShortcutEventLike, platform?: string): ShortcutRecordingResult {
  const keyLower = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(keyLower)) {
    const pressed = keyLower === "control" || keyLower === "ctrl" ? "Ctrl"
      : keyLower === "meta" || keyLower === "command" ? (isMacPlatform(platform) ? "Mod" : "Meta")
        : keyLower === "alt" ? "Alt" : "Shift";
    return { kind: "pending", preview: `${pressed}…` };
  }
  if (event.key === "Escape" || event.key === "Backspace") {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  // Option/Alt can transform event.key into a glyph on some keyboard layouts
  // (for example Alt+Shift+R on macOS). Prefer the physical key when the
  // produced character is outside the set of keys the app can dispatch.
  const key = canonicalKey(event.key) ?? canonicalPhysicalKey(event.code ?? "");
  if (!key) return { kind: "invalid", reason: "unsupported-key" };
  const isMac = isMacPlatform(platform);
  const modifiers: string[] = [];
  if (event.metaKey && isMac) modifiers.push("Mod");
  if (event.ctrlKey && !isMac) modifiers.push("Mod");
  if (event.ctrlKey && isMac) modifiers.push("Ctrl");
  if (event.metaKey && !isMac) modifiers.push("Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!modifiers.length && (key === "F5" || key === "F12")) return { kind: "invalid", reason: "reserved" };
  const normalized = normalizeShortcutBinding([...modifiers, key].join("+"));
  if (!normalized) return { kind: "invalid", reason: "modifier-required" };
  if (isReservedShortcut(normalized)) return { kind: "invalid", reason: "reserved" };
  return { kind: "binding", binding: normalized };
}

export function resolveShortcutBinding(
  commandId: ShortcutCommandId,
  overrides: Readonly<Record<string, string>>,
): string {
  if (Object.hasOwn(overrides, commandId)) return overrides[commandId] ?? "";
  return DEFAULT_SHORTCUT_BINDINGS[commandId];
}

export function findShortcutConflict(
  binding: string,
  commandId: ShortcutCommandId,
  overrides: Readonly<Record<string, string>>,
): ShortcutCommandId | null {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) return null;
  for (const command of SHORTCUT_COMMANDS) {
    if (command.id === commandId) continue;
    const candidate = resolveShortcutBinding(command.id, overrides);
    if (candidate && normalizeShortcutBinding(candidate) === normalized) return command.id;
  }
  return null;
}

export function filterShortcutCommands(
  commands: readonly ShortcutCommand[],
  overrides: Readonly<Record<string, string>>,
  query: string,
): ShortcutCommand[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...commands];
  return commands.filter((command) => [command.id, tr(command.label), tr(command.description), resolveShortcutBinding(command.id, overrides)]
    .join(" ").toLocaleLowerCase().includes(needle));
}

export function restoreShortcutDefault(
  overrides: Readonly<Record<string, string>>,
  commandId: ShortcutCommandId,
): Record<string, string> {
  const next = { ...overrides };
  delete next[commandId];
  return next;
}
