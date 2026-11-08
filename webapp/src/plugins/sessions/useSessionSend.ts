/**
 * Composer submissions for the primary pane: a follow-up in the active
 * session (send, guide the current turn, queue, start now, or `/compact`) and
 * the hero composer's create-and-run. Moved unchanged out of
 * XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback } from "react";
import { t as tr } from "../../i18n";
import { getRunChoices, setRunChoices, type RunChoices } from "../../xuenessBridge";
import { prepareComposer, type ComposerInput } from "../../xuenessComposer";
import { createSession, queueTurn, sendTurn } from "../../xuenessWorkbench";
import { openContextCommand } from "../context_lens/commands";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import { DeliveryUnconfirmedError } from './submissionTransport';
import { guideCurrentTurn, reserveQueuedMessageNow } from './steeringApi';
import type { InputDelivery } from './CurrentTurnInput';
import { canAdmitSessionMutation, canAdmitSessionFollowup, sessionFollowupProof } from './CommandReceiptRecovery';
import { manualCompactNotice, parseCompactCommand, requestManualCompact } from './manualCompact';
import { trackSessionId, type SessionActivity } from "./workbenchSessionState";
import type { WorkbenchSessionData } from "./useWorkbenchSessionData";
import type { SessionRunActions } from "./useSessionRunActions";

type SessionSendInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  setActiveId: (id: string | null) => void;
  setPanel: (panel: WorkbenchPanel) => void;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  activity: SessionActivity;
  data: WorkbenchSessionData;
  runActions: SessionRunActions;
  draftRoot: string | undefined;
  catalogRoot: string | null;
  isolatedWorkspace: boolean;
  setChoices: (choices: RunChoices) => void;
  loadedSessionChoices: React.MutableRefObject<string | null>;
  /** Lets a split pane adopt the session the hero composer just created. */
  paneCreationRef: React.MutableRefObject<((sessionId: string) => void) | null>;
};

