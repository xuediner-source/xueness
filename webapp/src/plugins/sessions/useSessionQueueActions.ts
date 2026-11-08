/**
 * Queue and guidance actions on the active session: cancel, withdraw (with
 * restore into the composer), send now, continue a paused queue, edit and
 * reorder. Moved unchanged out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback } from "react";
import { t as tr } from "../../i18n";
import { getRunChoices, setRunChoices, type RunChoices } from "../../xuenessBridge";
import { cancelQueuedTurn, loadSession, runSession, type QueuedMessage } from "../../xuenessWorkbench";
import { useQueueWithdrawals } from './useQueueWithdrawals';
import { editQueuedMessage, reorderQueuedMessages, type QueueWithdrawal } from "./queueApi";
import { reserveQueuedMessageNow, withdrawGuidance } from './steeringApi';
import { canAdmitSessionMutation } from './CommandReceiptRecovery';
import { trackSessionId, type SessionActivity } from "./workbenchSessionState";
import type { WorkbenchSessionData } from "./useWorkbenchSessionData";
import type { SessionRunActions } from "./useSessionRunActions";

type SessionQueueActionsInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  activity: SessionActivity;
  data: WorkbenchSessionData;
  runActions: SessionRunActions;
  commandRoot: string;
  setChoices: (choices: RunChoices) => void;
  moveTextIntoComposer: (targetSessionId: string, text: string, hasContext?: boolean, workspaceKey?: string) => void;
};

export function useSessionQueueActions({ activeId, activeIdRef, isPluginEffective, pluginEffectiveRef, activity, data, runActions, commandRoot, setChoices, moveTextIntoComposer }: SessionQueueActionsInput) {
  const { queueCancelling, setQueueCancelling, setQueueError, queueContinuingSessionsRef, setQueueContinuingSessions,
    runRequestSessionsRef, setRunRequestSessions, executingSessionsRef, setExecutingSessions } = activity;
  const { mountedRef, session, sessionSnapshotRef, sessionCommands, loadActive, refreshList } = data;
  const { runPermission, runSessionRequest } = runActions;

  const handleCancelQueuedTurn = useCallback(async (queueId: string, expectedText: string, expectedRevision: number) => {
    const targetSessionId = activeId;
    if (!targetSessionId || !isPluginEffective("sessions") || queueCancelling?.sessionId === targetSessionId) return;
    setQueueCancelling({ sessionId: targetSessionId, queueId });
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    const result = await cancelQueuedTurn(targetSessionId, queueId, expectedText, sessionCommands, expectedRevision);
    // Reload even on 409: the queue item may already have been claimed, and the
    // timeline detail is the authoritative state shown after that race.
    await loadActive(targetSessionId, false);
    if (!result.ok && activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message: result.error });
    await refreshList();
    setQueueCancelling(current => current?.sessionId === targetSessionId && current.queueId === queueId ? null : current);
  }, [activeId, queueCancelling, loadActive, refreshList, isPluginEffective, sessionCommands]);

  const restoreWithdrawal = useCallback((withdrawal: QueueWithdrawal) => {
    moveTextIntoComposer(withdrawal.sessionId, withdrawal.text, withdrawal.hasContext, withdrawal.root || 'default');
  }, [moveTextIntoComposer]);
  const queueWithdrawals = useQueueWithdrawals({ sessionId: session?.id === activeId ? activeId : null,
    root: commandRoot, enabled: isPluginEffective('sessions'), revision: session?.queue_revision,
    commands: sessionCommands, onRestore: restoreWithdrawal });
  const handleWithdrawQueuedTurn = useCallback(async (item: QueuedMessage, expectedRevision: number) => {
    await queueWithdrawals.withdraw(item.id, item.text, expectedRevision);
    if (isPluginEffective('sessions') && activeId && activeIdRef.current === activeId) {
      await loadActive(activeId, false);
      await refreshList();
    }
  }, [queueWithdrawals.withdraw, activeId, isPluginEffective, loadActive, refreshList]);

  const handleWithdrawGuidance = useCallback(async (inputId: string) => {
    const targetSessionId = activeId;
    const item = sessionSnapshotRef.current?.pending_guidance?.find(row => row.id === inputId);
    if (!targetSessionId || !item || queueCancelling?.sessionId === targetSessionId) return;
    moveTextIntoComposer(targetSessionId, item.text, item.has_context === true || item.has_attachments === true);
    setQueueCancelling({ sessionId: targetSessionId, queueId: inputId });
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      await withdrawGuidance(targetSessionId, inputId);
      await loadActive(targetSessionId, false);
      await refreshList();
    } catch (reason) {
      if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId,
        message: reason instanceof Error ? reason.message : String(reason) });
      await loadActive(targetSessionId, false);
    } finally {
      setQueueCancelling(current => current?.sessionId === targetSessionId && current.queueId === inputId ? null : current);
    }
  }, [activeId, queueCancelling, moveTextIntoComposer, loadActive, refreshList]);

  const handleSendNowQueuedTurn = useCallback(async (queueId: string, expectedRevision: number) => {
    const targetSessionId = activeId;
    const snapshot = sessionSnapshotRef.current;
    const turnId = snapshot?.id === targetSessionId ? snapshot.active_turn_id : undefined;
    if (!targetSessionId || !turnId || !snapshot || snapshot.id !== targetSessionId
      || !isPluginEffective('sessions') || queueContinuingSessionsRef.current.has(targetSessionId)) return;
    queueContinuingSessionsRef.current.add(targetSessionId);
    setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      // Confirm the settings for the new human turn before requesting a stop.
      const selected = await runPermission.ensure(getRunChoices(), snapshot.permission_mode);
      if (!selected || activeIdRef.current !== targetSessionId || !pluginEffectiveRef.current('sessions')) return;
      setRunChoices(selected);
      setChoices(selected);
      const reservation = await reserveQueuedMessageNow(targetSessionId, queueId, turnId, expectedRevision, () => canAdmitSessionMutation(sessionCommands, targetSessionId, () => pluginEffectiveRef.current('sessions')));
      if (!reservation.ok) throw new Error(reservation.error);
      await loadActive(targetSessionId, false);

      const deadline = Date.now() + 180_000;
      let idle = false;
      while (Date.now() < deadline) {
        if (!mountedRef.current || activeIdRef.current !== targetSessionId) return;
        if (!sessionCommands.isEffective()) throw new Error('Session commands are no longer enabled');
        const latest = await loadSession(targetSessionId);
        if (!latest.ok) throw new Error(latest.error);
        if (latest.value.status !== 'running' && !latest.value.active_turn_id
          && latest.value.streaming?.status !== 'streaming') {
          idle = true;
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
      if (!mountedRef.current || activeIdRef.current !== targetSessionId) return;
      if (!idle) throw new Error(tr('正在等待当前轮停止。保留的立即发送消息可在队列中查看。'));

      // A completed core turn can be visible before the route releases its
      // lease. Retry only that boundary conflict; the durable receipt makes
      // each retry refer to the same reserved user message.
      let started = false;
      let lastError = '';
      trackSessionId(runRequestSessionsRef, setRunRequestSessions, targetSessionId, true);
      trackSessionId(executingSessionsRef, setExecutingSessions, targetSessionId, true);
      for (let attempt = 0; attempt < 12 && !started; attempt++) {
        if (!mountedRef.current || activeIdRef.current !== targetSessionId) return;
        if (!sessionCommands.isEffective()) throw new Error('Session commands are no longer enabled');
        const result = await runSession(targetSessionId, selected,
          { continueQueue: true, promotionRequestId: reservation.value.request_id }, sessionCommands);
        if (result.ok) { started = true; break; }
        lastError = result.error;
        if (!sessionCommands.isEffective()) throw new Error('Session commands are no longer enabled');
        const latest = await loadSession(targetSessionId);
        if (latest.ok && (latest.value.current_queue_item_id === queueId
          || latest.value.queued_messages?.some(item => item.id === queueId
            && ['claimed', 'settled'].includes(item.promotion?.state ?? '')))) { started = true; break; }
        if (!/already in progress|in use by another process/iu.test(result.error)) break;
        await new Promise(resolve => window.setTimeout(resolve, 300));
      }
      if (!started) throw new Error(lastError || tr('立即发送未能启动，请刷新队列后重试。'));
      await loadActive(targetSessionId, false);
      await refreshList();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message });
    } finally {
      trackSessionId(runRequestSessionsRef, setRunRequestSessions, targetSessionId, false);
      trackSessionId(executingSessionsRef, setExecutingSessions, targetSessionId, false);
      queueContinuingSessionsRef.current.delete(targetSessionId);
      if (mountedRef.current) {
        setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
        if (activeIdRef.current === targetSessionId) await loadActive(targetSessionId, false);
      }
    }
  }, [activeId, isPluginEffective, runPermission.ensure, loadActive, refreshList, sessionCommands]);

  const handleContinueQueuedMessages = useCallback(async () => {
    const targetSessionId = activeId;
    if (!targetSessionId || session?.id !== targetSessionId || session.status === "running" || session.streaming?.status === "streaming"
      || !(session.queued_messages ?? []).some(item => item.status === "paused")
      || !isPluginEffective("sessions") || queueContinuingSessionsRef.current.has(targetSessionId)) return;
    queueContinuingSessionsRef.current.add(targetSessionId);
    setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      const continued = await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, { continueQueue: true }, sessionCommands));
      if (!continued.ok) {
        if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message: continued.error ?? tr("运行失败，请检查服务器配置与任务状态") });
      } else {
        await refreshList();
      }
      await loadActive(targetSessionId, false);
    } finally {
      queueContinuingSessionsRef.current.delete(targetSessionId);
      setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
    }
  }, [activeId, session, isPluginEffective, runSessionRequest, refreshList, loadActive, sessionCommands]);

  const handleEditQueuedMessage = useCallback(async (queueId: string, text: string, expectedText: string, expectedRevision: number) => {
    const target = activeId;
    if (!target || !isPluginEffective("sessions")) throw new Error(tr("会话不可用"));
    try { await editQueuedMessage(target, queueId, text, expectedText, sessionCommands, expectedRevision); }
    finally { await loadActive(target, false); }
  }, [activeId, isPluginEffective, loadActive, sessionCommands]);

  const handleReorderQueuedMessages = useCallback(async (ids: string[], expectedIds: string[], expectedRevision: number) => {
    const target = activeId;
    if (!target || !isPluginEffective('sessions')) throw new Error(tr('会话不可用'));
    try { await reorderQueuedMessages(target, ids, expectedIds, sessionCommands, expectedRevision); }
    finally { await loadActive(target, false); }
  }, [activeId, isPluginEffective, loadActive, sessionCommands]);

  return {
    queueWithdrawals, handleCancelQueuedTurn, handleWithdrawQueuedTurn, handleWithdrawGuidance, handleSendNowQueuedTurn,
    handleContinueQueuedMessages, handleEditQueuedMessage, handleReorderQueuedMessages,
  };
}

export type SessionQueueActions = ReturnType<typeof useSessionQueueActions>;
