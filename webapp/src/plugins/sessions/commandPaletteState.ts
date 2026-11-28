import { useCallback, useEffect, useRef, useState } from "react";
import { t as tr } from "../../i18n";
import { shouldDismissModalOnEscape } from "../shared";
import { sessionStatusPresentation } from "./statusPresentation";

export function commandPaletteStatusLabel(status: string, pendingInteraction?: unknown): string {
  return sessionStatusPresentation(status, { pendingInteraction })?.label ?? tr(status);
}

export function paletteWorkspaceLabel(root?: string): string {
  const parts = (root ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return "";
  return parts.length > 1 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : parts[0];
}

export function formatPaletteUpdatedAt(value: string | undefined, locale: "zh" | "en"): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

/** Open state, opener tracking and Escape handling for the workbench's Ctrl+K palette. */
export function useCommandPaletteState(isPluginEffective: (id: string) => boolean) {
  const [commandOpen, setCommandOpen] = useState(false);
  const commandRef = useRef<HTMLInputElement | null>(null);
  const commandDialogRef = useRef<HTMLDivElement | null>(null);
  const commandOpenerRef = useRef<HTMLElement | null>(null);
  const commandPaletteEnabled = commandOpen && isPluginEffective("sessions");

  const openCommandPalette = useCallback((returnFocusTo?: HTMLElement | null) => {
    if (!isPluginEffective("sessions") || commandOpen) return;
    const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // Search closes the narrow sidebar. Return focus to its visible toggle.
    commandOpenerRef.current = opener?.closest("#xn-shell-sidebar") && window.matchMedia("(max-width: 900px)").matches
      ? document.querySelector<HTMLButtonElement>('[data-testid="xn-desktop-titlebar-sidebar"], [data-testid="xn-shell-sidebar-toggle"]')
      : opener;
    setCommandOpen(true);
  }, [commandOpen, isPluginEffective]);

  useEffect(() => {
    if (!commandPaletteEnabled) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialog = commandDialogRef.current;
      if (dialog && Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).at(-1) !== dialog) return;
      if (!shouldDismissModalOnEscape(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setCommandOpen(false);
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [commandPaletteEnabled]);
  useEffect(() => {
    if (commandOpen && !isPluginEffective("sessions")) setCommandOpen(false);
  }, [commandOpen, isPluginEffective]);

  return { commandOpen, setCommandOpen, commandRef, commandDialogRef, commandOpenerRef, commandPaletteEnabled, openCommandPalette };
}
