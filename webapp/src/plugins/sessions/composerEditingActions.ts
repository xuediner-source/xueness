import React from "react";
import { applyEditorSuggestion, contextAfterEditorEdit, editorHasAtomicNodes, editorStateForPlainText, editorStateMatching, editorStateSignature, parseComposerEditorState, sendableText, type ComposerEditorState } from './composerEditorState';
import { readEditorCursor } from './ComposerStructuredEditor';
import type { ComposerMention, ComposerStartActions, ContextComposerSuggestion } from './composerInputHelpers';
import type { ComposerDraftsRef, UpdateComposerDraft } from './composerHandlerTypes';

export interface ComposerEditingActionsContext {
  tokenEditor: ComposerEditorState | null;
  editorDomRef: React.MutableRefObject<HTMLDivElement | null>;
  localInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  cursorOffset: number | null;
  text: string;
  draftsRef: ComposerDraftsRef;
  scopedDraftKey: string;
  localEditSignature: React.MutableRefObject<string>;
  pendingCaret: React.MutableRefObject<number | null>;
  updateCurrentDraft: UpdateComposerDraft;
  setCursorOffset: (offset: number | null) => void;
  richComposer: boolean;
  startActions?: ComposerStartActions;
  setGoal: (value: boolean | ((previous: boolean) => boolean)) => unknown;
  setText: (value: string | ((previous: string) => string)) => unknown;
  addContext: (mention: ComposerMention) => void;
  selectedMention: (kind: ComposerMention["kind"], id: string) => ComposerMention;
  setSuggestDismissed: (dismissed: boolean) => void;
  setActiveSuggestion: (index: number) => void;
}

export function createComposerEditingActions(context: ComposerEditingActionsContext) {
  const {
    tokenEditor, editorDomRef, localInputRef, cursorOffset, text, draftsRef, scopedDraftKey, localEditSignature,
    pendingCaret, updateCurrentDraft, setCursorOffset, richComposer, startActions, setGoal, setText, addContext,
    selectedMention, setSuggestDismissed, setActiveSuggestion,
  } = context;
  const readSelectionOffset = () => {
    if (tokenEditor && editorDomRef.current) return readEditorCursor(editorDomRef.current);
    return localInputRef.current?.selectionStart ?? cursorOffset ?? text.length;
  };
  const commitStructured = (state: ComposerEditorState, cursor: number, local: boolean) => {
    const previous = parseComposerEditorState(draftsRef.current.get(scopedDraftKey)?.editorState);
    if (local) localEditSignature.current = editorStateSignature(state);
    else pendingCaret.current = cursor;
    updateCurrentDraft(current => ({
      ...current,
      text: sendableText(state),
      editorState: state,
      selectedContext: contextAfterEditorEdit(current.selectedContext, previous, state),
      submissionError: "",
    }));
    setCursorOffset(cursor);
  };
  const acceptSuggestion = (suggestion: ContextComposerSuggestion) => {
    const cursor = readSelectionOffset();
    if (richComposer) {
      const base = editorStateMatching(text, draftsRef.current.get(scopedDraftKey)?.editorState) ?? editorStateForPlainText(text);
      const applied = base ? applyEditorSuggestion(base, cursor, suggestion) : null;
      if (applied) {
        if (suggestion.kind === "goal") {
          if (startActions?.onGoal) startActions.onGoal();
          else setGoal(current => !current);
        } else if (suggestion.kind === "workflow") startActions?.onWorkflow();
        else if (suggestion.kind !== "command") addContext(selectedMention(suggestion.kind, suggestion.token));
        commitStructured(applied.state, applied.cursor, false);
        setSuggestDismissed(false);
        setActiveSuggestion(0);
        if (!editorHasAtomicNodes(applied.state)) {
          setTimeout(() => {
            localInputRef.current?.focus();
            try { localInputRef.current?.setSelectionRange(applied.cursor, applied.cursor); } catch { /* The structured surface has no selection range. */ }
          }, 0);
        }
        return;
      }
    }
    let nextText = text;
    let nextCursor = cursor;

    const offset = cursor;
    const before = text.slice(0, offset);
    const after = text.slice(offset);

    if (suggestion.kind === "goal") {
      if (startActions?.onGoal) startActions.onGoal();
      else setGoal((current) => !current);
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else if (suggestion.kind === "workflow") {
      startActions?.onWorkflow();
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else if (suggestion.kind === "command") {
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) =>
        (match.match(/^\s*/)?.[0] ?? "") + "/" + suggestion.token + " ",
      );
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else {
      addContext(selectedMention(suggestion.kind, suggestion.token));
      const expression = suggestion.kind === "skill"
        ? /(?:^|\s)\$([^\s@#$]*)$/
        : /(?:^|\s)@[^\s@#$]*$/;
      const replaced = before.replace(expression, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    }

    setText(nextText);
    setCursorOffset(nextCursor);
    setSuggestDismissed(false);
    setActiveSuggestion(0);
    setTimeout(() => {
      localInputRef.current?.focus();
      try {
        localInputRef.current?.setSelectionRange(nextCursor, nextCursor);
      } catch {}
    }, 0);
  };
  const degradeToTextarea = (fallback: string) => {
    localEditSignature.current = "";
    pendingCaret.current = null;
    updateCurrentDraft(current => ({ ...current, text: fallback, editorState: undefined, submissionError: "" }));
  };

  return { readSelectionOffset, commitStructured, acceptSuggestion, degradeToTextarea };
}
