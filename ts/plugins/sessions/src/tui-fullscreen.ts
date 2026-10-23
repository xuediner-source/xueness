/** Sessions-owned presentation and interaction, connected to feature-owned host ports. */
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { renderTuiFrame, type TuiFrame } from "./tui-frame.ts";
import { cleanText } from "./tui-text.ts";
import { TuiInputDecoder } from "./tui-input.ts";
import { handleTuiKey, type TuiKeyboardHost } from "./tui-keyboard.ts";
import { chooseTuiMenu, handleTuiMouse, refreshTuiSidebar, tuiSelectionText, updateTuiMenu } from "./tui-actions.ts";
import { activeEditor, createTuiUiState } from "./tui-ui-state.ts";
import { applyTuiEvent, createTuiDocument, documentLines, hydrateTuiDocument } from "./tui-transcript.ts";
import { menuLines } from "./tui-menus.ts";
import { sidebarLayout, sidebarLines, toggleSidebar } from "./tui-sidebar.ts";
import { resolveTheme } from "./tui-theme.ts";
import { permissionDialog } from "./tui-permission.ts";
import { questionDialog } from "./tui-questions.ts";
import type { TuiAttachment, TuiContext, TuiDialog, TuiLine, TuiPermissionAnswer, TuiPermissionRequest, TuiPort, TuiQuestion, TuiRow } from "./tui-types.ts";
import { isBackgroundTaskNotice } from "./journal-http.ts";

export type ChatContext = TuiContext;
export interface FullscreenOptions { input?: ReadStream; output?: WriteStream; language?: "zh" | "en" }
export function fullscreenAvailable(input = process.stdin, output = process.stderr): boolean { return input.isTTY === true && output.isTTY === true && process.env.TERM !== "dumb"; }

export class FullscreenChatTerminal implements TuiKeyboardHost {
  readonly input: ReadStream;
  readonly output: WriteStream;
  readonly ui;
  port: TuiPort | null = null;
  frame: TuiFrame | null = null;
  stopRequested = false;
  #opened = false;
  #closed = false;
  #raw = false;
  #flowing: boolean | null = null;
  #waiter: ((line: string | null) => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #refreshing = false;
  #refreshAgain = false;
  #unsubscribe: (() => void) | null = null;
  #decoder: TuiInputDecoder;
  #paste: string | null = null;
  #submitted: TuiAttachment[] = [];
  #lines: TuiLine[] = [];
  #renderedRows = 0;
  #appended = false;
  #sending = false;
  #started = 0;

