import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { XuenessShortcutsPanel } from "./XuenessShortcutsPanel";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  filterShortcutCommands,
  findShortcutConflict,
  normalizeShortcutBinding,
  recordShortcutEvent,
  restoreShortcutDefault,
  SHORTCUT_COMMANDS,
} from "./xuenessShortcutCommands";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

function event(key: string, patch: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch };
}

test("shortcut registry includes only wired workbench actions with stable defaults", () => {
  assert.deepEqual(SHORTCUT_COMMANDS.map((command) => command.id), [
    "new-session", "command-palette", "open-settings", "toggle-sidebar", "refresh-session",
  ]);
  assert.deepEqual(DEFAULT_SHORTCUT_BINDINGS, {
    "new-session": "Mod+N",
    "command-palette": "Mod+K",
    "open-settings": "Mod+,",
    "toggle-sidebar": "Mod+B",
    "refresh-session": "Alt+Shift+R",
  });
  assert.equal(new Set(Object.values(DEFAULT_SHORTCUT_BINDINGS)).size, SHORTCUT_COMMANDS.length);
});

test("shortcut recorder canonicalizes modifiers, uses physical keys for Alt-produced glyphs, and requires a modifier", () => {
  assert.deepEqual(recordShortcutEvent(event("p", { shiftKey: true, metaKey: true }), "MacIntel"), {
    kind: "binding", binding: "Mod+Shift+P",
  });
  assert.deepEqual(recordShortcutEvent(event("k", { ctrlKey: true }), "Win32"), {
    kind: "binding", binding: "Mod+K",
  });
  assert.deepEqual(recordShortcutEvent(event("k"), "Win32"), {
    kind: "invalid", reason: "modifier-required",
  });
  assert.deepEqual(recordShortcutEvent(event("F5"), "Win32"), {
    kind: "invalid", reason: "reserved",
  });
  assert.deepEqual(recordShortcutEvent(event("q", { metaKey: true }), "MacIntel"), {
    kind: "invalid", reason: "reserved",
  });
  assert.deepEqual(recordShortcutEvent(event("Delete", { ctrlKey: true, altKey: true }), "Win32"), {
    kind: "invalid", reason: "reserved",
  });
  assert.deepEqual(recordShortcutEvent({ ...event("‰", { altKey: true, shiftKey: true }), code: "KeyR" }, "MacIntel"), {
    kind: "binding", binding: "Alt+Shift+R",
  });
});

test("shortcut conflicts use effective defaults, and empty values clear them", () => {
  assert.equal(findShortcutConflict("Mod+N", "command-palette", {}), "new-session");
  assert.equal(findShortcutConflict("Mod+N", "command-palette", { "new-session": "" }), null);
  assert.equal(findShortcutConflict("Mod+Shift+P", "refresh-session", { "command-palette": "Mod+Shift+P" }), "command-palette");
  assert.equal(normalizeShortcutBinding("Shift+Mod+P"), "Mod+Shift+P");
  assert.equal(normalizeShortcutBinding("Mod+Mod+P"), null);
  assert.deepEqual(restoreShortcutDefault({ "new-session": "Alt+N", "command-palette": "Mod+P" }, "new-session"), {
    "command-palette": "Mod+P",
  });
});

test("shortcut search matches action name, id, description, and effective binding", () => {
  assert.deepEqual(filterShortcutCommands(SHORTCUT_COMMANDS, {}, "refresh-session").map((item) => item.id), ["refresh-session"]);
  assert.deepEqual(filterShortcutCommands(SHORTCUT_COMMANDS, {}, "Alt+Shift+R").map((item) => item.id), ["refresh-session"]);
  assert.deepEqual(filterShortcutCommands(SHORTCUT_COMMANDS, {}, "没有这样的命令"), []);
});

test("shortcut settings render a searchable action table with clear and restore controls", () => {
  const out = html(<XuenessShortcutsPanel onChange={() => {}} />);
  assert.match(out, /aria-label="搜索快捷键"/);
  assert.match(out, /role="columnheader">命令<\/span>/);
  assert.match(out, /role="columnheader">按键绑定<\/span>/);
  assert.match(out, /data-testid="xn-shortcut-row-toggle-sidebar"/);
  assert.match(out, /data-testid="xn-shortcut-row-refresh-session"/);
  assert.match(out, /data-testid="xn-shortcut-clear-open-settings"/);
  assert.match(out, /data-testid="xn-shortcut-default-open-settings"/);
  assert.match(out, /data-testid="xn-shortcuts-reset-all"/);
});
