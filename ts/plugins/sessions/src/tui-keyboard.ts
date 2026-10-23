/** Keyboard priority follows ZCode v3.15.1 app-keyboard.ts. */
import type { Key } from "node:readline";
import { activeEditor, type TuiUiState } from "./tui-ui-state.ts";
import { toggleSidebar, toggleSidebarSection } from "./tui-sidebar.ts";
import { expandWorkflows, toggleEntry } from "./tui-transcript.ts";
import type { TuiSection } from "./tui-types.ts";

export interface TuiKeyboardHost {
  ui: TuiUiState;
  columns: number;
  inputWidth: number;
  viewRows: number;
  submit(delivery?: "queue" | "steer"): void;
  stop(): void;
  exit(): void;
  copy(): void;
  pasteImage(): void;
  choose(submit: boolean): void;
  updateMenu(): void;
  openMenu(kind: "session" | "child"): void;
  cycleMode(): void;
  paint(): void;
}

export function handleTuiKey(host: TuiKeyboardHost, text: string | undefined, key: Key): void {
  const ui = host.ui, editor = activeEditor(ui), zh = ui.language === "zh";
  const notice = (cn: string, en: string) => { ui.notice = zh ? cn : en; };
  if (ui.dialog) {
    const result = ui.dialog.key(text, key);
    if (result.done) { const resolve = ui.resolveDialog; ui.dialog = null; ui.resolveDialog = null; resolve?.(result.value); }
    host.paint(); return;
  }
  if (ui.child) {
    if (key.name === "escape") { ui.child = null; ui.scroll = 0; ui.selection = null; }
    else if (key.ctrl && (key.name === "y" || key.name === "c")) host.copy();
    else if (key.name === "up" || key.name === "pageup") ui.scroll += key.name === "up" ? 1 : host.viewRows - 1;
    else if (key.name === "down" || key.name === "pagedown") ui.scroll -= key.name === "down" ? 1 : host.viewRows - 1;
    else if (key.name === "end") ui.scroll = 0;
    else if (key.name === "home") ui.scroll = Number.MAX_SAFE_INTEGER;
    host.paint(); return;
  }
  if (key.ctrl && key.name === "x") {
    ui.sidebarPressedAt = Date.now(); notice("B 侧栏 · M 修改文件 · A 请求", "B sidebar · M files · A APIs"); host.paint(); return;
  }
  if (ui.sidebarPressedAt) {
    const armed = Date.now() - ui.sidebarPressedAt <= 2000; ui.sidebarPressedAt = 0;
    if (armed && !key.ctrl && !key.meta && ["b", "m", "a"].includes(key.name ?? "")) {
      if (key.name === "b") toggleSidebar(ui.sidebar, host.columns);
      else {
        if (key.name === "a" && !ui.context.developer) { ui.context.developer = true; ui.sidebar.sections.apis = true; }
        else toggleSidebarSection(ui.sidebar, key.name === "m" ? "modifiedFiles" : "apis");
      }
      host.paint(); return;
    }
  }
  if (key.ctrl && key.name === "c") {
    if (ui.selection) host.copy();
    else if (editor.value) { editor.replace(""); ui.attachments = []; ui.menu = null; ui.exitPressedAt = 0; notice("草稿已清空", "Draft cleared."); }
    else if (ui.exitPressedAt && Date.now() - ui.exitPressedAt <= 2000) host.exit();
    else { ui.exitPressedAt = Date.now(); notice("再次按 Ctrl-C 退出", "Press Ctrl-C again to exit."); }
    host.paint(); return;
  }
  ui.exitPressedAt = 0;
  if (key.ctrl && key.name === "y") { host.copy(); return; }
  if (key.ctrl && key.name === "p") { host.openMenu("session"); return; }
  if (key.ctrl && key.name === "g") { host.openMenu("child"); return; }
  if ((key.ctrl || key.meta) && key.name === "v") { host.pasteImage(); return; }
  if (key.ctrl && key.name === "r") {
    const retry = [...ui.document.entries].reverse().find((entry) => entry.kind === "compact" && ["failed", "interrupted"].includes(entry.status ?? ""))?.meta?.retryCommand;
    if (retry && !ui.running) { editor.replace(String(retry)); host.submit(); }
    else if (ui.running) notice("当前运行尚未结束", "Agent is still responding.");
    host.paint(); return;
  }
  if (key.name === "tab" && key.shift) { host.cycleMode(); return; }
  if (key.name === "escape") {
    if (ui.menu) { ui.dismissedMenu = editor.value; ui.menu = null; }
    else if (ui.running) host.stop();
    else notice("没有正在运行的输出；Ctrl-C 两次退出", "No active output. Press Ctrl-C twice to exit.");
    host.paint(); return;
  }
  if (key.name === "pageup" || key.name === "pagedown") {
    ui.scroll += (key.name === "pageup" ? 1 : -1) * Math.max(1, host.viewRows - 1); host.paint(); return;
  }
  if (key.ctrl && key.name === "home") { ui.scroll = Number.MAX_SAFE_INTEGER; host.paint(); return; }
  if (key.ctrl && key.name === "end") { ui.scroll = 0; host.paint(); return; }
  if (ui.menu && (key.name === "up" || key.name === "down")) {
    ui.menu.selected = Math.max(0, Math.min(ui.menu.items.length - 1, ui.menu.selected + (key.name === "up" ? -1 : 1))); host.paint(); return;
  }
  if (key.name === "tab") { if (ui.menu) host.choose(false); return; }
  if (key.name === "return" || key.name === "enter") {
    if (key.shift || key.meta) editor.insert("\n");
    else if (ui.menu?.items.length) { host.choose(true); return; }
    else { host.submit(key.ctrl ? "steer" : "queue"); return; }
  } else if (key.ctrl && key.name === "s" && ui.running) { host.submit("steer"); return; }
  else if (key.ctrl && key.name === "u") { editor.replace(""); ui.attachments = []; }
  else if (key.ctrl && key.name === "d" && !editor.value) { host.exit(); return; }
  else if (key.ctrl && key.name === "w") editor.deleteWordBefore();
  else if (key.ctrl && key.name === "a" || key.name === "home") editor.home();
  else if (key.ctrl && key.name === "e" || key.name === "end") editor.end();
  else if (key.ctrl && key.name === "k") editor.clearAfter();
  else if (key.name === "backspace") editor.backspace();
  else if (key.name === "delete") editor.delete();
  else if (key.name === "left") { if (key.meta || key.ctrl) editor.wordLeft(); else editor.left(); }
  else if (key.name === "right") { if (key.meta || key.ctrl) editor.wordRight(); else editor.right(); }
  else if (key.name === "up" || key.name === "down") {
    if (!editor.value || editor.historyActive) { if (key.name === "up") editor.previous(); else editor.next(); }
    else editor.moveVertical(key.name === "up" ? -1 : 1, host.inputWidth);
  } else if (!key.ctrl && !key.meta && !editor.value && (text === "+" || text === "-") && ui.document.entries.some((entry) => entry.kind === "workflow")) expandWorkflows(ui.document, text === "+");
  else if (key.ctrl && key.name === "o") { for (const entry of ui.document.entries) if (entry.kind === "tool" || entry.kind === "thought") toggleEntry(ui.document, entry.id); }
  else if (!key.ctrl && !key.meta && text) editor.insert(text);
  ui.selection = null;
  host.updateMenu(); host.paint();
}
