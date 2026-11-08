/**
 * How a session selection reaches the panes: the split workbench may claim it
 * for the focused pane; otherwise the primary pane switches, after saving the
 * focused timeline's scroll position. Moved unchanged out of
 * XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback, useRef } from "react";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import { isAwayFromTimelineTail } from "./ConversationTimelineViewport";
import { buildSessionScrollMemoryKey, saveSessionScrollMemoryState } from "./sessionScrollMemory";
import type { PaneSelectionHandler } from './SessionPaneWorkbench';

type PrimaryPaneSelectionInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  setActiveId: (id: string | null) => void;
  setPanel: (panel: WorkbenchPanel) => void;
  setRunError: (message: string) => void;
};

export function usePrimaryPaneSelection({ activeId, activeIdRef, setActiveId, setPanel, setRunError }: PrimaryPaneSelectionInput) {
  // An explicit session URL takes priority over the restored pane selection.
  const paneSelectionIntent = useRef(activeId !== null);
  const consumePaneSelectionIntent = useCallback(() => { const requested = paneSelectionIntent.current; paneSelectionIntent.current = false; return requested; }, []);
  const paneSelectionRef = useRef<PaneSelectionHandler | null>(null);
  const paneCreationRef = useRef<((sessionId: string) => void) | null>(null);
  const registerPaneCreation = useCallback((handler: ((sessionId: string) => void) | null) => { paneCreationRef.current = handler; }, []);
  const registerPaneSelection = useCallback((handler: PaneSelectionHandler | null) => { paneSelectionRef.current = handler; }, []);
  const selectPrimaryPaneSession = useCallback((id: string | null) => { setRunError(""); setActiveId(id); }, []);
  const selectSession = useCallback((id: string) => {
    if (paneSelectionRef.current?.(id)) { setPanel("chat"); return; }
    paneSelectionIntent.current = true;
    // 切换前保存当前会话的滚动记忆：视口在用户滚动时已持续保存，这里补一次，
    // 确保程序化滚动（如流式贴底）后的位置也不丢失。恢复由视口在挂载时按
    // sessionId 自行完成（见 sessionScrollMemory）。
    const focusedPane = document.querySelector<HTMLElement>('[data-pane-focused="true"]');
    const scroller = focusedPane?.querySelector<HTMLElement>('[data-testid="session-timeline-scroller"]');
    const memoryKey = buildSessionScrollMemoryKey({ sessionId: focusedPane?.dataset.paneSessionId || activeIdRef.current });
    if (scroller && memoryKey) {
      saveSessionScrollMemoryState(memoryKey, {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        wasPinnedToBottom: !isAwayFromTimelineTail(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight),
        updatedAt: Date.now(),
      });
    }
    setRunError("");
    setPanel("chat");
    setActiveId(id);
  }, []);

  const selectTraySession = useCallback((id: string) => {
    if (id === activeId) setPanel('chat');
    else selectSession(id);
  }, [activeId, selectSession]);

  return { paneSelectionIntent, consumePaneSelectionIntent, paneCreationRef, registerPaneCreation, registerPaneSelection, selectPrimaryPaneSession, selectSession, selectTraySession };
}
