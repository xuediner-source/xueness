import { PANE_CONTROL_COMMANDS } from './paneShortcutActions';
// Scoped session commands for sessions.scoped_commands.
// Settings persists the keymap and the scope of each command. Sessions registers
// composer rows, session navigation and pane actions only when both plugins are
// effective. Composer send/stop still run inside the composer; this module
// dispatches session navigation and focused workbench pane actions.

import { useEffect, useRef } from "react";
import { t as tr } from "../../i18n";
import { isImeComposingEvent, resolveHostPlatform } from "../../xuenessShortcutDisplay";
import {
  SHORTCUT_COMMANDS,
  composerOwnsShortcutEvent,
  findShortcutConflictIn,
  hasGlobalShortcutConflict,
  isEditableTarget,
  isEditorTarget,
  isReservedShortcut,
  isTerminalTarget,
  matchesShortcut,
  resolveShortcutBinding,
  type ShortcutCommandDefinition,
  type ShortcutCommandId,
  type ShortcutEventLike,
  type ShortcutScope,
} from "../../xuenessShortcutCommands";
import {
  paneLayoutIsSplitVisible,
  type PaneId,
  type PaneLayoutState,
  type PaneSplit,
} from "./paneLayout";
import { MAX_PANE_LEAVES, PRIMARY_PANE_ID, type PaneSide } from "./paneTree";

export const SESSION_NAV_LIMIT = 32;

export const SESSION_NAV_COMMANDS: readonly ShortcutCommandDefinition[] = [
  { id: "previous-session", label: "上一个会话", description: "在会话列表中选择上一个会话。", scope: "session", defaultBinding: "Mod+Shift+[" },
  { id: "next-session", label: "下一个会话", description: "在会话列表中选择下一个会话。", scope: "session", defaultBinding: "Mod+Shift+]" },
  { id: "session-back", label: "返回上一会话", description: "回到刚才打开的会话。", scope: "session", defaultBinding: "Mod+[" },
  { id: "session-forward", label: "前进到下一会话", description: "在返回之后重新打开后面的会话。", scope: "session", defaultBinding: "Mod+]" },
];

export const PANE_COMMANDS: readonly ShortcutCommandDefinition[] = [
  { id: "focus-previous-pane", label: "聚焦上一分屏", description: "把焦点移到上一个对话窗格。", scope: "pane", defaultBinding: "Alt+Shift+ArrowLeft" },
  { id: "focus-next-pane", label: "聚焦下一分屏", description: "把焦点移到下一个对话窗格。", scope: "pane", defaultBinding: "Alt+Shift+ArrowRight" },
  { id: "split-pane-right", label: "向右分屏", description: "在当前窗格右侧打开对话窗格。", scope: "pane", defaultBinding: "Alt+Shift+\\" },
  { id: "split-pane-down", label: "向下分屏", description: "在当前窗格下方打开对话窗格。", scope: "pane", defaultBinding: "Alt+Shift+-" },
  { id: "close-pane", label: "关闭分屏", description: "关闭当前非主对话窗格。", scope: "pane", defaultBinding: "Alt+Shift+W" },
];

const WINDOW_SCOPED_COMMANDS: readonly ShortcutCommandDefinition[] = [...SESSION_NAV_COMMANDS, ...PANE_COMMANDS];

export type SessionNavHistory = {
  readonly back: readonly string[];
  readonly current: string | null;
  readonly forward: readonly string[];
};

export type PaneShortcutAction = (typeof PANE_COMMANDS)[number]["id"];
export type PaneShortcutResult = "close" | PaneSplit | PaneId;

export type PaneWorkbenchShortcutState = {
  readonly paneIds: readonly string[];
  readonly focusedPaneId: string;
  readonly scopeKey?: string;
  readonly canSplit?: boolean;
};

export type PaneWorkbenchShortcutAction =
  | { type: "workbench-pane"; action: "split"; paneId: string; side: PaneSide }
  | { type: "workbench-pane"; action: "focus" | "close"; paneId: string };

export type ScopedSessionKeyAction =
  | PaneWorkbenchShortcutAction
  | { type: "select-session"; paneId?: string; sessionId: string; source: "history"; history: SessionNavHistory }
  | { type: "select-session"; paneId?: string; sessionId: string; source: "list" }
  | { type: "pane"; pane: PaneShortcutResult };

