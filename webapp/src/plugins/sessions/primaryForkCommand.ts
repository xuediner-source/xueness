import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import { forkSession, type ForkSessionResponse } from '../../xuenessWorkbench';
import type { WorkbenchPanel } from '../../xuenessPluginRegistry';
import type { SessionCommandClient } from './commandClient';
import type { PaneForkCommand } from './paneForkActions';
import type { ConversationTextSelection } from './ConversationSelectionActions';
import { selectedTextPrompt } from './workbenchSessionState';
import type { WorkbenchSessionData } from './useWorkbenchSessionData';

type PrimaryForkInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  setActiveId: (id: string | null) => void;
  setPanel: (panel: WorkbenchPanel) => void;
  isPluginEffective: (id: string) => boolean;
  busy: boolean;
  setRunError: (message: string) => void;
  data: WorkbenchSessionData;
  appendTextToComposer: (targetSessionId: string | null, text: string, workspaceRoot?: string) => void;
  loadedSessionChoices: React.MutableRefObject<string | null>;
};

/** The primary pane's fork dialog: fork from a turn, or ask about a selection in a side chat. */
export function usePrimaryFork({ activeId, activeIdRef, setActiveId, setPanel, isPluginEffective, busy, setRunError, data, appendTextToComposer, loadedSessionChoices }: PrimaryForkInput) {
  const { session, sessionSnapshotRef, sessionCommands, setSessions, refreshList } = data;
  const [forkSource, setForkSource] = useState<{ id: string; title: string; turn?: number; root?: string; selectedText?: string; selectedTurnId?: string } | null>(null);

  const handleAddSelectionToCurrentTask = useCallback((selection: ConversationTextSelection) => {
    const targetSessionId = activeId;
    const current = sessionSnapshotRef.current;
    if (!targetSessionId || !current || current.id !== targetSessionId || !isPluginEffective('sessions')) return;
    appendTextToComposer(targetSessionId, selectedTextPrompt(current.title || current.task, selection.turnId, selection.text));
  }, [activeId, appendTextToComposer, isPluginEffective]);

  const handleAskSelectionInSideChat = useCallback((selection: ConversationTextSelection) => {
    const targetSessionId = activeId;
    const current = sessionSnapshotRef.current;
    if (!targetSessionId || !current || current.id !== targetSessionId || !isPluginEffective('sessions')
      || current.status === 'running' || current.streaming?.status === 'streaming' || busy) return;
    const turn = /^turn-([1-9][0-9]*)$/u.exec(selection.turnId);
    setForkSource({ id: targetSessionId, title: current.title || current.task || tr('未命名任务'),
      ...(current.root ? { root: current.root } : {}), ...(turn ? { turn: Number(turn[1]) } : {}),
      selectedText: selection.text, selectedTurnId: selection.turnId });
  }, [activeId, busy, isPluginEffective]);

  const createPrimaryFork = usePrimaryForkCommand(sessionCommands, isPluginEffective("sessions"), activeId);
  const beginFork = useCallback((turn?: number) => {
    const isRunning = session?.status === "running" || session?.streaming?.status === "streaming";
    if (!activeId || session?.id !== activeId || busy || isRunning || !isPluginEffective("sessions")) return;
    setForkSource({ id: activeId, title: session.title || session.task || tr("未命名任务"), turn });
  }, [activeId, session, busy, isPluginEffective]);

  const completeFork = useCallback((result: ForkSessionResponse) => {
    const source = forkSource;
    setForkSource(null);
    if (!source || result.sourceId !== source.id) return;
    const child = result.session;
    const title = child.title || tr("未命名任务");
    if (source.selectedText) {
      appendTextToComposer(child.id, selectedTextPrompt(source.title, source.selectedTurnId ?? `turn-${source.turn ?? 1}`, source.selectedText, true), child.root ?? source.root);
    }
    setSessions(previous => [{ id: child.id, task: title, title, status: child.status, root: child.root }, ...previous.filter(item => item.id !== child.id)]);
    void refreshList();
    // The modal is bound to its opening session. A slow fork must not steal focus
    // if the user has navigated to a different conversation in the meantime.
    if (activeIdRef.current !== source.id) return;
    loadedSessionChoices.current = null;
    setRunError("");
    setPanel("chat");
    setActiveId(child.id);
  }, [forkSource, refreshList, appendTextToComposer]);

  return { forkSource, setForkSource, createPrimaryFork, beginFork, completeFork, handleAddSelectionToCurrentTask, handleAskSelectionInSideChat };
}

/** Primary history retains unresolved fork intent independently of modal mounts.
 * Load fork admission only on use; receipt hydration remains synchronous in the
 * shared command handle, including before this optional action is loaded.
 */
export function usePrimaryForkCommand(commands: SessionCommandClient, enabled: boolean, activeId: string | null): typeof forkSession {
  const pending = useRef(new Map<string, PaneForkCommand>());
  const live = useRef({ enabled, activeId, commands }); live.current = { enabled, activeId, commands };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return useMemo(() => async (id, boundary, revision, title) => {
    const current = () => mounted.current && live.current.enabled && live.current.activeId === id
      && live.current.commands === commands && commands.isEffective();
    if (!current()) return { ok: false, error: 'Fork scope changed' };
    let command = pending.current.get(id);
    if (!command) {
      let module: typeof import('./paneForkActions');
      try { module = await import('./paneForkActions'); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      const { PaneForkCommand } = module;
      if (!current()) return { ok: false, error: 'Fork scope changed' };
      // Concurrent clicks may finish loading together: share the first admitted
      // command so its busy flag and durable ID still serialize every attempt.
      command = pending.current.get(id);
      if (!command) { command = new PaneForkCommand(commands, id); pending.current.set(id, command); }
    }
    const result = await forkSession(id, boundary, revision, title, (_path, body) => command!.submit(body as Record<string, unknown>));
    if (!current()) return { ok: false, error: 'Fork scope changed; return to the source to check the original result' };
    if (result.ok) pending.current.delete(id);
    return result;
  }, [commands]);
}
