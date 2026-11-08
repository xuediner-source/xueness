/**
 * Lightweight-profile workbench behaviour owned by the providers plugin: the
 * subagents view is unavailable, Esc / Ctrl+L / stop keys act on the minimal
 * layout, and focus lands in the new region when navigation drops it on the
 * body. Moved unchanged out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useEffect } from "react";
import { resolveHostPlatform } from "../../xuenessShortcutDisplay";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import { evaluateLightweightGlobalKey, lightweightGlobalKeyContextFromEvent, scrollToTimelineBottom } from "./LightweightWorkbench";

type LightweightWorkbenchInput = {
  lightweightLayout: boolean;
  panel: WorkbenchPanel;
  setPanel: (panel: WorkbenchPanel) => void;
  isPluginEffective: (id: string) => boolean;
  composerRunning: boolean;
  activeId: string | null;
  stoppingSessions: Set<string>;
  handleStop: () => Promise<void>;
  heroInputRef: React.MutableRefObject<HTMLElement | null>;
};

export function useLightweightWorkbench({ lightweightLayout, panel, setPanel, isPluginEffective, composerRunning, activeId, stoppingSessions, handleStop, heroInputRef }: LightweightWorkbenchInput) {
  useEffect(() => {
    if (lightweightLayout && panel === "subagents") {
      setPanel(isPluginEffective("sessions") ? "chat" : "plugins");
    }
  }, [lightweightLayout, panel, isPluginEffective]);
  useEffect(() => {
    if (!lightweightLayout) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const action = evaluateLightweightGlobalKey(e, lightweightGlobalKeyContextFromEvent(e, {
        panelOpen: panel !== "chat",
        running: composerRunning,
        stopping: activeId !== null && stoppingSessions.has(activeId),
        platform: resolveHostPlatform(),
      }));
      if (action === "clear-screen") {
        e.preventDefault();
        scrollToTimelineBottom();
        return;
      }
      if (action === "close-panel") {
        e.preventDefault();
        setPanel("chat");
        return;
      }
      if (action === "stop") {
        e.preventDefault();
        void handleStop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightweightLayout, panel, composerRunning, activeId, stoppingSessions, handleStop]);
  // 轻量档补齐焦点：导航换了区域而焦点被丢到 body 时，把它落到新区域的合理落点。
  useEffect(() => {
    if (!lightweightLayout) return;
    const target = panel === "chat"
      ? heroInputRef.current
      : document.querySelector<HTMLElement>(".xn-secondary-view__back");
    if (!target) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    target.focus();
  }, [lightweightLayout, panel]);
}
