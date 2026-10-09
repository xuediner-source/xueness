import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import type { SessionSummary } from "../../xuenessWorkbench";
import {
  buildCommandPaletteResults,
  commandPaletteStatusLabel,
  formatPaletteUpdatedAt,
  isPaletteCompositionKey,
  nextPaletteIndex,
  paletteActivationIndex,
  paletteWorkspaceLabel,
  CommandPalette,
} from "./CommandPalette";

const commands = [
  { id: "new-task", label: "新建任务", description: "回到空态输入卡开始新任务" },
  { id: "open-settings", label: "打开设置", description: "运行参数与 Agent 能力开关" },
];
const sessions: SessionSummary[] = [
  { id: "s-1", title: "修复同步", task: "描述一", status: "running", root: "/work/alpha/app", updatedAt: "2026-10-04T10:15:00Z" },
  { id: "s-2", title: "文档", task: "描述二", status: "completed", root: "D:\\work\\beta\\docs", updatedAt: "2026-10-03T09:20:00Z" },
];

test("command palette searches descriptions, sessions and workspaces, with translated status and disambiguating metadata", () => {
  const settingHits = buildCommandPaletteResults("设置", commands, sessions, false);
  assert.equal(settingHits[0]?.kind, "command");
  assert.equal(settingHits[0]?.id, "open-settings");

  const workspaceHits = buildCommandPaletteResults("beta", commands, sessions, false);
  assert.deepEqual(workspaceHits.map(item => item.id), ["s-2"]);
  assert.equal(workspaceHits[0]?.kind === "session" ? workspaceHits[0].description : "", "已完成");
  assert.equal(paletteWorkspaceLabel(sessions[1]?.root), "beta/docs");
  assert.equal(formatPaletteUpdatedAt(sessions[0]?.updatedAt, "zh").length > 0, true);

  const html = renderToStaticMarkup(<CommandPalette
    dialogRef={{ current: null }} inputRef={{ current: null }} sessions={sessions} busy={false}
    sessionsEnabled settingsEnabled={false} onClose={() => undefined} onRunCommand={() => undefined} onSelectSession={() => undefined}
  />);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-controls="xn-command-palette-listbox-/);
  assert.match(html, /aria-activedescendant="xn-command-palette-listbox-[^"]+-option-0"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /data-testid="palette-session-s-1"/);
  assert.match(html, /data-updated-at="2026-10-04T10:15:00Z"/);
  assert.match(html, /title="\/work\/alpha\/app"/);
  assert.doesNotMatch(html, /palette-command-open-settings/);
});

test("command palette arrow keys, Home and End move among available options without wrapping", () => {
  const enabled = [0, 2, 4];
  assert.equal(nextPaletteIndex("ArrowDown", 0, enabled), 2);
  assert.equal(nextPaletteIndex("ArrowUp", 2, enabled), 0);
  assert.equal(nextPaletteIndex("ArrowUp", 0, enabled), 0);
  assert.equal(nextPaletteIndex("ArrowDown", 4, enabled), 4);
  assert.equal(nextPaletteIndex("Home", 4, enabled), 0);
  assert.equal(nextPaletteIndex("End", 0, enabled), 4);
  assert.equal(nextPaletteIndex("ArrowDown", -1, enabled), 0);
  assert.equal(nextPaletteIndex("ArrowUp", -1, enabled), 4);
  assert.equal(nextPaletteIndex("Enter", 0, enabled), null);
  assert.equal(nextPaletteIndex("End", 0, []), null);
  assert.equal(paletteActivationIndex("Enter", 2, enabled), 2);
  assert.equal(paletteActivationIndex("Enter", 1, enabled), null, "disabled results cannot be activated");
  assert.equal(paletteActivationIndex("Enter", 2, enabled, true), null, "IME Enter cannot activate a result");
  assert.equal(paletteActivationIndex("Escape", 2, enabled), null);
});

test("composition keystrokes never activate or dismiss a palette result, and statuses localize", () => {
  assert.equal(isPaletteCompositionKey({ isComposing: true }), true);
  assert.equal(isPaletteCompositionKey({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isPaletteCompositionKey({ keyCode: 229 }), true);
  assert.equal(isPaletteCompositionKey({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isPaletteCompositionKey({ key: "Process" }), true);
  assert.equal(isPaletteCompositionKey({ key: "Dead" }), true);
  assert.equal(isPaletteCompositionKey({ compositionActive: true }), true);
  assert.equal(isPaletteCompositionKey({}), false);
  assert.equal(commandPaletteStatusLabel("running"), "运行中");
  setLocale("en");
  try {
    assert.equal(commandPaletteStatusLabel("completed"), "Completed");
    assert.equal(commandPaletteStatusLabel("needs_review"), "Needs review");
  } finally {
    setLocale("zh");
  }
});

test("the command palette renders no sessions controls when its plugin is ineffective", () => {
  const html = renderToStaticMarkup(<CommandPalette
    dialogRef={{ current: null }} inputRef={{ current: null }} sessions={sessions} busy={false}
    sessionsEnabled={false} settingsEnabled onClose={() => undefined} onRunCommand={() => undefined} onSelectSession={() => undefined}
  />);
  assert.equal(html, "");
});