export function useSessionSend({ activeId, activeIdRef, setActiveId, setPanel, isPluginEffective, pluginEffectiveRef, activity, data, runActions, draftRoot, catalogRoot, isolatedWorkspace, setChoices, loadedSessionChoices, paneCreationRef }: SessionSendInput) {
  const { busy, setBusy, run, setRunError, setQueueError, runRequestSessions, runRequestSessionsRef, setRunRequestSessions, executingSessionsRef, setExecutingSessions,
    queueSubmittingSessionsRef, setQueueSubmittingSessions, activeCreateRef, createGenerationRef, setCreatingSession } = activity;
  const { mountedRef, session, sessionSnapshotRef, sessionCommands, loadActive, refreshList } = data;
  const { runPermission, runSessionRequest } = runActions;

  const handleSend = useCallback(
    async (text: string, input?: ComposerInput, onAccepted?: () => void, delivery?: InputDelivery) => {
      if (openContextCommand(text, isPluginEffective("context_lens"), () => setPanel("context-lens"))) { onAccepted?.(); return; }
      const targetSessionId = activeId;
      const running = Boolean(targetSessionId && session?.id === targetSessionId && (
        session.status === "running" || session.streaming?.status === "streaming" || runRequestSessions.has(targetSessionId)
      ));
      if (!targetSessionId || session?.id !== targetSessionId || (busy && !running) || !isPluginEffective("sessions")) return false;
      // ZCode `/compact [instructions]`: compacts through the sessions route instead of starting a run.
      const compactCommand = parseCompactCommand(text, input);
      if (compactCommand) {
        if (running) throw new Error(tr('请先停止运行，再压缩上下文。'));
        if (sessionCommands.recoveryStorageError() || sessionCommands.pendingCommands().some(row => row.sessionId === targetSessionId)) {
          throw new Error(sessionCommands.recoveryStorageError() || tr('命令结果仍未确认，请勿重复提交。'));
        }
        setBusy(true);
        setQueueError({ sessionId: targetSessionId, message: tr('正在压缩上下文 · 可能需要几分钟'), compact: 'running' });
        try {
          const outcome = await requestManualCompact(targetSessionId, compactCommand.instructions);
          if (outcome.kind === 'failed') throw new Error(manualCompactNotice(outcome));
          onAccepted?.();
          await loadActive(targetSessionId, false);
          await refreshList();
          if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message: outcome.kind === 'compacted' ? tr('上下文已压缩') : manualCompactNotice(outcome), compact: 'complete' });
          return true;
        } catch (error) {
          setQueueError(previous => previous?.sessionId === targetSessionId && previous.compact === 'running' ? null : previous);
          throw error;
        } finally {
          setBusy(false);
        }
      }
      const proof = sessionFollowupProof(session);
      const observedTurn = session.active_turn_id;
      const followupCurrent = () => {
        const latest = sessionSnapshotRef.current;
        return mountedRef.current && activeIdRef.current === targetSessionId && pluginEffectiveRef.current('sessions')
          && latest?.id === targetSessionId && latest.root === session.root && latest.status === 'running'
          && !!observedTurn && latest.active_turn_id === observedTurn
          && (!proof || latest.active_run_command_id === proof.runCommandId);
      };
      if (sessionCommands.recoveryStorageError() || (running
        ? !canAdmitSessionFollowup(sessionCommands,targetSessionId,proof,followupCurrent)
        : sessionCommands.pendingCommands().some(row=>row.sessionId===targetSessionId))) {
        throw new Error(sessionCommands.recoveryStorageError() || tr('命令结果仍未确认，请勿重复提交。'));
      }
      const value = text.trim() || tr("附件与上下文");
      if (running) {
        const selectedDelivery = delivery ?? 'guide';
        if (queueSubmittingSessionsRef.current.has(targetSessionId)) return false;
        queueSubmittingSessionsRef.current.add(targetSessionId);
        setQueueSubmittingSessions(new Set(queueSubmittingSessionsRef.current));
        setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
        try {
          const selected = getRunChoices();
      if (input?.capabilities?.includes("browser.composer_operation") && isPluginEffective("browser")) selected.browser = true;
          const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, {
            session_id: targetSessionId,
            provider_id: selected.provider_id,
            model: selected.model,
            reasoning_effort: selected.reasoning_effort,
          });
          if (!canAdmitSessionFollowup(sessionCommands,targetSessionId,proof,followupCurrent)) throw new Error('The observed follow-up turn is no longer current');
          if (selectedDelivery === 'guide' && session?.active_turn_id) {
            const guided = await guideCurrentTurn(targetSessionId, session.active_turn_id, value, prepared.token,
              () => canAdmitSessionFollowup(sessionCommands,targetSessionId,proof,followupCurrent));
            if (!guided.ok) {
              await loadActive(targetSessionId, false);
              throw guided.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(guided.error);
            }
            onAccepted?.();
            await loadActive(targetSessionId, false);
            await refreshList();
            return true;
          }
          const queued = await queueTurn(targetSessionId, value, prepared.token, sessionCommands,
            proof ? {proof,current:followupCurrent} : undefined);
          if (!queued.ok) {
            await loadActive(targetSessionId, false);
            throw queued.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(queued.error);
          }
          onAccepted?.();
          if (selectedDelivery === 'startNow' && sessionCommands.isEffective()) {
            const turnId = session?.active_turn_id;
            if (!turnId) {
              setQueueError({ sessionId: targetSessionId, message: tr('无法立即发送：当前轮次已结束。消息已保留在队列中。') });
            } else {
              const reserved = await reserveQueuedMessageNow(targetSessionId, queued.value.id, turnId, undefined, () => canAdmitSessionMutation(sessionCommands, targetSessionId, () => pluginEffectiveRef.current('sessions')));
              if (!reserved.ok) {
                setQueueError({ sessionId: targetSessionId, message: reserved.error });
              } else {
                setQueueError({ sessionId: targetSessionId, message: tr('消息已排到最前，并将在当前轮停止后启动。') });
              }
            }
          }
          await loadActive(targetSessionId, false);
          await refreshList();
          return true;
        } finally {
          queueSubmittingSessionsRef.current.delete(targetSessionId);
          setQueueSubmittingSessions(new Set(queueSubmittingSessionsRef.current));
        }
      }
      if (busy) return false;
      const selected = getRunChoices();
      if (input?.capabilities?.includes("browser.composer_operation") && isPluginEffective("browser")) selected.browser = true;
      let accepted = false;
      const requestResult = await runSessionRequest(targetSessionId, async confirmed => {
        const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, { session_id: targetSessionId, provider_id: selected.provider_id, model: selected.model, reasoning_effort: selected.reasoning_effort });
        if (!sessionCommands.isEffective()) throw new Error('Session commands are no longer enabled');
        return sendTurn(targetSessionId, value, { ...confirmed, goal: prepared.goal }, prepared.token, () => { accepted = true; onAccepted?.(); }, sessionCommands);
      }, selected);
      if (requestResult.ok) {
        await loadActive(targetSessionId);
        await refreshList();
      }
      if (!requestResult.ok && !accepted && requestResult.error) {
        await loadActive(targetSessionId, false);
        throw requestResult.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(requestResult.error);
      }
      return requestResult.ok || accepted;
    },
    [activeId, session, busy, runRequestSessions, isPluginEffective, run, runSessionRequest, loadActive, refreshList, sessionCommands],
  );

  /** Hero composer: create the task and run it in one round trip pair. */
  const handleCreate = useCallback(
    async (text: string, input?: ComposerInput, onAccepted?: () => void) => {
      const value = text.trim() || tr("附件与上下文");
      if (!isPluginEffective("sessions")) return false;
      if (sessionCommands.recoveryStorageError() || sessionCommands.pendingCommands().some(row => row.sessionId === null)) {
        throw new Error(sessionCommands.recoveryStorageError() || tr('命令结果仍未确认，请勿重复提交。'));
      }
      if (activeCreateRef.current !== null) return false;
      const createTicket = ++createGenerationRef.current;
      activeCreateRef.current = createTicket;
      setCreatingSession(true);
      const releaseCreateLock = () => {
        if (activeCreateRef.current !== createTicket) return;
        activeCreateRef.current = null;
        setCreatingSession(false);
      };
      let createdId = "";
      const originSessionId = activeIdRef.current;
      const promoteCreatedPane = paneCreationRef.current;
      const selected = getRunChoices();
      if (input?.capabilities?.includes("browser.composer_operation") && isPluginEffective("browser")) selected.browser = true;
      try {
        const confirmed = await runPermission.ensure(selected);
        if (!confirmed || activeIdRef.current !== originSessionId || !pluginEffectiveRef.current('sessions')) return false;
        Object.assign(selected, confirmed);
        setRunChoices(confirmed);
        setChoices(confirmed);
        const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, { root: draftRoot ?? catalogRoot ?? undefined, provider_id: selected.provider_id, model: selected.model, reasoning_effort: selected.reasoning_effort });
        if (!sessionCommands.isEffective()) throw new Error('Session commands are no longer enabled');
        const result = await createSession(value, { ...selected, goal: prepared.goal }, { ...(isolatedWorkspace ? {} : { root: prepared.root }), prepared_token: prepared.token }, id => {
          createdId = id;
          promoteCreatedPane?.(id);
          onAccepted?.();
          releaseCreateLock();
          trackSessionId(runRequestSessionsRef, setRunRequestSessions, id, true);
          trackSessionId(executingSessionsRef, setExecutingSessions, id, true);
          loadedSessionChoices.current = id;
          if (activeIdRef.current === originSessionId) {
            setRunError("");
            setActiveId(id);
          }
        }, sessionCommands);
        if (result.ok) createdId = result.value;
        else if (result.accepted && result.id) createdId = result.id;
        const createError = result.ok ? "" : result.error;
        if (createdId) {
          await refreshList();
          await loadActive(createdId);
          if (createError && activeIdRef.current === createdId) setRunError(createError);
          return true;
        }
        if (createError && activeIdRef.current === originSessionId) setRunError(createError);
        if (!result.ok && result.outcomeUnknown) { await refreshList(); throw new DeliveryUnconfirmedError(); }
        if (createError) throw new Error(createError);
        return false;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (activeIdRef.current === createdId && createdId) setRunError(message);
        else if (activeIdRef.current === originSessionId) setRunError(message);
        if (!createdId) throw reason;
        return true;
      } finally {
        releaseCreateLock();
        if (createdId) {
          trackSessionId(runRequestSessionsRef, setRunRequestSessions, createdId, false);
          trackSessionId(executingSessionsRef, setExecutingSessions, createdId, false);
        }
      }
    },
    [isPluginEffective, refreshList, loadActive, draftRoot, catalogRoot, isolatedWorkspace, runPermission.ensure, sessionCommands],
  );

  return { handleSend, handleCreate };
}