  constructor(options: FullscreenOptions = {}) {
    this.input = options.input ?? process.stdin; this.output = options.output ?? process.stderr;
    this.ui = createTuiUiState(options.language ?? "zh");
    this.#decoder = new TuiInputDecoder({ key: this.#key, mouse: (event) => handleTuiMouse(this, event), theme: (mode) => { this.ui.detectedTheme = mode; this.schedule(); } });
  }
  get language(): "zh" | "en" { return this.ui.language; }
  get running(): boolean { return this.ui.running; }
  set running(value: boolean) {
    this.ui.running = value;
    if (value) { this.#started = Date.now(); this.#ticker ??= setInterval(() => this.schedule(), 100); }
    else { if (this.#ticker) clearInterval(this.#ticker); this.#ticker = null; void this.refresh(); }
    this.schedule();
  }
  get columns(): number { return this.output.columns || 80; }
  get inputWidth(): number { return this.frame?.inputWidth ?? this.columns; }
  get viewRows(): number { return this.frame?.viewRows ?? 10; }
  connect(port: TuiPort): void {
    this.#unsubscribe?.(); this.port = port;
    try { this.#unsubscribe = port.subscribe?.(() => { void this.refresh(); }, (error) => this.fail(error)) ?? null; }
    catch (error) { this.fail(error); }
    void this.refresh();
  }
  setContext(context: TuiContext): void {
    const changed = context.sessionId !== undefined && context.sessionId !== this.ui.context.sessionId;
    Object.assign(this.ui.context, context);
    if (context.sessionId !== undefined) this.ui.document.sessionId = context.sessionId;
    if (changed) void this.refresh();
    this.schedule();
  }
  reset(sessionId = ""): void {
    this.ui.document = createTuiDocument(sessionId); this.ui.child = null; this.ui.menu = null; this.ui.queued = []; this.ui.attachments = []; this.ui.selection = null; this.ui.scroll = 0; this.#renderedRows = 0; this.schedule();
  }
  history(messages: readonly { role: string; content: unknown }[]): void {
    const visible = messages.filter((row) => !isBackgroundTaskNotice(row));
    this.ui.document = hydrateTuiDocument(this.ui.context.sessionId ?? "", visible);
    this.ui.draft.restoreHistory(visible.filter((row) => row.role === "user" && typeof row.content === "string").map((row) => cleanText(String(row.content)))); this.schedule();
  }
  event(event: TuiRow): void {
    applyTuiEvent(this.ui.document, event); if (this.ui.child) applyTuiEvent(this.ui.child, event);
    this.#appended = true; this.schedule();
    if (!["assistant_delta", "reasoning_delta", "thought_delta"].includes(String(event.type))) void this.refresh();
  }
  write(text: string): void { if (text.trim()) { applyTuiEvent(this.ui.document, { type: "display_log", text: cleanText(text).trimEnd() }); this.#appended = true; this.schedule(); } }
  fail(error: unknown): void { this.ui.notice = error instanceof Error ? error.message : String(error); this.schedule(); }
  async refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing) { this.#refreshAgain = true; return; }
    this.#refreshing = true;
    try { do { this.#refreshAgain = false; await refreshTuiSidebar(this); } while (this.#refreshAgain && !this.#closed); }
    finally { this.#refreshing = false; }
  }
  updateMenu(): void { void updateTuiMenu(this); }
  openMenu(kind: "session" | "child"): void {
    if (kind === "session" && this.running) { this.ui.notice = this.#zh("先暂停运行再切换会话", "Pause the run before switching sessions."); this.schedule(); return; }
    void updateTuiMenu(this, kind);
  }
  choose(submit: boolean): void { void chooseTuiMenu(this, submit); }
  cycleMode(): void {
    const modes = ["plan", "build", "edit", "yolo", "guarded"], next = modes[(modes.indexOf(this.ui.context.mode ?? "build") + 1) % modes.length]!;
    void this.port?.setMode(next).then((mode) => { this.ui.context.mode = mode; this.schedule(); }, (error) => this.fail(error));
  }
  pasteImage(): void {
    if (!this.port) return;
    void this.port.captureImage().then((item) => { if (item) { this.ui.attachments.push(item); this.ui.draft.insert(item.label + " "); } else this.ui.notice = this.#zh("剪贴板中没有图片", "No clipboard image."); this.schedule(); }, (error) => this.fail(error));
  }
  copy(): void {
    const value = tuiSelectionText(this, this.#lines);
    if (!value || !this.port) { this.ui.notice = this.#zh("没有选中的文本", "No selected text to copy."); this.schedule(); return; }
    void this.port.writeClipboard(value).then(() => { this.ui.selection = null; this.ui.notice = this.#zh("已复制选中文字", "Selected text copied."); this.schedule(); }, (error) => this.fail(error));
  }
  takeAttachments(): readonly TuiAttachment[] { const values = this.#submitted; this.#submitted = []; return values; }
  submit(delivery: "queue" | "steer" = "queue"): void {
    const editor = activeEditor(this.ui), value = editor.value;
    if (this.#sending || !value.trim()) return;
    if (this.#localCommand(value.trim())) { editor.submit(); this.schedule(); return; }
    const attachments = this.ui.attachments.filter((row) => value.includes(row.label));
    if (!this.#waiter && this.running && this.port) {
      this.#sending = true;
      void this.port.sendInput(value, attachments, delivery).then((receipt) => {
        this.ui.queued.push(receipt); if (editor.value === value) { editor.submit(); this.ui.attachments = []; }
        this.ui.notice = this.#zh(delivery === "steer" ? "指导已提交当前轮次" : "下一轮已排队", delivery === "steer" ? "Guidance sent to current turn." : "Follow-up queued.");
      }, (error) => this.fail(error)).finally(() => { this.#sending = false; this.schedule(); }); return;
    }
    if (!this.#waiter) return;
    editor.submit(); this.ui.attachments = []; this.#submitted = attachments;
    if (!this.running) this.ui.document.entries.push({ id: `user-${Date.now()}`, kind: "user", text: value });
    this.ui.menu = null; this.ui.scroll = 0; this.#resolve(value); this.schedule();
  }
  #localCommand(value: string): boolean {
    if (value === "/sidebar") { toggleSidebar(this.ui.sidebar, this.columns); return true; }
    if (value === "/developer") { this.ui.context.developer = !this.ui.context.developer; return true; }
    if (/^\/theme (auto|light|dark)$/.test(value)) { this.ui.context.theme = value.slice(7) as "auto" | "light" | "dark"; return true; }
    if (value === "/tasks") { this.openMenu("child"); return true; }
    if (value === "/queue") {
      this.ui.menu = { kind: "action", title: this.#zh("已排队输入 · Enter 撤回", "Queued inputs · Enter to withdraw"), from: 0, to: 0, selected: 0, items: this.ui.queued.map((row) => ({ id: row.id, label: row.text, description: row.kind, value: `tui:cancel:${row.kind}:${row.id}` })) }; return true;
    }
    return false;
  }
  stop(): void { this.interrupt(); }
  exit(): void { this.stopRequested = true; this.port?.stop?.(); this.#resolve(null); this.close(); }
  interrupt = (): void => {
    this.stopRequested = true; this.port?.stop?.(); this.ui.notice = this.#zh("正在暂停并保存当前会话", "Pausing and saving the current session.");
    if (this.ui.dialog) { const result = this.ui.dialog.cancel(); this.ui.dialog = null; const resolve = this.ui.resolveDialog; this.ui.resolveDialog = null; resolve?.(result); }
    this.#resolve(null); this.schedule();
  };
  async prompt(label: string): Promise<string | null> {
    if (this.#closed || this.running && this.stopRequested) return null;
    this.watch(); this.ui.prompt = label; if (this.running) this.ui.answer.replace("");
    const answer = new Promise<string | null>((done) => { this.#waiter = done; }); this.paint(); return answer;
  }
  #resolve(value: string | null): void { const waiter = this.#waiter; this.#waiter = null; this.ui.prompt = null; waiter?.(value); }
  async #dialog<T>(dialog: TuiDialog<T>): Promise<T> {
    this.watch(); this.ui.menu = null; this.ui.dialog = dialog;
    const result = new Promise<T>((done) => { this.ui.resolveDialog = (value) => done(value as T); }); this.paint(); return result;
  }
  async approval(request: TuiPermissionRequest): Promise<TuiPermissionAnswer> {
    const abort = () => { const resolve = this.ui.resolveDialog; this.ui.dialog = null; this.ui.resolveDialog = null; resolve?.({ behavior: "cancel" }); this.schedule(); };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) return { behavior: "cancel" };
      const result = await this.#dialog(permissionDialog(request));
      if (result.behavior === "allow" && result.project) await this.port?.rememberPermission?.(request, result.remember ?? []);
      return result;
    }
    finally { request.signal.removeEventListener("abort", abort); }
  }
  questions(questions: readonly TuiQuestion[]): Promise<string | null> { return this.#dialog(questionDialog(questions)); }
  #zh(zh: string, en: string): string { return this.language === "zh" ? zh : en; }
  #key = (text: string | undefined, key: Key): void => {
    if (key.name === "paste-start") { this.#paste = ""; return; }
    if (key.name === "paste-end") {
      const pasted = cleanText(this.#paste ?? ""); this.#paste = null;
      if (this.ui.dialog) handleTuiKey(this, pasted.replace(/\n/g, " "), {});
      else { activeEditor(this.ui).insert(pasted); this.updateMenu(); }
      this.schedule(); return;
    }
    if (this.#paste !== null) { this.#paste += text ?? key.sequence ?? ""; return; }
    handleTuiKey(this, text ? cleanText(text) : text, key);
  };
  #data = (chunk: Buffer): void => { this.#decoder.write(chunk); };
  #end = (): void => { this.exit(); };
  #resize = (): void => { this.ui.selection = null; this.#appended = false; this.paint(); };
  #terminate = (): void => { this.close(); process.exit(143); };
  watch(): void {
    if (this.#opened || this.#closed) return;
    this.#opened = true; this.#raw = this.input.isRaw; this.#flowing = this.input.readableFlowing;
    this.input.setRawMode(true); this.input.on("data", this.#data); this.input.on("end", this.#end); this.input.resume();
    this.output.on("resize", this.#resize); process.on("SIGINT", this.interrupt); process.on("SIGTERM", this.#terminate); process.on("exit", this.close);
    this.output.write("\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b]11;?\x07"); this.paint();
  }
  schedule(): void { if (!this.#opened || this.#closed || this.#timer) return; this.#timer = setTimeout(() => { this.#timer = null; this.paint(); }, 24); }
  paint(): void {
    if (!this.#opened || this.#closed) return;
    const ui = this.ui, mode = resolveTheme(ui.context.theme ?? "auto", ui.detectedTheme), layout = sidebarLayout(this.columns, ui.sidebar);
    const width = Math.max(1, this.columns - (layout.visible && !layout.overlay ? layout.width : 0));
    this.#lines = documentLines(ui.child ?? ui.document, width, mode, this.language);
    if (this.#appended && ui.scroll > 0 && !ui.child) ui.scroll += Math.max(0, this.#lines.length - this.#renderedRows);
    this.#appended = false; this.#renderedRows = this.#lines.length;
    const editor = activeEditor(ui), usage = ui.document.contextUsed !== undefined ? `${ui.document.contextUsed}${ui.document.contextWindow ? "/" + ui.document.contextWindow : ""} tokens` : "";
    const status = this.stopRequested ? this.#zh("暂停中", "Pausing") : this.running ? `${["◐", "◓", "◑", "◒"][Math.floor(Date.now() / 150) % 4]} ${Math.floor((Date.now() - this.#started) / 1000)}s` : this.#zh("就绪", "Ready");
    this.frame = renderTuiFrame({ columns: this.columns, rows: this.output.rows || 24, title: ui.child ? this.#zh("子代理 · Esc 返回", "Subagent · Esc back") : "XUENESS",
      context: [ui.context.model, ui.context.effort, ui.context.mode, usage, ui.context.root, ui.context.branch ?? ui.data.branch].filter(Boolean).join(" · "), status,
      transcript: "", mainLines: this.#lines, draft: editor.value, cursor: editor.cursor, prompt: ui.prompt, running: this.running, scroll: ui.scroll, language: this.language, themeMode: mode, notice: ui.notice,
      sidebarLines: layout.visible ? sidebarLines(ui.data, ui.document, { ...ui.context, theme: mode }, ui.sidebar, Math.max(1, layout.width - 2), this.language) : undefined,
      sidebarWidth: layout.width, sidebarOverlay: layout.overlay, sidebarScroll: ui.sidebarScroll, menuLines: ui.menu ? menuLines(ui.menu, width, Math.min(10, (this.output.rows || 24) - 8), this.language) : undefined,
      dialog: ui.dialog?.view(this.language), selectedRange: ui.selection ?? undefined, attachmentLabels: ui.attachments.map((row) => row.label), queuedLabels: ui.queued.map((row) => `${row.kind}: ${row.text}`) });
    ui.scroll = Math.max(0, Math.min(this.frame.maxScroll, ui.scroll)); ui.sidebarScroll = this.frame.sidebarScroll; this.output.write(this.frame.output);
  }
  close = (): void => {
    if (this.#closed) return;
    this.#closed = true; if (this.running) this.stopRequested = true;
    this.#unsubscribe?.(); this.#unsubscribe = null;
    if (this.#timer) clearTimeout(this.#timer); if (this.#ticker) clearInterval(this.#ticker); this.#timer = null; this.#ticker = null; this.#resolve(null);
    if (this.ui.dialog) { const result = this.ui.dialog.cancel(); this.ui.dialog = null; this.ui.resolveDialog?.(result); this.ui.resolveDialog = null; }
    this.#decoder.close(); if (!this.#opened) return;
    this.input.off("data", this.#data); this.input.off("end", this.#end); this.output.off("resize", this.#resize);
    process.off("SIGINT", this.interrupt); process.off("SIGTERM", this.#terminate); process.off("exit", this.close);
    this.input.setRawMode(this.#raw); if (this.#flowing !== true) this.input.pause();
    this.output.write("\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l");
  };
}
