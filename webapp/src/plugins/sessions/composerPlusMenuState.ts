import React, { useEffect, useRef, useState } from "react";
import { isImeCompositionKey } from './composerKeyboard';

export function useComposerPlusMenu() {
  const [plusOpen, setPlusOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const plusRef = useRef<HTMLDivElement | null>(null);
  const plusButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const closePlusMenu = (restoreFocus = false) => {
    setPlusOpen(false);
    setAddSearch('');
    if (restoreFocus) plusButtonRef.current?.focus();
  };
  const openAttachmentPicker = () => {
    closePlusMenu();
    attachInputRef.current?.click();
  };
  const handlePlusMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeCompositionKey(event)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePlusMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length]?.focus();
    } else if (event.target instanceof HTMLInputElement) {
      // Searching the Add menu must never submit the enclosing message form.
      if (event.key === 'Enter') { event.preventDefault(); items[0]?.focus(); }
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  useEffect(() => {
    if (!plusOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)');
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) closePlusMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [plusOpen]);

  return {
    plusOpen, setPlusOpen, addSearch, setAddSearch, plusRef, plusButtonRef, menuRef, attachInputRef,
    closePlusMenu, openAttachmentPicker, handlePlusMenuKeyDown,
  };
}
