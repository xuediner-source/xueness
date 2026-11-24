import React, { useEffect } from "react";
import { isImeCompositionKey } from './composerKeyboard';
import type { ContextComposerSuggestion } from './composerInputHelpers';

export function useComposerWindowStop({ running, onStop, stopping, editorDomRef, localInputRef, plusOpen, suggestions, platform, shortcutBindings }: {
  running: boolean;
  onStop?: () => void;
  stopping: boolean;
  editorDomRef: React.MutableRefObject<HTMLDivElement | null>;
  localInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  plusOpen: boolean;
  suggestions: ContextComposerSuggestion[];
  platform?: string;
  shortcutBindings: Record<string, string>;
}) {
  useEffect(() => {
    if (!running || !onStop || stopping) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Custom stop bindings are composer-only. Escape outside the editor belongs
      // to the focused leaf, never the first running composer's document listener.
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat || isImeCompositionKey(event)) return;
      const pane = (editorDomRef.current ?? localInputRef.current)?.closest<HTMLElement>('[data-pane-focused]');
      if (pane && (pane.hidden || pane.dataset.paneFocused !== 'true')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("textarea, input, select, [contenteditable='true']")) return;
      if (
        plusOpen ||
        suggestions.length > 0 ||
        document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"], .xn-composer-toolbar__mode[open], .xn-composer-toolbar__model[open]')
      ) return;
      event.preventDefault();
      onStop();
    };
    document.addEventListener("keydown", onWindowKeyDown);
    return () => document.removeEventListener("keydown", onWindowKeyDown);
  }, [onStop, platform, plusOpen, running, shortcutBindings, stopping, suggestions.length]);}

export function useComposerInputAutoHeight(localInputRef: React.MutableRefObject<HTMLTextAreaElement | null>, text: string, variant: string) {
  // Keep the input compact for short prompts and let it grow for longer ones.
  useEffect(() => {
    const input = localInputRef.current;
    if (!input) return;
    const maxHeight = 160;
    const measure = () => {
      input.style.height = "auto";
      const contentHeight = input.scrollHeight;
      input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = input.clientWidth;
      if (next !== width) { width = next; measure(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [text, variant]);
}
