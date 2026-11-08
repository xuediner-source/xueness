/**
 * Sidebar session list actions: rename (with its dialog request), pin,
 * archive one task or a project's tasks, reopen the archive, and refresh.
 * Moved unchanged out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { t as tr } from "../../i18n";
import { deleteSession, pinSession, renameSession } from "../../xuenessWorkbench";
import { projectArchivePlan } from "./XuenessTaskList";
import { archiveProjectSessions } from './projectArchive';
import type { SessionActivity } from "./workbenchSessionState";
import type { WorkbenchSessionData } from "./useWorkbenchSessionData";

type SessionListActionsInput = {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  activity: SessionActivity;
  data: WorkbenchSessionData;
};

export function useSessionListActions({ activeId, setActiveId, isPluginEffective, pluginEffectiveRef, activity, data }: SessionListActionsInput) {
  const { busy, setBusy, setError, run, runRequestSessions } = activity;
  const { sessions, setSession, setRows, loadActive, refreshList } = data;

  const renameById = useCallback(
    async (id: string, value: string) => {
      const target = sessions.find((s) => s.id === id);
      const current = target?.title || target?.task || "";
      const clean = value.trim();
      if (!clean || clean === current) return;
      if (await run(() => renameSession(id, clean))) {
        await refreshList();
        if (id === activeId) await loadActive(id);
      }
    },
    [sessions, activeId, run, refreshList, loadActive],
  );

  const [renameRequest, setRenameRequest] = useState<{ id: string; initialValue: string } | null>(null);
  const renameOpenerRef = useRef<HTMLElement | null>(null);
  const requestRename = useCallback(
    (id: string, returnFocusTo?: HTMLElement | null) => {
      const target = sessions.find((s) => s.id === id);
      renameOpenerRef.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setRenameRequest({ id, initialValue: target?.title || target?.task || "" });
    },
    [sessions],
  );

  // -- pin / archived --------------------------------------------------------
  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      if (await run(() => pinSession(id, pinned))) {
        await refreshList();
        if (id === activeId) await loadActive(id);
      }
    },
    [activeId, run, refreshList, loadActive],
  );

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedRevision, setArchivedRevision] = useState(0);

  const deleteById = useCallback(
    async (id: string) => {
      if (busy || !window.confirm(tr("从列表移除该任务？会话记录会归档，工作区文件不会删除。"))) return;
      if (await run(() => deleteSession(id))) {
        setArchivedRevision(previous => previous + 1);
        if (id === activeId) {
          setActiveId(null);
          setSession(null);
          setRows([]);
        }
        await refreshList();
      }
    },
    [activeId, busy, run, refreshList],
  );

  const archiveProject = useCallback(async (root: string, requestedIds: string[]) => {
    if (busy || !pluginEffectiveRef.current('sessions')) return;
    const eligible = new Set(projectArchivePlan(sessions, root).sessionIds);
    const ids = requestedIds.filter(id => eligible.has(id) && !runRequestSessions.has(id));
    if (!ids.length) return;
    setBusy(true); setError('');
    try {
      const result = await archiveProjectSessions(ids, () => pluginEffectiveRef.current('sessions'));
      if (result.archivedIds.length) {
        setArchivedRevision(previous => previous + 1);
        if (activeId && result.archivedIds.includes(activeId)) {
          setActiveId(null); setSession(null); setRows([]);
        }
        await refreshList();
      }
      if (result.error) setError(result.error);
    } finally { setBusy(false); }
  }, [busy, sessions, runRequestSessions, activeId, refreshList]);

  const handleRefreshAll = useCallback(async () => {
    if (!isPluginEffective("sessions")) return;
    await refreshList();
    if (activeId) await loadActive(activeId);
  }, [isPluginEffective, refreshList, activeId, loadActive]);

  return {
    renameById, renameRequest, setRenameRequest, renameOpenerRef, requestRename, togglePin,
    archivedOpen, setArchivedOpen, archivedRevision, deleteById, archiveProject, handleRefreshAll,
  };
}

export type SessionListActions = ReturnType<typeof useSessionListActions>;
