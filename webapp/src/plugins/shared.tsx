import React from "react";
import { t as tr } from "../i18n";

type FocusRef = { current: HTMLElement | null };

/**
 * All plugin-owned modal dialogs share the same focus boundary behavior.
 * Keeping it here prevents each feature plugin from implementing a subtly
 * different keyboard trap or leaving focus behind after dismissal.
 */
export function useModalFocusScope({
  open,
  dialogRef,
  initialFocusRef,
  returnFocusTo,
}: {
  open: boolean;
  dialogRef: FocusRef;
  initialFocusRef?: FocusRef;
  returnFocusTo?: HTMLElement | null;
}): void {
  React.useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href],button:not(:disabled):not([aria-disabled="true"]),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    )).filter(element => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
    const isTopmost = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).at(-1) === dialog;
    const focusInitial = () => (initialFocusRef?.current ?? focusable()[0] ?? dialog).focus({ preventScroll: true });
    const focusFrame = window.requestAnimationFrame(focusInitial);
    const keepFocusInside = (event: FocusEvent) => {
      if (!isTopmost() || dialog.contains(event.target as Node)) return;
      focusInitial();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (!isTopmost() || event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || (event.shiftKey && index === 0)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus({ preventScroll: true });
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        items[0]?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside, true);
    document.addEventListener("keydown", trapTab, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", keepFocusInside, true);
      document.removeEventListener("keydown", trapTab, true);
      window.requestAnimationFrame(() => {
        const remaining = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).at(-1);
        if (remaining && opener && !remaining.contains(opener)) return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      });
    };
  }, [open, dialogRef, initialFocusRef, returnFocusTo]);
}

export function shouldDismissModalOnEscape(event: {
  key: string;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  keyCode?: number;
}, busy = false): boolean {
  return event.key === "Escape" && !busy && !(event.isComposing ?? event.nativeEvent?.isComposing) && event.keyCode !== 229;
}

const STATUS_LABELS: Record<string, string> = { created: '待执行', pending: '等待中', queued: '已排队', running: '运行中', pausing: '正在暂停', paused: '已暂停', stopping: '正在取消', cancelled: '已取消', completed: '已完成', failed: '失败', interrupted: '已中断', blocked: '受阻', closed: '已关闭' };
export function OperationStatus({ status }: { status: string }) { return <span className="xn-operation-status" data-status={status}><span aria-hidden="true" />{tr(STATUS_LABELS[status] || status)}</span>; }
export function OperationHeader({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) { return <header className="xn-operation-heading"><span className="xn-operation-heading__icon" aria-hidden="true">{icon}</span><div><h2>{title}</h2><p>{description}</p></div></header>; }
