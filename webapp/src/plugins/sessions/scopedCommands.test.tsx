import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSections } from "../settings/SettingsSections";
import { XuenessShortcutsPanel } from "../settings/XuenessShortcutsPanel";
import { findShortcutConflictIn, recordShortcutEvent, matchesShortcut } from "../../xuenessShortcutCommands";
import { initialPaneLayout, splitPaneLayout } from "./paneLayout";
import {
  PANE_COMMANDS,
  SESSION_NAV_COMMANDS,
  SESSION_NAV_LIMIT,
  adjacentSessionId,
  emptySessionNav,
  evaluateScopedSessionKey,
  recordSessionSelection,
  registeredShortcutCommands,
  resolvePaneShortcut,
  scopedShortcutSettingsPatch,
  travelSessionHistory,
  type SessionNavHistory,
} from "./scopedCommands";

const ids = ["s1", "s2", "s3"];

function selectedSessionId(action: ReturnType<typeof evaluateScopedSessionKey>): string | undefined {
  return action?.type === "select-session" ? action.sessionId : undefined;
}

function keyContext(patch: Partial<Parameters<typeof evaluateScopedSessionKey>[1]> = {}) {
  return {
    sessionsEffective: true,
    settingsEffective: true,
    bindings: {},
    platform: "win32",
    sessionIds: ids,
    activeSessionId: "s2",
    history: { back: ["s1"], current: "s2", forward: ["s3"] } satisfies SessionNavHistory,
    paneWide: true,
    paneLayout: splitPaneLayout(initialPaneLayout(), "row"),
    ...patch,
  };
}

test("scoped commands register composer, session navigation and pane actions only when both plugins are effective", () => {
  const registered = registeredShortcutCommands({ sessionsEffective: true, settingsEffective: true });
  assert.deepEqual(registered.filter(command => command.scope === "composer").map(command => command.id), ["send-message", "stop-generation", "insert-newline"]);
  assert.deepEqual(SESSION_NAV_COMMANDS.map(command => command.id), ["previous-session", "next-session", "session-back", "session-forward"]);
  assert.deepEqual(PANE_COMMANDS.map(command => command.scope), ["pane", "pane", "pane", "pane", "pane"]);
  assert.equal(registeredShortcutCommands({ sessionsEffective: false, settingsEffective: true }).some(command => command.scope !== "global"), false);
  assert.equal(registeredShortcutCommands({ sessionsEffective: true, settingsEffective: false }).some(command => command.id === "close-pane"), false);
  const scopes = new Set(registered.map(command => command.scope));
  assert.deepEqual([...scopes], ["global", "composer", "session", "pane"]);
});

test("settings patch stores the keymap together with the registered scopes", () => {
  const commands = registeredShortcutCommands({ sessionsEffective: true, settingsEffective: true });
  const patch = scopedShortcutSettingsPatch({ "close-pane": "Alt+Shift+P" }, commands, true);
  assert.equal((patch.bindings as Record<string, string>)["close-pane"], "Alt+Shift+P");
  const scopes = patch.shortcutScopes as Record<string, string>;
  assert.equal(scopes["send-message"], "composer");
  assert.equal(scopes["session-back"], "session");
  assert.equal(scopes["split-pane-right"], "pane");
  assert.equal(scopes["toggle-sidebar"], "global");
  assert.deepEqual(scopedShortcutSettingsPatch({ "new-session": "Mod+N" }, commands, false), { bindings: { "new-session": "Mod+N" } });
});

test("session history is bounded and skips sessions that are no longer in the list", () => {
  let history = emptySessionNav();
  for (let index = 0; index < SESSION_NAV_LIMIT + 5; index += 1) history = recordSessionSelection(history, `id-${index}`);
  assert.equal(history.back.length, SESSION_NAV_LIMIT);
  assert.equal(history.current, `id-${SESSION_NAV_LIMIT + 4}`);
  assert.equal(recordSessionSelection(history, history.current ?? ""), history);
  const back = travelSessionHistory(history, "back", [history.current ?? "", history.back.at(-1) ?? ""]);
  assert.equal(back?.id, history.back.at(-1));
  assert.equal(back?.history.forward[0], history.current);
  const forward = travelSessionHistory(back!.history, "forward", [back!.id, history.current ?? ""]);
  assert.equal(forward?.id, history.current);
  const stale = travelSessionHistory({ back: ["s1", "gone"], current: "s2", forward: ["gone", "s3"] }, "back", ids);
  assert.equal(stale?.id, "s1");
  assert.deepEqual(stale?.history.back, []);
  assert.deepEqual(stale?.history.forward, ["s2", "gone", "s3"]);
  assert.equal(travelSessionHistory({ back: ["gone"], current: "s2", forward: [] }, "back", ids), null);
  assert.equal(adjacentSessionId(ids, "s1", -1), null);
  assert.equal(adjacentSessionId(ids, "s1", 1), "s2");
  assert.equal(adjacentSessionId(ids, "s3", 1), null);
  assert.equal(adjacentSessionId(["s2", "s2", "s3"], "s2", 1), "s3");
});

