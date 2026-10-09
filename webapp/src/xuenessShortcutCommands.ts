import { t as tr } from "./i18n";
import { isMacPlatform, isModKeyPressed, isImeComposingEvent } from "./xuenessShortcutDisplay";

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

export type ShortcutEventLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  repeat?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  compositionActive?: boolean;
};
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
  // 桌面端原生菜单 role 自带的加速键（编辑/视图/窗口），在 macOS 和 Windows 上都会
  // 被菜单先吃掉或与系统编辑操作冲突；统一保留，两端行为一致。
  "mod+a",
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+z",
  "mod+shift+z",
  "mod+y",
  "mod+0",
  "mod+=",
  "mod+-",
  "mod+h",
  "mod+m",
  "mod+ctrl+f",
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

export function matchesShortcut(
  event: ShortcutEventLike,
  chord: string,
  platform?: string,
): boolean {
  const parts = chord.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.at(-1);
  if (!key) return false;
  const eventKey = event.key === " "
    ? "space"
    : event.altKey && event.code && /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : event.key.toLowerCase();
  if (eventKey !== key) return false;
  const isMac = isMacPlatform(platform);
  const expectsCtrl = parts.includes("ctrl") || (parts.includes("mod") && !isMac);
  const expectsMeta = parts.includes("meta") || (parts.includes("mod") && isMac);
  return (
    expectsCtrl === Boolean(event.ctrlKey) &&
    expectsMeta === Boolean(event.metaKey) &&
    parts.includes("shift") === Boolean(event.shiftKey) &&
    parts.includes("alt") === Boolean(event.altKey)
  );
}

export function canonicalPhysicalBinding(binding: string, platform?: string): string | null {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) return null;
  const isMac = isMacPlatform(platform);
  const parts = normalized.split("+");
  const key = parts.pop()!;
  const mapped = parts.map((part) => {
    if (part === "Mod") return isMac ? "Meta" : "Ctrl";
    return part;
  });
  const order = isMac ? ["Meta", "Ctrl", "Alt", "Shift"] : ["Ctrl", "Meta", "Alt", "Shift"];
  const sorted = order.filter((m) => mapped.includes(m));
  return [...sorted, key].join("+");
}

export function isSamePhysicalBinding(a: string, b: string, platform?: string): boolean {
  const canA = canonicalPhysicalBinding(a, platform);
  const canB = canonicalPhysicalBinding(b, platform);
  return canA !== null && canA === canB;
}

export function findShortcutConflict(
  binding: string,
  commandId: ShortcutCommandId,
  overrides: Readonly<Record<string, string>>,
  platform?: string,
): ShortcutCommandId | null {
  const canonical = canonicalPhysicalBinding(binding, platform);
  if (!canonical) return null;
  for (const command of SHORTCUT_COMMANDS) {
    if (command.id === commandId) continue;
    const candidate = resolveShortcutBinding(command.id, overrides);
    if (!candidate) continue;
    const candidateCanonical = canonicalPhysicalBinding(candidate, platform);
    if (candidateCanonical && candidateCanonical === canonical) return command.id;
  }
  return null;
}

/** 判断目标是否为可编辑控件（input / textarea / select / contenteditable）。 */
export function isEditableTarget(target: unknown): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (typeof el.isContentEditable === "boolean" && el.isContentEditable) return true;
  if (typeof el.closest === "function") {
    return Boolean(el.closest("input, textarea, select, [contenteditable='true']"));
  }
  const tag = (target as { tagName?: string }).tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** 判断目标是否在终端区域内。 */
export function isTerminalTarget(target: unknown): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (typeof el.closest === "function") {
    return Boolean(el.closest(".xn-terminal-host, .xterm, .xterm-helper-textarea, [data-testid='terminal-pane']"));
  }
  const className = typeof el.className === "string" ? el.className : "";
  return className.includes("xterm") || className.includes("xn-terminal");
}

/** 判断目标是否在代码/diff/多行消息编辑器内。 */
export function isEditorTarget(target: unknown): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (typeof el.closest === "function") {
    return Boolean(el.closest(".xn-zc-editor, .xn-diff-view, [data-editor], .monaco-editor, .cm-editor"));
  }
  const className = typeof el.className === "string" ? el.className : "";
  return className.includes("editor") || className.includes("diff");
}

const EDITING_OPERATIONS = new Set(["a", "c", "v", "x", "z", "y"]);

/**
 * 检查全局快捷键与当前焦点所在的输入框、终端、编辑器之间是否存在冲突。
 * 若返回 true，全局快捷键分发应放行该事件，由宿主控件处理。
 */
export function hasGlobalShortcutConflict(
  event: ShortcutEventLike,
  commandId: ShortcutCommandId,
  target: unknown,
  platform?: string,
): boolean {
  if (isImeComposingEvent(event)) return true;

  const isMac = isMacPlatform(platform);

  // 终端冲突：
  // 终端依赖 Ctrl 控制码（Ctrl+A~Z）。
  // Windows/Linux 下 Mod 即 Ctrl，全局快捷键若劫持 Ctrl+B/Ctrl+K/Ctrl+N 会破坏 shell/tmux 控制。
  // macOS 下 Mod 为 ⌘ (metaKey)，与终端 shell 的 Ctrl (ctrlKey) 物理隔离；但若绑定显式 Ctrl 仍需放行。
  if (isTerminalTarget(target)) {
    if (!isMac) {
      if (event.ctrlKey && !event.altKey) return true;
    } else {
      if (event.ctrlKey && !event.metaKey) return true;
    }
  }

  // 输入框与编辑器冲突：
  if (isEditableTarget(target) || isEditorTarget(target)) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return true;
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return true;

    const keyLower = event.key.toLowerCase();
    const isPrimaryMod = isModKeyPressed(event, platform);
    if (isPrimaryMod && EDITING_OPERATIONS.has(keyLower)) return true;

    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "backspace", "delete"].includes(keyLower)) {
      return true;
    }
  }

  return false;
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
