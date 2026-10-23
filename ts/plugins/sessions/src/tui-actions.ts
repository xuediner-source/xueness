import { menuQuery, filterChoices, completeChoice } from "./tui-menus.ts";
import { applyTuiEvent, hydrateTuiDocument, toggleEntry } from "./tui-transcript.ts";
import { toggleSidebarSection } from "./tui-sidebar.ts";
import { cleanText, graphemes, cellWidth, cursorPosition } from "./tui-text.ts";
import type { TuiFrame } from "./tui-frame.ts";
import type { TuiMouse } from "./tui-input.ts";
import { activeEditor, type TuiUiState } from "./tui-ui-state.ts";
import type { TuiMenuKind, TuiPort, TuiSection } from "./tui-types.ts";

export interface TuiActionHost {
  ui: TuiUiState;
  port: TuiPort | null;
  frame: TuiFrame | null;
  schedule(): void;
  submit(delivery?: "queue" | "steer"): void;
  fail(error: unknown): void;
}

export async function updateTuiMenu(host: TuiActionHost, explicit?: "session" | "child"): Promise<void> {
  const { ui, port } = host;
  if (!port || ui.dialog || ui.child || ui.running && ui.prompt !== null) return;
  const editor = activeEditor(ui), request = ++ui.menuRequest;
  if (!explicit && ui.dismissedMenu === editor.value) return;
  const query = explicit ? { kind: explicit as TuiMenuKind, query: "", from: 0, to: editor.value.length }
    : /^\/resume(?:\s|$)/.test(editor.value) ? { kind: "session" as const, query: editor.value.slice(7).trim(), from: 0, to: editor.value.length }
    : menuQuery(editor.value, editor.cursor);
  if (!query) { ui.menu = null; host.schedule(); return; }
  try {
    const choices = await port.choices(query.kind, query.query);
    if (request !== ui.menuRequest || !explicit && ui.dismissedMenu === editor.value) return;
    const items = query.kind === "file" ? choices : filterChoices(choices, query.query);
    const titles = ui.language === "zh" ? { slash: "命令", model: "模型", effort: "思考档位", mode: "模式", file: "文件", session: "会话", child: "子代理", action: "操作" }
      : { slash: "Commands", model: "Models", effort: "Effort", mode: "Mode", file: "Files", session: "Sessions", child: "Subagents", action: "Actions" };
    ui.menu = { ...query, title: titles[query.kind], items, selected: 0 };
    host.schedule();
  } catch (error) { if (request === ui.menuRequest) { ui.menu = null; host.fail(error); } }
}

export async function chooseTuiMenu(host: TuiActionHost, submit: boolean): Promise<void> {
  const { ui, port } = host, menu = ui.menu;
  const item = menu?.items[menu.selected];
  if (!menu || !item || !port) return;
  if (item.disabledReason) { ui.notice = item.disabledReason; host.schedule(); return; }
  if (menu.kind === "mode" && submit) {
    try { ui.context.mode = await port.setMode(item.id); activeEditor(ui).replace(""); ui.menu = null; }
    catch (error) { host.fail(error); }
    host.schedule(); return;
  }
  if (menu.kind === "child") {
    ui.menu = null;
    try {
      const snapshot = await port.childTranscript(item.id);
      ui.child = hydrateTuiDocument(snapshot.sessionId, snapshot.messages, snapshot.events);
      ui.scroll = 0; ui.selection = null;
    } catch (error) { host.fail(error); }
    host.schedule(); return;
  }
  if (item.value.startsWith("tui:cancel:")) {
    const [, , kind, id] = item.value.split(":");
    try { await port.cancelInput(id!, kind as "queue" | "steer"); ui.queued = ui.queued.filter((row) => row.id !== id); ui.notice = ui.language === "zh" ? "已撤回输入" : "Input withdrawn."; }
    catch (error) { host.fail(error); }
    ui.menu = null; host.schedule(); return;
  }
  const editor = activeEditor(ui), result = completeChoice(editor.value, menu, item);
  if (result.attach) {
    try { const attachment = await port.attach(result.attach); if (!ui.attachments.some((row) => row.id === attachment.id)) ui.attachments.push(attachment); }
    catch (error) { host.fail(error); return; }
  }
  editor.replace(result.text); editor.cursor = result.cursor;
  ui.menu = null; ui.dismissedMenu = result.text;
  if (result.submit || submit && menu.kind !== "file") host.submit();
  else if (menu.kind === "file" && item.directory) { ui.dismissedMenu = ""; void updateTuiMenu(host); }
  host.schedule();
}

