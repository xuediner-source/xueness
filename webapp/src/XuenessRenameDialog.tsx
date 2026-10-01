import { t as tr, tf } from './i18n';
import React from "react";

/**
 * Modal rename dialog for sessions (replaces window.prompt):
 * overlay click / Esc / 取消 cancel; Enter or 确认 commit the trimmed value.
 * The confirm button stays disabled while the draft is empty or unchanged.
 */
export type RenameDialogProps = {
  open: boolean;
  initialValue: string;
  /** Dialog heading; also the accessible name of both dialog and input. */
  title?: string;
  onCancel?: () => void;
  onConfirm?: (value: string) => void;
};

export function XuenessRenameDialog({
  open,
  initialValue,
  title = tr("重命名任务"),
  onCancel,
  onConfirm,
}: RenameDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = React.useState(initialValue);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Re-seed the draft whenever the dialog opens or the source title changes.
  React.useEffect(() => {
    if (open) {
      setDraft(initialValue);
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }
  }, [open, initialValue]);

  if (!open) return null;

  const value = draft.trim();
  const confirmDisabled = !value || value === initialValue;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // An IME composition's Enter confirms the composition, not the dialog.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!confirmDisabled) onConfirm?.(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  };

  return (
    <div
      className="xn-dialog-overlay"
      onClick={onCancel}
      role="presentation"
      data-testid="xn-rename-dialog"
    >
      <div
        className="xn-dialog"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="xn-dialog__title">{title}</h2>
        <input
          ref={inputRef}
          className="xn-dialog__input"
          data-testid="xn-rename-input"
          aria-label={title}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="xn-dialog__actions">
          <button
            type="button"
            className="xn-btn xn-btn--md xn-btn--secondary"
            data-testid="xn-rename-cancel"
            onClick={onCancel}
          >{tr("取消")}</button>
          <button
            type="button"
            className="xn-btn xn-btn--md xn-btn--primary"
            data-testid="xn-rename-confirm"
            disabled={confirmDisabled}
            onClick={() => onConfirm?.(value)}
          >{tr("确认")}</button>
        </div>
      </div>
    </div>
  );
}