export function emptySessionNav(): SessionNavHistory {
  return { back: [], current: null, forward: [] };
}

function acceptedSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= 200;
}

export function recordSessionSelection(history: SessionNavHistory, sessionId: string): SessionNavHistory {
  if (!acceptedSessionId(sessionId) || sessionId === history.current) return history;
  const back = history.current ? [...history.back, history.current] : [...history.back];
  return { back: back.slice(-SESSION_NAV_LIMIT), current: sessionId, forward: [] };
}

function liveSessionIds(sessionIds: readonly string[]): Set<string> {
  const live = new Set<string>();
  for (const id of sessionIds) {
    if (typeof id === "string" && acceptedSessionId(id)) live.add(id);
  }
  return live;
}

export function travelSessionHistory(
  history: SessionNavHistory,
  direction: "back" | "forward",
  sessionIds: readonly string[],
): { history: SessionNavHistory; id: string } | null {
  if (!history.current) return null;
  const live = liveSessionIds(sessionIds);
  if (direction === "back") {
    const back = [...history.back];
    let id = "";
    while (back.length > 0) {
      const candidate = back.pop() ?? "";
      if (live.has(candidate)) { id = candidate; break; }
    }
    if (!id) return null;
    return {
      id,
      history: { back, current: id, forward: [history.current, ...history.forward].slice(0, SESSION_NAV_LIMIT) },
    };
  }
  const forward = [...history.forward];
  let id = "";
  while (forward.length > 0) {
    const candidate = forward.shift() ?? "";
    if (live.has(candidate)) { id = candidate; break; }
  }
  if (!id) return null;
  return {
    id,
    history: { back: [...history.back, history.current].slice(-SESSION_NAV_LIMIT), current: id, forward },
  };
}

export function adjacentSessionId(
  sessionIds: readonly string[],
  current: string | null,
  direction: -1 | 1,
): string | null {
  const unique: string[] = [];
  for (const id of sessionIds) {
    if (typeof id === "string" && acceptedSessionId(id) && !unique.includes(id)) unique.push(id);
  }
  if (!current) return null;
  const index = unique.indexOf(current);
  if (index < 0) return null;
  const next = index + direction;
  if (next < 0 || next >= unique.length) return null;
  return unique[next] ?? null;
}

export function resolvePaneShortcut(
  state: PaneLayoutState,
  action: PaneShortcutAction,
  wide: boolean,
): PaneShortcutResult | null {
  if (action === "close-pane") return state.split ? "close" : null;
  if (!wide) return null;
  if (action === "split-pane-right") return state.split === "row" ? null : "row";
  if (action === "split-pane-down") return state.split === "column" ? null : "column";
  if (!paneLayoutIsSplitVisible(state, wide, true)) return null;
  if (action === "focus-next-pane") return state.focus === "primary" ? "secondary" : null;
  if (action === "focus-previous-pane") return state.focus === "secondary" ? "primary" : null;
  return null;
}

/** Resolve against the captured leaf order, never the first matching DOM pane. */
export function resolveWorkbenchPaneShortcut(
  state: PaneWorkbenchShortcutState,
  action: PaneShortcutAction,
  wide: boolean,
): PaneWorkbenchShortcutAction | null {
  const index = state.paneIds.indexOf(state.focusedPaneId);
  if (index < 0) return null;
  if (action === "close-pane") {
    return state.focusedPaneId === PRIMARY_PANE_ID ? null
      : { type: "workbench-pane", action: "close", paneId: state.focusedPaneId };
  }
  if (!wide) return null;
  if (action === "split-pane-right" || action === "split-pane-down") {
    if (state.canSplit === false || state.paneIds.length >= MAX_PANE_LEAVES) return null;
    return { type: "workbench-pane", action: "split", paneId: state.focusedPaneId,
      side: action === "split-pane-right" ? "right" : "down" };
  }
  const offset = action === "focus-next-pane" ? 1 : action === "focus-previous-pane" ? -1 : 0;
  const paneId = state.paneIds[index + offset];
  return offset && paneId ? { type: "workbench-pane", action: "focus", paneId } : null;
}

/** Globals stay available for the workbench. Composer, session and pane rows
 * are registered together, and only when both plugins are effective. */
