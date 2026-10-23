import React, { useLayoutEffect, useRef } from "react";
import {
  MENTION_NAV, parseComposerEditorState, type ComposerEditorNode, type ComposerEditorState,
  type EditorMentionKind,
} from "./composerEditorState";
import "./sessions.css";

const MENTION_KINDS = new Set<EditorMentionKind>(["file", "session", "skill", "plugin"]);

function childNavLength(child: HTMLElement): number {
  const kind = child.dataset.editorNode;
  if (kind === "mention") return MENTION_NAV.length;
  if (kind === "slash") {
    const id = child.dataset.slashId ?? "";
    return id.length + 2;
  }
  return (child.textContent ?? "").replace(/\u200B/g, "").length;
}

function topLevelElement(root: HTMLElement, node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current && current.parentNode !== root) current = current.parentNode;
  return current instanceof HTMLElement ? current : null;
}

export function readEditorCursor(root: HTMLElement): number {
  const selection = root.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !selection.focusNode || !root.contains(selection.focusNode)) {
    return [...root.children].reduce((sum, child) => sum + (child instanceof HTMLElement ? childNavLength(child) : 0), 0);
  }
  if (selection.focusNode === root) {
    const children = [...root.children];
    return children.slice(0, selection.focusOffset).reduce((sum, child) => sum + (child instanceof HTMLElement ? childNavLength(child) : 0), 0);
  }
  const host = topLevelElement(root, selection.focusNode);
  if (!host) return 0;
  let cursor = 0;
  for (const child of root.children) {
    if (child === host) break;
    if (child instanceof HTMLElement) cursor += childNavLength(child);
  }
  if (host.dataset.editorNode === "text" && selection.focusNode.nodeType === Node.TEXT_NODE) {
    const raw = selection.focusNode.textContent ?? "";
    const offset = Math.min(selection.focusOffset, raw.length);
    cursor += raw.slice(0, offset).replace(/\u200B/g, "").length;
  }
  return cursor;
}

export function placeEditorCaret(root: HTMLElement, offset: number): void {
  const doc = root.ownerDocument;
  const selection = doc.getSelection?.();
  if (!selection) return;
  let remaining = Math.max(0, offset);
  const children = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  for (const child of children) {
    const len = childNavLength(child);
    if (child.dataset.editorNode === "text" && remaining <= len) {
      const text = child.firstChild;
      if (text?.nodeType === Node.TEXT_NODE) {
        const raw = text.textContent ?? "";
        let seen = 0;
        let rawOffset = 0;
        while (rawOffset < raw.length && seen < remaining) {
          if (raw[rawOffset] !== "\u200B") seen += 1;
          rawOffset += 1;
        }
        const range = doc.createRange();
        range.setStart(text, rawOffset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    }
    if (remaining <= 0) {
      const range = doc.createRange();
      range.setStartBefore(child);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    if (remaining <= len) {
      const range = doc.createRange();
      range.setStartAfter(child);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= len;
  }
  const range = doc.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function pushText(nodes: ComposerEditorNode[], text: string) {
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") last.text += text;
  else nodes.push({ type: "text", text });
}

function consume(nodes: ComposerEditorNode[], node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    pushText(nodes, (node.textContent ?? "").replace(/\u200B/g, ""));
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.tagName === "BR") {
    pushText(nodes, "\n");
    return;
  }
  const kind = node.dataset.editorNode;
  if (kind === "mention") {
    const mentionKind = node.dataset.mentionKind ?? "";
    const id = node.dataset.mentionId ?? "";
    const label = node.textContent?.trim() || id;
    if (MENTION_KINDS.has(mentionKind as EditorMentionKind) && id) {
      nodes.push({ type: "mention", kind: mentionKind as EditorMentionKind, id, label });
      return;
    }
  }
  if (kind === "slash") {
    const id = node.dataset.slashId ?? "";
    if (/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      nodes.push({ type: "slash", id, label: id });
      return;
    }
  }
  if (node.tagName === "DIV" || node.tagName === "P") {
    if (nodes.length > 0) pushText(nodes, "\n");
  }
  for (const child of node.childNodes) consume(nodes, child);
}

export function readEditorDom(root: HTMLElement): ComposerEditorState | null {
  const nodes: ComposerEditorNode[] = [];
  for (const child of root.childNodes) consume(nodes, child);
  return parseComposerEditorState({ version: 1, nodes });
}

export function ComposerStructuredEditor({
  html,
  resetKey,
  caret,
  disabled = false,
  label,
  describedBy,
  controls,
  expanded,
  activeDescendant,
  onLocalChange,
  onDegrade,
  onKeyDown,
  onPaste,
  onDrop,
  onDragOver,
  onCompositionStart,
  onCompositionEnd,
  onCursor,
  editorRef,
}: {
  html: string;
  resetKey: number;
  caret: number | null;
  disabled?: boolean;
  label: string;
  describedBy?: string;
  controls?: string;
  expanded?: boolean;
  activeDescendant?: string;
  onLocalChange: (state: ComposerEditorState, cursor: number) => void;
  onDegrade: (text: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onCursor: (cursor: number) => void;
  editorRef: (element: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || caret == null) return;
    placeEditorCaret(root, caret);
  }, [caret, resetKey]);
  const bind = (element: HTMLDivElement | null) => {
    ref.current = element;
    editorRef(element);
  };
  const publish = () => {
    const root = ref.current;
    if (!root || composing.current) return;
    const cursor = readEditorCursor(root);
    const parsed = readEditorDom(root);
    if (!parsed) {
      onDegrade((root.textContent ?? "").replace(/\u200B/g, ""));
      return;
    }
    onLocalChange(parsed, cursor);
    onCursor(cursor);
  };
  return (
    <div
      key={resetKey}
      ref={bind}
      className="xn-composer__editor"
      contentEditable={disabled ? "false" : "true"}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-autocomplete="list"
      aria-label={label}
      aria-describedby={describedBy}
      aria-controls={controls}
      aria-expanded={expanded}
      aria-activedescendant={activeDescendant}
      data-editor="structured"
      data-testid="composer-editor"
      spellCheck
      dangerouslySetInnerHTML={{ __html: html }}
      onInput={publish}
      onKeyDown={onKeyDown}
      onKeyUp={event => onCursor(readEditorCursor(event.currentTarget))}
      onClick={event => onCursor(readEditorCursor(event.currentTarget))}
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onCompositionStart={() => {
        composing.current = true;
        onCompositionStart();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        onCompositionEnd();
        publish();
      }}
    />
  );
}
