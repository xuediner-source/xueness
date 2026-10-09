import { t as tr, tf } from '../../i18n';
import React from "react";
import { deferCompositionEnd, isImeComposingEvent } from '../../xuenessShortcutDisplay';

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
  /** Element that opened the dialog; restored after cancel or submit. */
  returnFocusTo?: HTMLElement | null;
  onCancel?: () => void;
  onConfirm?: (value: string) => void;
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function shouldDismissRenameOnEscape(event: {
  key: string;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
  isComposing?: boolean;
  compositionActive?: boolean;
}): boolean {
  if (event.key !== "Escape") return false;
  return !isImeComposingEvent(event);
}

export function trapRenameDialogTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  activeElement: unknown,
  items: { focus: () => void }[],
  fallbackInput?: { focus?: () => void } | null,
): boolean {
  if (event.key !== "Tab") return false;
  if (!items.length) {
    event.preventDefault();
    fallbackInput?.focus?.();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const activeIndex = items.indexOf(activeElement as { focus: () => void });
  if (activeIndex < 0) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  } else if (event.shiftKey && activeIndex === 0) {
    event.preventDefault();
    last.focus();
    return true;
  } else if (!event.shiftKey && activeIndex === items.length - 1) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function XuenessRenameDialog({
  open,
  initialValue,
  title = tr("重命名任务"),
  returnFocusTo,
  onCancel,
  onConfirm,
}: RenameDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = React.useState(initialValue);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const compositionActiveRef = React.useRef(false);

  // Capture the invoking control before the next effect moves focus into the
  // dialog. Some entry points pass their row explicitly because a menu closes
  // in the same update that opens this dialog.
  React.useEffect(() => {
    if (!open) return;
    openerRef.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
  }, [open, returnFocusTo]);

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

  React.useEffect(() => {
    if (!open) return;
    const keepFocusInside = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        const target = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? inputRef.current;
        target?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInside, true);
    };
  }, [open]);

  if (!open) return null;

  const value = draft.trim();
  const confirmDisabled = !value || value === initialValue;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // An IME composition's Enter confirms the composition, not the dialog.
    if (compositionActiveRef.current || isImeComposingEvent(event)) return;
    if (event.key === "Enter") {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "BUTTON") return;
      event.preventDefault();
      if (!confirmDisabled) onConfirm?.(value);
      return;
    }
    if (shouldDismissRenameOnEscape(event)) {
      event.preventDefault();
      onCancel?.();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const allItems = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((item) => item.getAttribute("aria-hidden") !== "true");
    const visibleItems = allItems.filter((item) => item.getClientRects().length > 0);
    const items = visibleItems.length > 0 ? visibleItems : allItems;
    trapRenameDialogTab(event, document.activeElement, items, inputRef.current);
  };

  return (
    <div
      className="xn-dialog-overlay"
      onClick={onCancel}
      role="presentation"
      data-testid="xn-rename-dialog"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="xn-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h2 className="xn-dialog__title">{title}</h2>
        <input
          ref={inputRef}
          className="xn-dialog__input"
          data-testid="xn-rename-input"
          aria-label={title}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
