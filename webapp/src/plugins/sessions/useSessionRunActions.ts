/**
 * Run-level actions on the active session: confirmed run requests, approvals,
 * stop, retries, question answers and message edit / feedback. Each action is
 * bound to the session that started it and re-reads the conversation after
 * the round trip. Moved unchanged out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback } from "react";
import { t as tr } from "../../i18n";
import { getRunChoices, setRunChoices, type RunChoices } from "../../xuenessBridge";
import { approvePending, runSession, stopSession, updateConversationMessage, type PendingApproval, type Result, type TimelineRow } from "../../xuenessWorkbench";
import { useRunPermissionConfirmation } from "./useRunPermissionConfirmation";
import { trackSessionId, type SessionActivity } from "./workbenchSessionState";
import type { WorkbenchSessionData } from "./useWorkbenchSessionData";

type SessionRunActionsInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  activity: SessionActivity;
  data: WorkbenchSessionData;
  /** The draft workspace a confirmation applies to when no session is active. */
  draftScopeRoot: string;
  setChoices: (choices: RunChoices) => void;
};

export function useSessionRunActions({ activeId, activeIdRef, isPluginEffective, pluginEffectiveRef, activity, data, draftScopeRoot, setChoices }: SessionRunActionsInput) {
  const { busy, setBusy, setError, setRunError, run, runRequestSessionsRef, setRunRequestSessions, executingSessionsRef, setExecutingSessions, stoppingSessionsRef, setStoppingSessions } = activity;
  const { session, sessionSnapshotRef, sessionCommands, loadActive, refreshList } = data;

  /** Session runs are long-lived and must not lock navigation for other chats. */
  const runPermission = useRunPermissionConfirmation(`${activeId ?? 'draft'}:${draftScopeRoot}`, isPluginEffective('sessions'));
  const runSessionRequest = useCallback(async (id: string, action: (selected: RunChoices) => Promise<Result<unknown>>, selectedChoices?: RunChoices) => {
    const snapshot = sessionSnapshotRef.current;
    const selected = await runPermission.ensure(selectedChoices ?? getRunChoices(), snapshot?.id === id ? snapshot.permission_mode : undefined);
    if (!selected || activeIdRef.current !== id || !sessionCommands.isEffective()) return { ok: false };
    setRunChoices(selected);
    setChoices(selected);
    trackSessionId(runRequestSessionsRef, setRunRequestSessions, id, true);
    trackSessionId(executingSessionsRef, setExecutingSessions, id, true);
    if (activeIdRef.current === id) setRunError("");
    try {
      const result = await action(selected);
      if (!result.ok) {
        if (activeIdRef.current === id) setRunError(result.error);
        const accepted = Boolean((result as Result<unknown> & { accepted?: boolean }).accepted);
        return { ok: accepted, accepted, error: result.error, outcomeUnknown: Boolean((result as { outcomeUnknown?: boolean }).outcomeUnknown) };
      }
      return { ok: true };
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      if (activeIdRef.current === id) setRunError(error);
      return { ok: false, error };
    } finally {
      trackSessionId(runRequestSessionsRef, setRunRequestSessions, id, false);
      trackSessionId(executingSessionsRef, setExecutingSessions, id, false);
    }
  }, [runPermission.ensure, sessionCommands]);

  // ZCode in-process approval: a call that waits in the running turn is answered
  // in place (allow / deny) and that turn continues; nothing is re-run. Older
  // sessions with no waiting call still record the grant and run again to replay it.
  const handleApprove = useCallback(
    async (pending: PendingApproval) => {
      const targetSessionId = activeId;
      if (!targetSessionId || !isPluginEffective("sessions")) return false;
      if (!pending.waiting && runRequestSessionsRef.current.has(targetSessionId)) return false;
      let resumed = false;
      if (pending.granted !== true) {
        // Only the replay path holds the workbench busy; a waiting call's card shows its own state.
        if (!pending.waiting) { setBusy(true); setError(""); }
        let res;
        try { res = await approvePending(targetSessionId, pending, sessionCommands); }
        finally { if (!pending.waiting) setBusy(false); }
        if (!res.ok) { setError(res.error); return false; }
        resumed = res.resumed === true;
      }
      if (!resumed && !runRequestSessionsRef.current.has(targetSessionId)) {
        await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, undefined, sessionCommands));
      }
      await loadActive(targetSessionId);
      await refreshList();
      return true;
    },
    [activeId, isPluginEffective, runSessionRequest, loadActive, refreshList, sessionCommands],
  );

  const handleReject = useCallback(
    async (pending: PendingApproval, feedback?: string) => {
      const targetSessionId = activeId;
      if (!targetSessionId || !isPluginEffective("sessions")) return false;
      // ZCode permission-response: the rejection reason goes to the model with the denial.
      const res = await approvePending(targetSessionId, pending, sessionCommands, 'reject', feedback ? { message: feedback } : {});
      if (!res.ok) { setError(res.error); return false; }
      if (!res.resumed) await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, undefined, sessionCommands));
      await loadActive(targetSessionId);
      return true;
    },
    [activeId, isPluginEffective, loadActive, sessionCommands, runSessionRequest],
  );

  const handleAllowProject = useCallback(async (pending: PendingApproval) => {
    if (!activeId || !isPluginEffective("sessions") || !pending.projectRules?.length) return false;
    const result = await approvePending(activeId, pending, sessionCommands, 'approve', { scope: 'project' });
    if (!result.ok) { setError(result.error); return false; }
    if (!result.resumed) await runSessionRequest(activeId, selected => runSession(activeId, selected, undefined, sessionCommands));
    await loadActive(activeId); return true;
  }, [activeId, isPluginEffective, sessionCommands, runSessionRequest, loadActive]);

  const handleApproveAll = useCallback(
    async (items?: PendingApproval[]) => {
      const targetSessionId = activeId;
      if (!targetSessionId || !isPluginEffective("sessions")) return false;
      const list = items ?? session?.pending ?? [];
      if (list.length === 0) return false;
      const ungranted = list.filter(p => !p.granted);
      const live = ungranted.length > 0 && ungranted.every(p => p.waiting);
      if (!live && runRequestSessionsRef.current.has(targetSessionId)) return false;
      if (!live) setBusy(true);
      setError("");
      let allSucceeded = true;
      let allResumed = ungranted.length > 0;
      try {
        for (const p of ungranted) {
          const res = await approvePending(targetSessionId, p, sessionCommands);
          if (!res.ok) {
            setError(res.error);
            allSucceeded = false;
            break;
          }
          if (res.resumed !== true) allResumed = false;
        }
      } finally {
        if (!live) setBusy(false);
      }
      await loadActive(targetSessionId);
      await refreshList();
      if (!allSucceeded) return false;
      if (allResumed || runRequestSessionsRef.current.has(targetSessionId)) return true;
      await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, undefined, sessionCommands));
      await loadActive(targetSessionId);
      await refreshList();
      return true;
    },
    [activeId, isPluginEffective, runSessionRequest, loadActive, refreshList, session?.pending, sessionCommands],
  );

  const handleStop = useCallback(async () => {
    const targetSessionId = activeId;
    if (!targetSessionId || stoppingSessionsRef.current.has(targetSessionId) || !isPluginEffective('sessions')) return;
    trackSessionId(stoppingSessionsRef, setStoppingSessions, targetSessionId, true);
    try {
      const snapshot = sessionSnapshotRef.current;
      const result = await stopSession(targetSessionId,
        snapshot?.id === targetSessionId ? snapshot.active_turn_id ?? null : null, sessionCommands);
      if (!result.ok) throw new Error(result.error);
      if (!result.value.stopping) { trackSessionId(stoppingSessionsRef, setStoppingSessions, targetSessionId, false); await loadActive(targetSessionId, false); }
    }
    catch (reason) {
      if (activeIdRef.current === targetSessionId) setRunError(reason instanceof Error ? reason.message : String(reason));
      trackSessionId(stoppingSessionsRef, setStoppingSessions, targetSessionId, false);
    }
  }, [activeId, loadActive, isPluginEffective, sessionCommands]);

  const handleRetryRun = useCallback(async () => {
    if (!activeId || session?.id !== activeId || busy || runRequestSessionsRef.current.has(activeId)) return;
    const targetSessionId = activeId;
    await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, undefined, sessionCommands));
    await loadActive(targetSessionId);
    await refreshList();
  }, [activeId, session?.id, busy, runSessionRequest, loadActive, refreshList, sessionCommands]);

  const handleRetryTool = useCallback(async (row?: { toolCallId?: string }) => {
    if (!activeId || session?.id !== activeId || busy || runRequestSessionsRef.current.has(activeId) || !isPluginEffective("sessions")) return;
    const targetSessionId = activeId;
    if (row?.toolCallId && session?.pending) {
      const match = session.pending.find(p => p.tool_call_id === row.toolCallId);
      if (match && !match.granted) {
        const granted = await run(() => approvePending(targetSessionId, match, sessionCommands));
        if (!granted) return;
      }
    }
    await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, undefined, sessionCommands));
    await loadActive(targetSessionId);
    await refreshList();
  }, [activeId, session?.id, session?.pending, busy, isPluginEffective, run, runSessionRequest, loadActive, refreshList, sessionCommands]);

  const handleQuestionSubmitted = useCallback(async (targetSessionId: string, continueRun: boolean, isCurrent: () => boolean) => {
    if (!isCurrent() || activeIdRef.current !== targetSessionId || !pluginEffectiveRef.current("sessions")) return;
    await loadActive(targetSessionId);
    await refreshList();
    if (!continueRun || !isCurrent() || activeIdRef.current !== targetSessionId || !pluginEffectiveRef.current("sessions")
      || runRequestSessionsRef.current.has(targetSessionId)) return;
    const continued = await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, undefined, sessionCommands));
    await loadActive(targetSessionId);
    await refreshList();
    if (!continued.ok) throw new Error(continued.error || tr("运行失败，请检查服务器配置与任务状态"));
  }, [loadActive, refreshList, runSessionRequest, sessionCommands]);

  const handleMessageFeedback = useCallback(async (row: Extract<TimelineRow, {kind: 'assistant'}>, feedback: 'like' | 'dislike' | null) => {
    const id = activeIdRef.current;
    if (!id || !pluginEffectiveRef.current('sessions')) throw new Error(tr('会话已关闭'));
    const result = await updateConversationMessage(id, row, {action: 'feedback', feedback});
    await loadActive(id, false);
    if (!result.ok) throw new Error(result.error);
  }, [loadActive]);

  const handleMessageEdit = useCallback(async (row: Extract<TimelineRow, {kind: 'user'}>, text: string, onAccepted: () => void, attachments?: { preparedToken: string }) => {
    const id = activeIdRef.current;
    if (!id || !pluginEffectiveRef.current('sessions')) return false;
    let accepted = false;
    const result = await runSessionRequest(id, async selected => {
      const updated = await updateConversationMessage(id, row, {action: 'edit', text, ...(attachments ? { prepared_token: attachments.preparedToken } : {})}, sessionCommands);
      if (!updated.ok) return updated;
      accepted = true; onAccepted();
      await loadActive(id, false);
      if (!sessionCommands.isEffective()) return { ok: false, error: 'Session commands are no longer enabled', accepted: true };
      const started = await runSession(id, selected, undefined, sessionCommands);
      return started.ok ? started : {...started, accepted: true};
    });
    await loadActive(id, false); await refreshList();
    if (!result.ok && result.error) throw new Error(result.error);
    return result.ok || accepted;
  }, [runSessionRequest, loadActive, refreshList, sessionCommands]);

  return {
    runPermission, runSessionRequest, handleApprove, handleReject, handleAllowProject, handleApproveAll,
    handleStop, handleRetryRun, handleRetryTool, handleQuestionSubmitted, handleMessageFeedback, handleMessageEdit,
  };
}

export type SessionRunActions = ReturnType<typeof useSessionRunActions>;