export function registeredShortcutCommands(input: {
  sessionsEffective: boolean;
  settingsEffective: boolean;
  terminalEffective?: boolean;
  browserEffective?: boolean;
}): readonly ShortcutCommandDefinition[] {
  const available = SHORTCUT_COMMANDS.filter(command => !(command.id === 'toggle-terminal' && input.terminalEffective === false)
    && !(command.id === 'toggle-browser' && input.browserEffective === false));
  const globals = available.filter((command) => command.scope === "global");
  if (!input.sessionsEffective || !input.settingsEffective) return globals;
  return [...available, ...WINDOW_SCOPED_COMMANDS, ...PANE_CONTROL_COMMANDS];
}

export function shortcutScopeMap(commands: readonly ShortcutCommandDefinition[]): Record<string, ShortcutScope> {
  return Object.fromEntries(commands.map((command) => [command.id, command.scope])) as Record<string, ShortcutScope>;
}

/** Bindings always travel with the scope table when scoped commands are registered. */
export function scopedShortcutSettingsPatch(
  bindings: Record<string, string>,
  commands: readonly ShortcutCommandDefinition[],
  includeScopes: boolean,
): Record<string, unknown> {
  if (!includeScopes) return { bindings };
  return { bindings, shortcutScopes: shortcutScopeMap(commands) };
}

export function shortcutScopeLabel(scope: string): string {
  if (scope === "composer") return tr("输入区");
  if (scope === "session") return tr("会话导航");
  if (scope === "pane") return tr("分屏");
  return tr("全局");
}

function bindingRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function globalCommandOwnsEvent(
  event: ShortcutEventLike,
  bindings: Record<string, string>,
  platform: string | undefined,
  target: unknown,
): boolean {
  return SHORTCUT_COMMANDS.some((command) => {
    if (command.scope !== "global") return false;
    const binding = resolveShortcutBinding(command.id, bindings, command.defaultBinding);
    if (!binding || !matchesShortcut(event, binding, platform)) return false;
    return !hasGlobalShortcutConflict(event, command.id as ShortcutCommandId, target, platform);
  });
}

function scopedTargetBlocks(event: ShortcutEventLike, target: unknown): boolean {
  if (isTerminalTarget(target)) return true;
  if (!isEditableTarget(target) && !isEditorTarget(target)) return false;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return true;
  const key = event.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "backspace", "delete"].includes(key)
    && !event.altKey && !event.ctrlKey && !event.metaKey) return true;
  return false;
}

export function evaluateScopedSessionKey(
  event: ShortcutEventLike,
  context: {
    sessionsEffective: boolean;
    settingsEffective: boolean;
    bindings?: unknown;
    platform?: string;
    target?: unknown;
    blocked?: boolean;
    sessionIds: readonly string[];
    activeSessionId: string | null;
    history: SessionNavHistory;
    paneWide: boolean;
    paneLayout?: PaneLayoutState;
    paneWorkbench?: PaneWorkbenchShortcutState;
  },
): ScopedSessionKeyAction | null {
  if (!context.sessionsEffective || !context.settingsEffective) return null;
  if (context.blocked || event.defaultPrevented || event.repeat || isImeComposingEvent(event)) return null;
  if (scopedTargetBlocks(event, context.target)) return null;
  const bindings = bindingRecord(context.bindings);
  if (composerOwnsShortcutEvent(event, context.target, bindings, context.platform) || globalCommandOwnsEvent(event, bindings, context.platform, context.target)) return null;
  const command = WINDOW_SCOPED_COMMANDS.find((item) => {
    const binding = resolveShortcutBinding(item.id, bindings, item.defaultBinding);
    return Boolean(binding && !isReservedShortcut(binding) && matchesShortcut(event, binding, context.platform));
  });
  if (!command) return null;
  const targetPane = context.paneWorkbench;
  if (targetPane && !targetPane.paneIds.includes(targetPane.focusedPaneId)) return null;
  const paneTarget = targetPane ? { paneId: targetPane.focusedPaneId } : {};
  if (command.id === "session-back" || command.id === "session-forward") {
    const moved = travelSessionHistory(context.history, command.id === "session-back" ? "back" : "forward", context.sessionIds);
    if (!moved || moved.id === context.activeSessionId) return null;
    return { type: "select-session", ...paneTarget, sessionId: moved.id, source: "history", history: moved.history };
  }
  if (command.id === "previous-session" || command.id === "next-session") {
    const sessionId = adjacentSessionId(context.sessionIds, context.activeSessionId, command.id === "next-session" ? 1 : -1);
    if (!sessionId) return null;
    return { type: "select-session", ...paneTarget, sessionId, source: "list" };
  }
  if (targetPane) return resolveWorkbenchPaneShortcut(targetPane, command.id, context.paneWide);
  if (!context.paneLayout) return null;
  const pane = resolvePaneShortcut(context.paneLayout, command.id as PaneShortcutAction, context.paneWide);
  if (!pane) return null;
  return { type: "pane", pane };
}

