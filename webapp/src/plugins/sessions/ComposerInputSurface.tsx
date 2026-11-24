import React from "react";
import { t as tr } from '../../i18n';
import { ComposerStructuredEditor } from './ComposerStructuredEditor';
import { deferCompositionEnd } from '../../xuenessShortcutDisplay';
import { isFileDragEvent } from './composerInputHelpers';
import type { ContextComposerSuggestion } from './composerInputHelpers';
import type { ComposerEditorState } from './composerEditorState';
import type { ComposerProps } from './composerTypes';

export function ComposerInputSurface({
  tokenEditor, editorSurface, disabled, minimal, suggestionListId, suggestions, currentSuggestion, inputRef, editorDomRef,
  commitStructured, degradeToTextarea, handleKeyDown, handlePasteEvent, handleDropEvent, compositionActiveRef,
  setCursorOffset, attachRef, structuredDraft, text, setText, historyIndexRef, setSuggestDismissed, setActiveSuggestion,
  setSubmissionError, placeholder, autoFocus,
}: {
  tokenEditor: ComposerEditorState | null;
  editorSurface: { scope: string; key: number; signature: string; html: string; caret: number };
  disabled: boolean;
  minimal: boolean;
  suggestionListId: string;
  suggestions: ContextComposerSuggestion[];
  currentSuggestion: number;
  inputRef: ComposerProps['inputRef'];
  editorDomRef: React.MutableRefObject<HTMLDivElement | null>;
  commitStructured: (state: ComposerEditorState, cursor: number, local: boolean) => void;
  degradeToTextarea: (fallback: string) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  handlePasteEvent: (event: React.ClipboardEvent) => void;
  handleDropEvent: (event: React.DragEvent) => void;
  compositionActiveRef: React.MutableRefObject<boolean>;
  setCursorOffset: (offset: number | null) => void;
  attachRef: (el: HTMLTextAreaElement | null) => void;
  structuredDraft: boolean;
  text: string;
  setText: (value: string | ((previous: string) => string)) => unknown;
  historyIndexRef: React.MutableRefObject<number | null>;
  setSuggestDismissed: (dismissed: boolean) => void;
  setActiveSuggestion: (index: number) => void;
  setSubmissionError: (message: string) => unknown;
  placeholder: string;
  autoFocus: boolean;
}) {
  return tokenEditor ? <ComposerStructuredEditor
        html={editorSurface.html}
        resetKey={editorSurface.key}
        caret={editorSurface.caret}
        disabled={disabled}
        label={tr("输入消息或指令...")}
        describedBy={minimal ? undefined : `${suggestionListId}-keyboard-help`}
        controls={suggestions.length ? suggestionListId : undefined}
        expanded={suggestions.length > 0}
        activeDescendant={currentSuggestion >= 0 ? `${suggestionListId}-option-${currentSuggestion}` : undefined}
        editorRef={element => {
          editorDomRef.current = element;
          if (typeof inputRef === "function") inputRef(element);
          else if (inputRef && typeof inputRef === "object") {
            (inputRef as React.MutableRefObject<HTMLElement | null>).current = element;
          }
        }}
        onLocalChange={(state, cursor) => commitStructured(state, cursor, true)}
        onDegrade={degradeToTextarea}
        onKeyDown={handleKeyDown}
        onPaste={handlePasteEvent}
        onDrop={handleDropEvent}
        onDragOver={event => {
          if (isFileDragEvent(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onCompositionStart={() => { compositionActiveRef.current = true; }}
        onCompositionEnd={() => { deferCompositionEnd(() => { compositionActiveRef.current = false; }); }}
        onCursor={setCursorOffset}
      /> : <textarea
        ref={attachRef}
        className="xn-composer__input"
        data-editor={structuredDraft ? "text" : "textarea"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCursorOffset(e.target.selectionStart);
          historyIndexRef.current = null;
          setSuggestDismissed(false);
          setActiveSuggestion(0);
          setSubmissionError("");
        }}
        onSelect={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onClick={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onCompositionStart={(event) => {
          compositionActiveRef.current = true;
          event.currentTarget.setAttribute("data-composing", "true");
        }}
        onCompositionEnd={(event) => {
          const el = event.currentTarget;
          deferCompositionEnd(() => {
            compositionActiveRef.current = false;
            el?.removeAttribute("data-composing");
          });
        }}
        onPaste={handlePasteEvent}
        onDragOver={(event) => {
          if (isFileDragEvent(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={handleDropEvent}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-label={tr("输入消息或指令...")}
        aria-controls={suggestions.length ? suggestionListId : undefined}
        aria-expanded={suggestions.length > 0}
        aria-activedescendant={currentSuggestion >= 0 ? `${suggestionListId}-option-${currentSuggestion}` : undefined}
        aria-describedby={minimal ? undefined : `${suggestionListId}-keyboard-help`}
      />;
}
