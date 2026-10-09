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
  matchesShortcut,
  isReservedShortcut,
  canonicalPhysicalBinding,
  isSamePhysicalBinding,
  isEditableTarget,
  isTerminalTarget,
  isEditorTarget,
  hasGlobalShortcutConflict,
} from "../../xuenessShortcutCommands";
import {
  displayBinding,
  displayBindingParts,
  isMacPlatform,
  isModKeyPressed,
  isImeComposingEvent,
} from "../../xuenessShortcutDisplay";

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
  // 原生编辑菜单的复制/粘贴/撤销等在两端都保留，不能被绑定成应用快捷键
  for (const [key, extra] of [["c", {}], ["v", {}], ["z", {}], ["z", { shiftKey: true }], ["a", {}], ["m", {}]] as const) {
    assert.deepEqual(recordShortcutEvent(event(key, { metaKey: true, ...extra }), "MacIntel"), { kind: "invalid", reason: "reserved" });
    assert.deepEqual(recordShortcutEvent(event(key, { ctrlKey: true, ...extra }), "Win32"), { kind: "invalid", reason: "reserved" });
  }
  assert.deepEqual(recordShortcutEvent(event("f", { metaKey: true, ctrlKey: true }), "MacIntel"), { kind: "invalid", reason: "reserved" });
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

test("shortcut labels share platform-aware Meta display across compact and settings layouts", () => {
  assert.equal(displayBinding("Meta+N", "Win32"), "Win+N");
  assert.equal(displayBinding("Meta+N", "MacIntel"), "⌘N");
  assert.deepEqual(displayBindingParts("Meta+Shift+ArrowLeft", "Win32"), ["Win", "Shift", "Left"]);
  assert.deepEqual(displayBindingParts("Meta+Shift+ArrowLeft", "MacIntel"), ["⌘", "⇧", "Left"]);
});