test("pane shortcuts split, focus and close the existing two conversation panes", () => {
  const closed = initialPaneLayout();
  assert.equal(resolvePaneShortcut(closed, "split-pane-right", false), null);
  assert.equal(resolvePaneShortcut(closed, "split-pane-right", true), "row");
  assert.equal(resolvePaneShortcut(closed, "split-pane-down", true), "column");
  assert.equal(resolvePaneShortcut(closed, "close-pane", true), null);
  const row = splitPaneLayout(closed, "row");
  assert.equal(resolvePaneShortcut(row, "split-pane-right", true), null);
  assert.equal(resolvePaneShortcut(row, "split-pane-down", true), "column");
  assert.equal(resolvePaneShortcut(row, "focus-next-pane", true), "secondary");
  assert.equal(resolvePaneShortcut(row, "focus-previous-pane", true), null);
  assert.equal(resolvePaneShortcut({ ...row, focus: "secondary" }, "focus-previous-pane", true), "primary");
  assert.equal(resolvePaneShortcut({ ...row, focus: "secondary" }, "focus-next-pane", true), null);
  assert.equal(resolvePaneShortcut(row, "focus-next-pane", false), null);
  assert.equal(resolvePaneShortcut(row, "close-pane", false), "close");
});

test("scoped key dispatch follows platform modifiers, yields to global commands, and stays off when a plugin is ineffective", () => {
  assert.deepEqual(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext()), {
    type: "select-session", sessionId: "s1", source: "history", history: { back: [], current: "s1", forward: ["s2", "s3"] },
  });
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({ platform: "darwin" })), null);
  assert.deepEqual(evaluateScopedSessionKey({ key: "[", metaKey: true }, keyContext({ platform: "darwin" }))?.type, "select-session");
  assert.equal(selectedSessionId(evaluateScopedSessionKey({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }, keyContext({ platform: "darwin" }))), "s1");
  assert.equal(evaluateScopedSessionKey({ key: "ArrowRight", altKey: true, shiftKey: true }, keyContext())?.type, "pane");
  assert.deepEqual(evaluateScopedSessionKey({ key: "w", altKey: true, shiftKey: true }, keyContext()), { type: "pane", pane: "close" });
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true, repeat: true }, keyContext()), null);
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true, isComposing: true }, keyContext()), null);
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({ sessionsEffective: false })), null);
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({ settingsEffective: false })), null);
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({ blocked: true })), null);
  assert.equal(evaluateScopedSessionKey({ key: "Enter", ctrlKey: true, shiftKey: true }, keyContext()), null);
  const terminal = { closest: (selector: string) => selector.includes("terminal") ? terminal : null };
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({ target: terminal })), null);
  const editor = { closest: (selector: string) => selector.includes("input, textarea") ? editor : null };
  assert.equal(selectedSessionId(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({ target: editor }))), "s1");
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, keyContext({
    bindings: { "session-back": "" },
  })), null);
  assert.equal(evaluateScopedSessionKey({ key: "k", ctrlKey: true }, keyContext({
    bindings: { "previous-session": "Mod+K" },
    activeSessionId: "s2",
  })), null);
  const catalog = registeredShortcutCommands({ sessionsEffective: true, settingsEffective: true });
  assert.equal(findShortcutConflictIn("Mod+K", "previous-session", { "previous-session": "Mod+K" }, catalog), null);
  assert.equal(findShortcutConflictIn("Mod+Shift+]", "previous-session", {}, catalog), "next-session");
  assert.deepEqual(recordShortcutEvent({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }, "MacIntel"), {
    kind: "binding", binding: "Mod+Shift+[",
  });
  assert.equal(matchesShortcut({ key: "|", code: "Backslash", altKey: true, shiftKey: true }, "Alt+Shift+\\", "win32"), true);
});