export async function refreshTuiSidebar(host: TuiActionHost): Promise<void> {
  if (!host.port) return;
  const sessionId = host.ui.context.sessionId;
  try {
    const data = await host.port.sidebar();
    if (host.ui.context.sessionId !== sessionId) return;
    host.ui.data = data;
    if (data.queued) host.ui.queued = [...data.queued];
    if (data.usage) host.ui.document.usage = data.usage;
    if (data.contextUsed !== undefined) host.ui.document.contextUsed = data.contextUsed;
    if (data.contextWindow !== undefined) host.ui.document.contextWindow = data.contextWindow;
    const users = (data.messages ?? []).filter((message) => message.role === "user" && typeof message.content === "string");
    const shown = host.ui.document.entries.filter((entry) => entry.kind === "user");
    for (const message of users.slice(shown.length)) {
      const entries = host.ui.document.entries, following = (data.messages ?? []).slice((data.messages ?? []).indexOf(message) + 1);
      const after = entries.findLastIndex((entry) => entry.kind === "user");
      const index = entries.findIndex((entry, i) => i > after && following.some((row) => row.role === "assistant" && entry.kind === "assistant" && row.content === entry.text || row.tool_call_id === entry.id));
      entries.splice(index < 0 ? entries.length : index, 0, { id: message._message_id ?? `queued-user-${entries.length}`, kind: "user", text: message.content });
    }
    for (const stream of data.streams ?? []) {
      if (typeof stream.reasoning !== "string" || !stream.reasoning) continue;
      const id = `reasoning-${stream.id}`, entries = host.ui.document.entries, existed = entries.some((entry) => entry.id === id);
      applyTuiEvent(host.ui.document, { type: "reasoning", thoughtId: id, text: stream.reasoning });
      if (!existed) {
        const thought = entries.pop()!, message = data.messages?.[stream.final_message_index];
        const index = entries.findIndex((entry) => entry.kind === "assistant" && entry.text === message?.content);
        entries.splice(index < 0 ? entries.length : index, 0, thought);
      }
    }
    for (const [id, result] of Object.entries(data.toolResults ?? {})) {
      const prior = host.ui.document.entries.find((entry) => entry.kind === "tool" && entry.id === id);
      if (prior?.status === "completed" && result.data?.awaitingApproval) continue;
      if (prior) applyTuiEvent(host.ui.document, { type: "tool_result", id, name: prior.name, input: prior.input, result, ok: result.ok, diff: result.data?.diff ?? result.diff });
    }
    for (const workflow of data.workflows) applyTuiEvent(host.ui.document, { type: "workflow_progress", ...workflow });
  } catch (error) { host.ui.data.error = error instanceof Error ? error.message : String(error); }
  host.schedule();
}

function pointBefore(a: { line: number; column: number }, b: { line: number; column: number }): boolean { return a.line < b.line || a.line === b.line && a.column <= b.column; }
function cellSlice(text: string, from: number, to: number): string {
  let result = "", column = 0;
  for (const part of graphemes(cleanText(text))) { const next = column + cellWidth(part); if (column >= from && next <= to) result += part; column = next; }
  return result;
}
export function tuiSelectionText(host: TuiActionHost, allLines: readonly { text: string }[]): string {
  const selection = host.ui.selection;
  if (!selection) return "";
  const [start, end] = pointBefore(selection.start, selection.end) ? [selection.start, selection.end] : [selection.end, selection.start];
  return allLines.slice(start.line, end.line + 1).map((row, index) => cellSlice(row.text, index === 0 ? start.column : 0, start.line + index === end.line ? end.column : Infinity).trimEnd()).join("\n");
}

export function handleTuiMouse(host: TuiActionHost, event: TuiMouse): void {
  const { ui, frame } = host;
  if (!frame || ui.dialog) return;
  if (event.wheel) {
    const side = frame.sidebarArea;
    if (side && event.x >= side.x) ui.sidebarScroll += event.wheel === -1 ? -3 : 3;
    else ui.scroll += event.wheel === -1 ? 3 : -3;
    host.schedule(); return;
  }
  const side = frame.sidebarArea;
  if (!ui.child && event.release && event.y >= frame.inputRow && event.y < frame.inputRow + frame.inputRows && (!side || event.x < side.x)) {
    const editor = activeEditor(ui), target = (event.y - frame.inputRow + frame.draftTop) * frame.inputWidth + event.x;
    let prefix = "", nearest = 0, distance = Infinity;
    for (const part of ["", ...graphemes(editor.value)]) {
      prefix += part;
      const point = cursorPosition(prefix, frame.inputWidth), delta = Math.abs(point.row * frame.inputWidth + point.column - target);
      if (delta < distance) { distance = delta; nearest = prefix.length; }
    }
    editor.cursor = nearest; ui.selection = null; host.schedule(); return;
  }
  const region = [...frame.regions].reverse().find((row) => !row.action.startsWith("toggle:") && event.x >= row.x && event.x < row.x + row.width && event.y >= row.y && event.y < row.y + row.height);
  if (!region) return;
  if (region.action.startsWith("transcript:")) {
    const point = { line: Number(region.action.slice(11)), column: Math.max(0, event.x - region.x) };
    if (!event.release && !event.motion) { ui.selection = { start: point, end: point }; ui.dragging = true; }
    else if (ui.dragging && event.motion) { ui.selection!.end = point; }
    else if (event.release) {
      const selected = ui.selection; ui.dragging = false;
      if (selected && selected.start.line === point.line && selected.start.column === point.column) {
        ui.selection = null;
        const line = frame.visibleLines[point.line - frame.transcriptTop];
        if (line?.action?.startsWith("toggle:")) toggleEntry(ui.child ?? ui.document, line.action.slice(7));
        else if (line?.action?.startsWith("retry:")) { ui.draft.replace(line.action.slice(6)); host.submit(); }
      } else if (selected) selected.end = point;
    }
  } else if (event.release && region.action.startsWith("sidebar:")) toggleSidebarSection(ui.sidebar, region.action.slice(8) as TuiSection);
  else if (event.release && region.action.startsWith("file:") && host.port && !ui.child) {
    const path = region.action.slice(5);
    void host.port.attach(path).then((item) => {
      if (!ui.attachments.some((row) => row.id === item.id)) ui.attachments.push(item);
      ui.draft.insert(item.label + " "); host.schedule();
    }, (error) => host.fail(error));
  }
  else if (event.release && region.action.startsWith("child:")) {
    const id = region.action.slice(6);
    ui.menu = { kind: "child", title: "Subagents", items: [{ id, label: id, value: id }], selected: 0, from: 0, to: 0 };
    void chooseTuiMenu(host, true);
  } else if (event.release && region.action.startsWith("menu:")) {
    if (ui.menu) ui.menu.selected = Number(region.action.slice(5));
    void chooseTuiMenu(host, true);
  }
  host.schedule();
}