export { findShortcutConflictIn };

function shortcutSurfaceBlocked(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector("[aria-modal='true'], [role='dialog'], [role='menu'], .xn-shortcuts__recording"));
}

/** Listens only while both plugins are effective. Selection history stays in
 * memory and is dropped when the registration goes away. */
export function useScopedSessionCommands(input: {
  sessionsEffective: boolean;
  settingsEffective: boolean;
  bindings?: unknown;
  sessionIds: readonly string[];
  activeSessionId: string | null;
  paneWide: boolean;
  paneLayout?: PaneLayoutState;
  paneWorkbench?: PaneWorkbenchShortcutState & {
    onSplit: (side: PaneSide, paneId: string) => void;
    onFocus: (paneId: string) => void;
    onClose: (paneId: string) => void;
  };
  onSelectSession: (sessionId: string, paneId?: string) => void;
  onSplit?: (direction: PaneSplit) => void;
  onClosePane?: () => void;
  onFocusPane?: (pane: PaneId) => void;
}): void {
  const historiesRef = useRef(new Map<string, SessionNavHistory>());
  const historyKey = JSON.stringify([input.paneWorkbench?.scopeKey ?? "", input.paneWorkbench?.focusedPaneId ?? "legacy"]);
  const inputRef = useRef(input);
  inputRef.current = input;
  const enabled = input.sessionsEffective && input.settingsEffective;

  useEffect(() => {
    if (!enabled) {
      historiesRef.current.clear();
      return;
    }
    const id = input.activeSessionId;
    if (!id) return;
    const histories = historiesRef.current;
    histories.set(historyKey, recordSessionSelection(histories.get(historyKey) ?? emptySessionNav(), id));
    // Bound stale workspace/pane histories without persisting cross-scope state.
    if (histories.size > 128) histories.delete(histories.keys().next().value!);
  }, [enabled, input.activeSessionId, historyKey]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      const current = inputRef.current;
      const key = JSON.stringify([current.paneWorkbench?.scopeKey ?? "", current.paneWorkbench?.focusedPaneId ?? "legacy"]);
      const previousHistory = historiesRef.current.get(key) ?? emptySessionNav();
      const history = current.activeSessionId ? recordSessionSelection(previousHistory, current.activeSessionId) : emptySessionNav();
      const action = evaluateScopedSessionKey(event, {
        sessionsEffective: current.sessionsEffective,
        settingsEffective: current.settingsEffective,
        bindings: current.bindings,
        platform: resolveHostPlatform(),
        target: event.target,
        blocked: shortcutSurfaceBlocked(),
        sessionIds: current.sessionIds,
        activeSessionId: current.activeSessionId,
        history,
        paneWide: current.paneWide,
        paneLayout: current.paneLayout,
        paneWorkbench: current.paneWorkbench,
      });
      if (!action) return;
      // Optional legacy adapters must not swallow shortcuts with no live handler.
      if (action.type === "pane") {
        if (action.pane === "close" && !current.onClosePane) return;
        if ((action.pane === "row" || action.pane === "column") && !current.onSplit) return;
        if ((action.pane === "primary" || action.pane === "secondary") && !current.onFocusPane) return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action.type === "select-session") {
        if (action.source === "history") {
          historiesRef.current.set(key, action.history);
        }
        current.onSelectSession(action.sessionId, action.paneId);
        return;
      }
      if (action.type === "workbench-pane") {
        const workbench = current.paneWorkbench;
        if (!workbench) return;
        if (action.action === "split") workbench.onSplit(action.side, action.paneId);
        else if (action.action === "close") workbench.onClose(action.paneId);
        else workbench.onFocus(action.paneId);
        return;
      }
      if (action.pane === "close") current.onClosePane?.();
      else if (action.pane === "row" || action.pane === "column") current.onSplit?.(action.pane);
      else current.onFocusPane?.(action.pane);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
