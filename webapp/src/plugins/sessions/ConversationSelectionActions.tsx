import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t as tr } from '../../i18n';

export type ConversationTextSelection = {
  text: string;
  turnId: string;
  rowKey: string;
  rowKind: string;
  rowSeq: number;
  overLimit?: boolean;
};

const MAX_SELECTION_LENGTH = 8_000;

function measureSelection(text: string, overLimit: boolean): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selectedText = selection.toString().trim();
  if (overLimit ? !selectedText.startsWith(text.trim()) : selectedText !== text.trim()) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

export function ConversationSelectionActions({
  selection,
  sideActionDisabled = false,
  onAdd,
  onAsk,
}: {
  selection: ConversationTextSelection;
  sideActionDisabled?: boolean;
  onAdd: (selection: ConversationTextSelection) => void;
  onAsk: (selection: ConversationTextSelection) => void;
}): React.JSX.Element | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const refresh = () => setRect(measureSelection(selection.text, selection.overLimit === true));
    refresh();
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    document.addEventListener('selectionchange', refresh);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      document.removeEventListener('selectionchange', refresh);
    };
  }, [selection]);

  if (!rect || typeof document === 'undefined') return null;
  const tooLong = selection.overLimit === true || selection.text.length > MAX_SELECTION_LENGTH;
  const width = 310;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  const preferredTop = rect.top - 46;
  const top = preferredTop >= 12 ? preferredTop : Math.min(window.innerHeight - 52, rect.bottom + 8);

  return createPortal(
    <div
      className="xn-selection-actions"
      data-testid="conversation-selection-actions"
      data-conversation-selection-tooltip="true"
      role="toolbar"
      aria-label={tr('选中文本操作')}
      style={{ left, top }}
      onPointerDown={event => event.preventDefault()}
      onMouseDown={event => event.preventDefault()}
    >
      {tooLong ? (
        <span className="xn-selection-actions__limit" role="status">{tr('选中的文本过长')}</span>
      ) : (
        <>
          <button type="button" data-conversation-selection-action="add-to-task"
            onClick={() => onAdd(selection)}>{tr('添加到当前任务')}</button>
          <span aria-hidden="true" className="xn-selection-actions__divider" />
          <button type="button" data-conversation-selection-action="ask-in-side-chat"
            disabled={sideActionDisabled}
            title={sideActionDisabled ? tr('当前运行结束后才能打开辅助对话。') : undefined}
            onClick={() => { if (!sideActionDisabled) onAsk(selection); }}>{tr('在辅助对话中提问')}</button>
        </>
      )}
    </div>,
    document.body,
  );
}
