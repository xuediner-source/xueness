import type { Key } from "node:readline";

export type TuiRow = Record<string, any>;
export type TuiThemeMode = "dark" | "light";
export type TuiTheme = TuiThemeMode | "auto";
export type TuiMenuKind = "slash" | "model" | "effort" | "mode" | "file" | "session" | "child" | "action";
export interface TuiChoice { id: string; label: string; value: string; description?: string; keywords?: readonly string[]; disabledReason?: string; directory?: boolean }
export interface TuiMenuQuery { kind: TuiMenuKind; query: string; from: number; to: number }
export interface TuiMenu { kind: TuiMenuKind; title: string; items: readonly TuiChoice[]; selected: number; from: number; to: number }
export interface TuiQuestion { id: string; header: string; question: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }
export interface TuiPermissionRequest { callId: string; tool: string; kind: string; subject: string; code: string; message: string; remember: { exact: readonly string[]; broad: readonly string[] } | null; signal: AbortSignal }
export type TuiPermissionAnswer = { behavior: "allow"; remember?: readonly string[]; project?: boolean } | { behavior: "deny"; message?: string; feedback?: string; reason?: string } | { behavior: "cancel" };
export interface TuiDialogView { title: string; lines: string[]; selected?: number; help: string; cursor?: { row: number; column: number } }
export interface TuiDialog<T> { view(language: "zh" | "en"): TuiDialogView; key(text: string | undefined, key: Key): { done: false } | { done: true; value: T }; cancel(): T }
export interface TuiEntry { id: string; kind: "user" | "assistant" | "thought" | "tool" | "compact" | "workflow" | "error" | "system"; text: string; title?: string; status?: string; name?: string; input?: TuiRow; output?: string; path?: string; diff?: string; expanded?: boolean; meta?: TuiRow }
export interface TuiDocument { sessionId: string; entries: TuiEntry[]; usage: TuiRow; network: TuiRow[]; contextUsed?: number; contextWindow?: number; lastEvent?: string; error?: string; streamingId?: string }
export interface TuiLine { text: string; entryId?: string; action?: string; tone?: "accent" | "dim" | "error" | "success" | "warning" }
export interface TuiSidebar { status?: string; branch?: string; files: TuiRow[]; todos: TuiRow[]; subagents: TuiRow[]; mcp: TuiRow[]; workflows: TuiRow[]; apis: TuiRow[]; messages?: TuiRow[]; streams?: TuiRow[]; queued?: TuiQueuedInput[]; toolResults?: Record<string, TuiRow>; usage?: TuiRow; contextUsed?: number; contextWindow?: number; error?: string }
export type TuiSection = "subagents" | "mcp" | "modifiedFiles" | "todos" | "apis";
export interface TuiSidebarState { preference: "auto" | "hidden"; overlay: boolean; sections: Record<TuiSection, boolean> }
export interface TuiSnapshot { sessionId: string; messages: readonly TuiRow[]; events?: readonly TuiRow[]; sidebar?: TuiSidebar }
export interface TuiAttachment { id: string; label: string; path?: string }
export interface TuiContext { root?: string; sessionId?: string; model?: string; mode?: string; effort?: string; branch?: string; version?: string; theme?: TuiTheme; developer?: boolean }
export interface TuiQueuedInput { id: string; text: string; kind: "queue" | "steer"; status?: string }
/** Feature owners supply data/actions. The terminal never opens a provider or grants a permission. */
export interface TuiPort {
  stop?(): void;
  subscribe?(onChange: () => void, onError?: (error: Error) => void): () => void;
  rememberPermission?(request: TuiPermissionRequest, rules: readonly string[]): Promise<void>;
  choices(kind: TuiMenuKind, query: string): Promise<readonly TuiChoice[]>;
  sidebar(): Promise<TuiSidebar>;
  childTranscript(taskId: string): Promise<TuiSnapshot>;
  sendInput(text: string, attachments: readonly TuiAttachment[], delivery: "queue" | "steer"): Promise<TuiQueuedInput>;
  cancelInput(id: string, kind: "queue" | "steer"): Promise<void>;
  captureImage(): Promise<TuiAttachment | null>;
  attach(path: string): Promise<TuiAttachment>;
  writeClipboard(text: string): Promise<void>;
  setMode(mode: string): Promise<string>;
  taskAction?(taskId: string, action: "cancel" | "resume" | "message", text?: string): Promise<string>;
}