test("shortcut settings hide scoped rows until sessions and settings both register them", () => {
  const capabilities = { allowMcp: false, allowSubagents: false, allowHooks: false };
  const hidden = renderToStaticMarkup(<SettingsSections embedded sections={[]} activeSection="shortcuts" values={{ bindings: {} }}
    capabilities={capabilities} sessionScopedCommands={false} onUpdateSetting={() => {}} />);
  assert.equal(hidden.includes("xn-shortcut-row-previous-session"), false);
  assert.equal(hidden.includes("xn-shortcut-row-send-message"), false);
  assert.match(hidden, /xn-shortcut-row-new-session/);
  const updates: Array<[string, unknown]> = [];
  const shown = renderToStaticMarkup(<XuenessShortcutsPanel
    commands={registeredShortcutCommands({ sessionsEffective: true, settingsEffective: true })}
    onChange={(bindings) => { updates.push(["bindings", bindings]); }}
  />);
  assert.match(shown, /data-testid="xn-shortcut-row-session-forward"/);
  assert.match(shown, /data-testid="xn-shortcut-row-close-pane"/);
  assert.match(shown, /data-testid="xn-shortcut-row-session-back"[\s\S]*?\[/);
  assert.doesNotMatch(shown, /data-testid="xn-shortcut-row-session-back"[\s\S]*?未设置[\s\S]*?data-testid="xn-shortcut-row-session-forward"/);
  assert.match(shown, /会话导航|Session navigation/);
  assert.match(shown, /分屏|Split pane/);
  assert.match(shown, /输入区|Composer/);
});

test("four-pane commands capture the focused leaf, preserve primary, and respect capacity", () => {
  const paneWorkbench = { paneIds: ["primary", "p2", "p3"], focusedPaneId: "p2", scopeKey: "workspace-a" };
  const context = keyContext({ paneLayout: undefined, paneWorkbench });
  const event = (key: string) => ({ key, altKey: true, shiftKey: true });
  assert.deepEqual(evaluateScopedSessionKey(event("ArrowRight"), context), { type: "workbench-pane", action: "focus", paneId: "p3" });
  assert.deepEqual(evaluateScopedSessionKey(event("ArrowLeft"), context), { type: "workbench-pane", action: "focus", paneId: "primary" });
  assert.deepEqual(evaluateScopedSessionKey(event("W"), context), { type: "workbench-pane", action: "close", paneId: "p2" });
  assert.deepEqual(evaluateScopedSessionKey(event("\\"), context), { type: "workbench-pane", action: "split", paneId: "p2", side: "right" });
  assert.deepEqual(evaluateScopedSessionKey(event("-"), context), { type: "workbench-pane", action: "split", paneId: "p2", side: "down" });
  assert.equal(evaluateScopedSessionKey(event("W"), { ...context, paneWorkbench: { ...paneWorkbench, focusedPaneId: "primary" } }), null);
  assert.equal(evaluateScopedSessionKey(event("ArrowRight"), { ...context, paneWorkbench: { ...paneWorkbench, focusedPaneId: "p3" } }), null);
  assert.equal(evaluateScopedSessionKey(event("ArrowLeft"), { ...context, paneWorkbench: { ...paneWorkbench, focusedPaneId: "primary" } }), null);
  assert.equal(evaluateScopedSessionKey(event("\\"), { ...context, paneWorkbench: { ...paneWorkbench, paneIds: [...paneWorkbench.paneIds, "p4"] } }), null);
  assert.equal(evaluateScopedSessionKey(event("-"), { ...context, paneWorkbench: { ...paneWorkbench, canSplit: false } }), null);
  assert.equal(evaluateScopedSessionKey(event("ArrowRight"), { ...context, paneWide: false }), null);
  assert.equal(evaluateScopedSessionKey(event("-"), { ...context, paneWide: false }), null);
});

test("four-pane session navigation targets the captured leaf and rejects stale focus", () => {
  const paneWorkbench = { paneIds: ["primary", "p2", "p3", "p4"], focusedPaneId: "p4", scopeKey: "workspace-b" };
  const context = keyContext({ paneWorkbench });
  assert.deepEqual(evaluateScopedSessionKey({ key: "]", ctrlKey: true, shiftKey: true }, context), {
    type: "select-session", paneId: "p4", sessionId: "s3", source: "list",
  });
  assert.deepEqual(evaluateScopedSessionKey({ key: "[", metaKey: true }, { ...context, platform: "darwin" }), {
    type: "select-session", paneId: "p4", sessionId: "s1", source: "history",
    history: { back: [], current: "s1", forward: ["s2", "s3"] },
  });
  assert.equal(evaluateScopedSessionKey({ key: "[", ctrlKey: true }, { ...context, paneWorkbench: { ...paneWorkbench, focusedPaneId: "removed" } }), null);
  for (const patch of [{ sessionsEffective: false }, { settingsEffective: false }, { blocked: true }]) {
    assert.equal(evaluateScopedSessionKey({ key: "W", altKey: true, shiftKey: true }, { ...context, ...patch }), null);
  }
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) {
    assert.equal(evaluateScopedSessionKey({ key: "W", altKey: true, shiftKey: true, ...patch }, context), null);
  }
});


test("pane bindings cannot override reserved browser shortcuts even through saved settings", () => {
  for (const platform of ["win32", "darwin"]) {
    const context = keyContext({ platform, bindings: { "close-pane": "Mod+W" },
      paneWorkbench: { paneIds: ["primary", "p2"], focusedPaneId: "p2" } });
    const modifier = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    assert.equal(evaluateScopedSessionKey({ key: "w", ...modifier }, context), null);
  }
});
