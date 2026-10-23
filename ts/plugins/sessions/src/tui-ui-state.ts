import { ChatEditor } from "./tui-editor.ts";
import { createTuiDocument } from "./tui-transcript.ts";
import { createSidebarState } from "./tui-sidebar.ts";
import type { TuiAttachment, TuiContext, TuiDialog, TuiDocument, TuiMenu, TuiQueuedInput, TuiSidebar, TuiThemeMode } from "./tui-types.ts";

export function createTuiUiState(language: "zh" | "en") {
  return {
    language, draft: new ChatEditor(), answer: new ChatEditor(),
    context: {} as TuiContext, document: createTuiDocument(), child: null as TuiDocument | null,
    running: false, prompt: null as string | null, notice: "", scroll: 0, sidebarScroll: 0,
    sidebar: createSidebarState(), data: { files: [], todos: [], subagents: [], mcp: [], workflows: [], apis: [] } as TuiSidebar,
    menu: null as TuiMenu | null, dismissedMenu: "", menuRequest: 0,
    dialog: null as TuiDialog<unknown> | null, resolveDialog: null as ((value: unknown) => void) | null,
    attachments: [] as TuiAttachment[], queued: [] as TuiQueuedInput[],
    detectedTheme: undefined as TuiThemeMode | undefined,
    exitPressedAt: 0, sidebarPressedAt: 0,
    selection: null as { start: { line: number; column: number }; end: { line: number; column: number } } | null,
    dragging: false,
  };
}
export type TuiUiState = ReturnType<typeof createTuiUiState>;
export const activeEditor = (ui: TuiUiState): ChatEditor => ui.running && ui.prompt !== null ? ui.answer : ui.draft;