test("shortcut recording and display agree for native and browser platform names", () => {
  for (const platform of ["darwin", "MacIntel", "macOS", "MacARM"]) {
    assert.equal(isMacPlatform(platform), true);
    assert.equal(displayBinding("Mod+Alt+N", platform), "⌘⌥N");
    assert.deepEqual(recordShortcutEvent(event("n", { metaKey: true }), platform), { kind: "binding", binding: "Mod+N" });
  }
  for (const platform of ["win32", "Win32", "Windows", "Linux x86_64"]) {
    assert.equal(isMacPlatform(platform), false);
    assert.equal(displayBinding("Mod+Alt+N", platform), "Ctrl+Alt+N");
    assert.deepEqual(recordShortcutEvent(event("n", { ctrlKey: true }), platform), { kind: "binding", binding: "Mod+N" });
  }
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

test("isModKeyPressed distinguishes Mac Command vs Windows Ctrl across platforms", () => {
  // macOS (darwin): 仅 metaKey 为 true 且 ctrlKey 为 false
  assert.equal(isModKeyPressed({ metaKey: true }, "darwin"), true);
  assert.equal(isModKeyPressed({ ctrlKey: true }, "darwin"), false);
  assert.equal(isModKeyPressed({ metaKey: true, ctrlKey: true }, "darwin"), false);
  assert.equal(isModKeyPressed({}, "darwin"), false);

  // Windows (win32): 仅 ctrlKey 为 true 且 metaKey 为 false
  assert.equal(isModKeyPressed({ ctrlKey: true }, "win32"), true);
  assert.equal(isModKeyPressed({ metaKey: true }, "win32"), false);
  assert.equal(isModKeyPressed({ ctrlKey: true, metaKey: true }, "win32"), false);
  assert.equal(isModKeyPressed({}, "win32"), false);
});

test("matchesShortcut resolves Mod across win32 and darwin without leaking cross-platform keys", () => {
  // darwin: Mod+N 对应 Cmd+N (metaKey: true)
  assert.equal(matchesShortcut({ key: "n", metaKey: true }, "Mod+N", "darwin"), true);
  assert.equal(matchesShortcut({ key: "n", ctrlKey: true }, "Mod+N", "darwin"), false);
  assert.equal(matchesShortcut({ key: "b", metaKey: true }, "Mod+B", "darwin"), true);
  assert.equal(matchesShortcut({ key: "b", ctrlKey: true }, "Mod+B", "darwin"), false);

  // win32: Mod+N 对应 Ctrl+N (ctrlKey: true)
  assert.equal(matchesShortcut({ key: "n", ctrlKey: true }, "Mod+N", "win32"), true);
  assert.equal(matchesShortcut({ key: "n", metaKey: true }, "Mod+N", "win32"), false);
  assert.equal(matchesShortcut({ key: "b", ctrlKey: true }, "Mod+B", "win32"), true);
  assert.equal(matchesShortcut({ key: "b", metaKey: true }, "Mod+B", "win32"), false);

  // Alt+Shift+R 两端一致
  assert.equal(matchesShortcut({ key: "r", altKey: true, shiftKey: true }, "Alt+Shift+R", "darwin"), true);
  assert.equal(matchesShortcut({ key: "r", altKey: true, shiftKey: true }, "Alt+Shift+R", "win32"), true);
});

test("canonicalPhysicalBinding and findShortcutConflict detect physical key collisions per platform", () => {
  // win32 下 Mod+N 与 Ctrl+N 物理等价
  assert.equal(canonicalPhysicalBinding("Mod+N", "win32"), "Ctrl+N");
  assert.equal(canonicalPhysicalBinding("Ctrl+N", "win32"), "Ctrl+N");
  assert.equal(isSamePhysicalBinding("Mod+N", "Ctrl+N", "win32"), true);
  assert.equal(findShortcutConflict("Ctrl+N", "command-palette", {}, "win32"), "new-session");

  // darwin 下 Mod+N 与 Meta+N 物理等价，与 Ctrl+N 不等价
  assert.equal(canonicalPhysicalBinding("Mod+N", "darwin"), "Meta+N");
  assert.equal(canonicalPhysicalBinding("Meta+N", "darwin"), "Meta+N");
  assert.equal(canonicalPhysicalBinding("Ctrl+N", "darwin"), "Ctrl+N");
  assert.equal(isSamePhysicalBinding("Mod+N", "Meta+N", "darwin"), true);
  assert.equal(isSamePhysicalBinding("Mod+N", "Ctrl+N", "darwin"), false);
  assert.equal(findShortcutConflict("Meta+N", "command-palette", {}, "darwin"), "new-session");
  assert.equal(findShortcutConflict("Ctrl+N", "command-palette", {}, "darwin"), null);
});

test("hasGlobalShortcutConflict protects terminal, input, and editor from keyboard hijacking", () => {
  const terminalHost = {
    className: "xn-terminal-host",
    closest: (sel: string) => sel.includes("terminal") ? terminalHost : null,
  };
  const inputEl = {
    tagName: "INPUT",
    closest: (sel: string) => sel.includes("input") ? inputEl : null,
  };
  const editorEl = {
    className: "xn-zc-editor",
    closest: (sel: string) => sel.includes("editor") ? editorEl : null,
  };

  // 1. IME 组字态一律报冲突并放行给 IME
  assert.equal(hasGlobalShortcutConflict({ key: "n", ctrlKey: true, isComposing: true }, "new-session", terminalHost, "win32"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "k", ctrlKey: true, keyCode: 229 }, "command-palette", inputEl, "win32"), true);

  // 2. 终端冲突：
  // Windows 下 Ctrl+B (tmux)、Ctrl+K (readline kill)、Ctrl+N (readline history) 属于终端控制码，不能被全局劫持
  assert.equal(hasGlobalShortcutConflict({ key: "b", ctrlKey: true }, "toggle-sidebar", terminalHost, "win32"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "k", ctrlKey: true }, "command-palette", terminalHost, "win32"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "n", ctrlKey: true }, "new-session", terminalHost, "win32"), true);
  // 普通区域下 Windows Ctrl+B 不冲突，正常触发全局侧栏切换
  assert.equal(hasGlobalShortcutConflict({ key: "b", ctrlKey: true }, "toggle-sidebar", null, "win32"), false);

  // macOS 下 ⌘B、⌘K、⌘N 走 metaKey，不发送 ASCII 控制字符，不与终端 shell 的 ⌃B/⌃K/⌃N 冲突
  assert.equal(hasGlobalShortcutConflict({ key: "b", metaKey: true }, "toggle-sidebar", terminalHost, "darwin"), false);
  assert.equal(hasGlobalShortcutConflict({ key: "k", metaKey: true }, "command-palette", terminalHost, "darwin"), false);
  // macOS 下若绑定了显式 Ctrl 则仍需让位终端
  assert.equal(hasGlobalShortcutConflict({ key: "b", ctrlKey: true }, "toggle-sidebar", terminalHost, "darwin"), true);

  // 3. 输入框与编辑器冲突：
  // 正常打字（无修饰键或仅 Shift）绝不触发全局命令
  assert.equal(hasGlobalShortcutConflict({ key: "f" }, "new-session", inputEl, "darwin"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "F", shiftKey: true }, "new-session", inputEl, "darwin"), true);
  // 原生编辑操作（全选、复制、撤销、查找等）不可被全局命令抢占
  assert.equal(hasGlobalShortcutConflict({ key: "a", metaKey: true }, "new-session", editorEl, "darwin"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "z", ctrlKey: true }, "new-session", inputEl, "win32"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "f", metaKey: true }, "new-session", editorEl, "darwin"), true);
  assert.equal(hasGlobalShortcutConflict({ key: "f", ctrlKey: true }, "new-session", inputEl, "win32"), true);
});

test("isReservedShortcut protects browser/OS search shortcuts and recordShortcutEvent rejects IME", () => {
  assert.equal(isReservedShortcut("Mod+F"), true);
  assert.equal(isReservedShortcut("mod+ctrl+f"), true);
  assert.equal(isReservedShortcut("Mod+C"), true);
  assert.equal(isReservedShortcut("Mod+V"), true);
  assert.equal(isReservedShortcut("Mod+K"), false);
  assert.equal(isReservedShortcut("Mod+Shift+N"), false);

  // IME 状态下录制快捷键直接返回 invalid unsupported-key，不录入临时组合字符
  assert.deepEqual(recordShortcutEvent({ key: "Process", isComposing: true }), { kind: "invalid", reason: "unsupported-key" });
  assert.deepEqual(recordShortcutEvent({ key: "Enter", keyCode: 229 }), { kind: "invalid", reason: "unsupported-key" });
  assert.deepEqual(recordShortcutEvent({ key: "Dead" }), { kind: "invalid", reason: "unsupported-key" });
});
