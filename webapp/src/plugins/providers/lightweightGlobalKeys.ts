import { isImeComposingEvent, isModKeyPressed } from "../../xuenessShortcutDisplay";

export function scrollToTimelineBottom(): void {
  const scroller = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(
    ".xn-session-timeline-viewport__scroll, [data-testid=\"session-timeline-scroller\"], .xn-conversation__stream",
  );
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

export const OVERLAY_SELECTOR = '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], .xn-command-overlay, .xn-select-menu';

export function hasOpenLightweightOverlay(): boolean {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return false;
  return Boolean(document.querySelector(OVERLAY_SELECTOR));
}

export function isEditableKeyTarget(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest("textarea, input, select, [contenteditable='true']"));
}

export type LightweightGlobalKeyAction = "clear-screen" | "close-panel" | "stop" | null;

export type LightweightGlobalKeyContext = {
  inComposer: boolean;
  inEditableField: boolean;
  overlayOpen: boolean;
  panelOpen: boolean;
  running: boolean;
  stopping: boolean;
  platform?: string;
};

export function lightweightGlobalKeyContextFromEvent(
  event: { target: unknown },
  state: { panelOpen: boolean; running: boolean; stopping: boolean; platform?: string },
): LightweightGlobalKeyContext {
  const inEditableField = isEditableKeyTarget(event.target);
  const inComposer = Boolean((event.target as HTMLElement | null)?.closest?.('[data-testid="lightweight-composer-input"]'));
  return {
    inComposer,
    inEditableField,
    overlayOpen: hasOpenLightweightOverlay(),
    panelOpen: state.panelOpen,
    running: state.running,
    stopping: state.stopping,
    platform: state.platform,
  };
}

export function evaluateLightweightGlobalKey(
  e: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  context: LightweightGlobalKeyContext,
): LightweightGlobalKeyAction {
  if (e.defaultPrevented || e.repeat || isImeComposingEvent(e)) return null;
  if (context.overlayOpen) return null;
  const isMod = context.platform
    ? isModKeyPressed(e, context.platform)
    : Boolean((e.ctrlKey && !e.metaKey) || (e.metaKey && !e.ctrlKey));
  if (isMod && !e.altKey && !e.shiftKey && (e.key === "l" || e.key === "L")) {
    if (context.inComposer) return null;
    return context.inEditableField ? null : "clear-screen";
  }
  if (e.key === "Escape") {
    if (context.panelOpen) return "close-panel";
    if (context.inEditableField) return null;
    return context.running && !context.stopping ? "stop" : null;
  }
  return null;
}
