import React from "react";
import { deleteEditorAtom, insertEditorText, type ComposerEditorState } from './composerEditorState';
import { isModKeyPressed } from '../../xuenessShortcutDisplay';
import { matchesShortcut, resolveShortcutBinding } from "../../xuenessShortcutCommands";
import { followupDelivery, type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import { readPromptHistoryEntries } from './composerDraftStore';
import { navigatePromptHistory, type ContextComposerSuggestion } from './composerInputHelpers';
import { isImeCompositionKey, composerEnterIntent } from './composerKeyboard';

export interface ComposerKeyDownHandlerContext {
  compositionActiveRef: React.MutableRefObject<boolean>;
  tokenEditor: ComposerEditorState | null;
  readSelectionOffset: () => number;
  commitStructured: (state: ComposerEditorState, cursor: number, local: boolean) => void;
  shortcutBindings: Record<string, string>;
  platform?: string;
  suggestions: ContextComposerSuggestion[];
  localInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  editorDomRef: React.MutableRefObject<HTMLDivElement | null>;
  setText: (value: string | ((previous: string) => string)) => unknown;
  text: string;
  handleSend: (requestedDelivery?: InputDelivery) => Promise<void>;
  running: boolean;
  queueWhenRunning: boolean;
  effectiveFollowupMode: FollowupMode;
  sendShortcut: "enter" | "mod-enter";
  onStop?: () => void;
  stopping: boolean;
  setSuggestDismissed: (dismissed: boolean) => void;
  plusOpen: boolean;
  closePlusMenu: (restoreFocus?: boolean) => void;
  historyIndexRef: React.MutableRefObject<number | null>;
  savedDraftTextRef: React.MutableRefObject<string>;
  currentSuggestion: number;
  acceptSuggestion: (suggestion: ContextComposerSuggestion) => void;
  setActiveSuggestion: (index: number) => void;
  resolvedWorkspaceKey: string;
  degradeToTextarea: (fallback: string) => void;
}

export function createComposerKeyDownHandler(context: ComposerKeyDownHandlerContext) {
  const {
    compositionActiveRef, tokenEditor, readSelectionOffset, commitStructured, shortcutBindings, platform, suggestions,
    localInputRef, editorDomRef, setText, text, handleSend, running, queueWhenRunning, effectiveFollowupMode,
    sendShortcut, onStop, stopping, setSuggestDismissed, plusOpen, closePlusMenu, historyIndexRef, savedDraftTextRef,
    currentSuggestion, acceptSuggestion, setActiveSuggestion, resolvedWorkspaceKey, degradeToTextarea,
  } = context;
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const isComposing = compositionActiveRef.current || isImeCompositionKey(e);
    if (tokenEditor && !isComposing && (e.key === "Backspace" || e.key === "Delete")) {
      const edited = deleteEditorAtom(tokenEditor, readSelectionOffset(), e.key === "Backspace" ? "backspace" : "delete");
      if (edited) {
        e.preventDefault();
        commitStructured(edited.state, edited.cursor, false);
        return;
      }
    }
    if (e.defaultPrevented || e.repeat) return;
    const newlineBinding = resolveShortcutBinding("insert-newline", shortcutBindings);
    if (!isComposing && matchesShortcut(e, newlineBinding, platform) && suggestions.length === 0) {
      e.preventDefault();
      const cursor = readSelectionOffset();
      if (tokenEditor) {
        const inserted = insertEditorText(tokenEditor, cursor, "\n");
        if (inserted) commitStructured(inserted.state, inserted.cursor, false);
      } else {
        const end = localInputRef.current?.selectionEnd ?? cursor;
        setText(text.slice(0, cursor) + "\n" + text.slice(end));
        requestAnimationFrame(() => localInputRef.current?.setSelectionRange(cursor + 1, cursor + 1));
      }
      return;
    }
    const sendBinding = resolveShortcutBinding("send-message", shortcutBindings);
    const stopBinding = resolveShortcutBinding("stop-generation", shortcutBindings);
    if (!isComposing && matchesShortcut(e, sendBinding, platform) && suggestions.length === 0) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (!isComposing && running && onStop && !stopping && matchesShortcut(e, stopBinding, platform)) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Escape") {
      if (isComposing) return;
      e.preventDefault();
      if (suggestions.length > 0) {
        setSuggestDismissed(true);
        return;
      }
      if (plusOpen) {
        closePlusMenu(true);
        return;
      }
      if (historyIndexRef.current !== null) {
        setText(savedDraftTextRef.current);
        historyIndexRef.current = null;
        return;
      }
      if (running && onStop && !stopping) onStop();
    } else if (e.key === "Tab" && suggestions.length > 0 && currentSuggestion >= 0) {
      if (isComposing) return;
      e.preventDefault();
      acceptSuggestion(suggestions[currentSuggestion]);
    } else if (e.key === "ArrowDown") {
      if (isComposing) return;
      if (suggestions.length > 0) {
        e.preventDefault();
        setActiveSuggestion((currentSuggestion + 1) % suggestions.length);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && historyIndexRef.current !== null) {
        e.preventDefault();
        const entries = readPromptHistoryEntries(resolvedWorkspaceKey);
        const result = navigatePromptHistory(entries, historyIndexRef.current, "down");
        if (result.nextIndex === null) {
          setText(savedDraftTextRef.current);
          historyIndexRef.current = null;
        } else {
          historyIndexRef.current = result.nextIndex;
          setText(result.nextValue);
        }
      }
    } else if (e.key === "ArrowUp") {
      if (isComposing) return;
      if (suggestions.length > 0) {
        e.preventDefault();
        setActiveSuggestion((currentSuggestion - 1 + suggestions.length) % suggestions.length);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const entries = readPromptHistoryEntries(resolvedWorkspaceKey);
        if (historyIndexRef.current === null && text.length === 0 && !tokenEditor) {
          savedDraftTextRef.current = text;
          const result = navigatePromptHistory(entries, null, "up");
          if (result.shouldHandle) {
            e.preventDefault();
            historyIndexRef.current = result.nextIndex;
            setText(result.nextValue);
          }
        } else if (historyIndexRef.current !== null) {
          const result = navigatePromptHistory(entries, historyIndexRef.current, "up");
          if (result.shouldHandle) {
            e.preventDefault();
            historyIndexRef.current = result.nextIndex;
            setText(result.nextValue);
          }
        }
      }
    } else {
      if (running && queueWhenRunning && e.key === 'Enter' && isModKeyPressed(e, platform)
          && !e.shiftKey && !e.altKey && !isComposing) {
        e.preventDefault();
        void handleSend(followupDelivery(effectiveFollowupMode, true));
        return;
      }
      const intent = composerEnterIntent(
        { ...e, compositionActive: compositionActiveRef.current },
        sendShortcut,
        suggestions.length > 0 && currentSuggestion >= 0,
        platform,
      );
      if (intent === "accept-suggestion") {
        e.preventDefault();
        acceptSuggestion(suggestions[currentSuggestion]);
      } else if (intent === "send") {
        e.preventDefault();
        void handleSend();
      } else if (tokenEditor && e.key === "Enter" && !isComposing) {
        e.preventDefault();
        const cursor = readSelectionOffset();
        const inserted = insertEditorText(tokenEditor, cursor, "\n");
        if (inserted) commitStructured(inserted.state, inserted.cursor, false);
        else degradeToTextarea((editorDomRef.current?.textContent ?? text).replace(/\u200B/g, ""));
      }
    }
  };

  return handleKeyDown;
}
