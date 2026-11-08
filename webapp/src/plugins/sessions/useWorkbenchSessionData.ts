/**
 * Session data for the primary workbench pane: the sidebar session list and
 * the active conversation (detail, timeline window, older pages), kept fresh
 * by the conversation transport, live updates or polling, in that order of
 * preference. Responses for a session that is no longer active are dropped.
 * Moved unchanged out of XuenessWorkbenchContainer; effects keep their order.
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t as tr } from "../../i18n";
import type { XuenessPlugin } from "../../xuenessApi";
import { createSessionCommandClient, loadConversationSnapshot, loadOlderConversationPage, mergeTimelineRowsByIdentity, parseConversationSnapshot, stabilizeSession, stabilizeSessionList, stabilizeTimelineRows, withAssistantStream, type SessionSummary, type TimelineRow, type WorkbenchSession } from "../../xuenessWorkbench";
import { receiptGuardedQuestionTransport } from './CommandReceiptRecovery';
import { loadSidebarSessions } from "./sessionsIndex";
import { useConversationUpdates } from './LiveConversation';
import { useConversationTransport } from './conversationTransport';
import { createSingleFlightRefresh, useSessionPolling } from "./SessionPolling";
import { buildConversationFindMatches } from './ConversationFind';
import { conversationCompactionBoundary } from './conversationCompaction';
import { projectSnapshotTimelineRows } from './paneConversation';
import { paneSubscriptionIdentity } from './paneLayout';
import { shouldIgnoreSessionResponse, trackSessionId, type SessionActivity } from "./workbenchSessionState";

type WorkbenchSessionDataInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  setActiveId: (id: string | null) => void;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  pluginCatalogReady: boolean;
  pluginCatalog: XuenessPlugin[];
  activity: SessionActivity;
  /** Refreshes the files plugin's candidates after an active-session load. */
  loadFileCandidates: (id: string) => Promise<void>;
};

export function useWorkbenchSessionData({ activeId, activeIdRef, setActiveId, isPluginEffective, pluginEffectiveRef, pluginCatalogReady, pluginCatalog, activity, loadFileCandidates }: WorkbenchSessionDataInput) {
  const { busy, stoppingSessions, stoppingSessionsRef, setStoppingSessions, runRequestSessions, executingSessions, setQueueError, setQueueCancelling, setRunError } = activity;
  const mountedRef = useRef(true);
  const sessionCommands = useMemo(() => createSessionCommandClient(
    () => mountedRef.current && pluginEffectiveRef.current('sessions'),
  ), []);
  const primaryQuestionTransport = useMemo(() => receiptGuardedQuestionTransport(sessionCommands,
    () => mountedRef.current && pluginEffectiveRef.current('sessions')), [sessionCommands]);
  useEffect(() => {
    if (!isPluginEffective('sessions')) sessionCommands.cancelPending();
  }, [isPluginEffective, sessionCommands]);
  const activeAbortRef = useRef<AbortController | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionCommands.cancelPending();
      activeAbortRef.current?.abort();
      listAbortRef.current?.abort();
    };
  }, [sessionCommands]);

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionsListRef = useRef(sessions);
  sessionsListRef.current = sessions;
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const sessionSnapshotRef = useRef(session);
  sessionSnapshotRef.current = session;
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [conversationFindRequest, setConversationFindRequest] = useState<{sessionId: string; id: string; query: string} | null>(null);
  const [olderTranscript, setOlderTranscript] = useState<{sessionId: string; hasOlder: boolean; loading: boolean; error: string}>({
    sessionId: '', hasOlder: false, loading: false, error: '',
  });
  const olderRowsRef = useRef<{sessionId: string; rows: TimelineRow[]; before: number} | null>(null);
  const transcriptWindowRef = useRef<{sessionId: string; start: number; total: number; revision: string} | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  const [dataErrors, setDataErrors] = useState({ list: "", active: "" });

  const refreshListSnapshot = useCallback(async () => {
    if (!pluginEffectiveRef.current("sessions")) {
      setSessions([]);
      return;
    }
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const res = await loadSidebarSessions(sessionsListRef.current, controller.signal);
    if (!mountedRef.current || !pluginEffectiveRef.current("sessions") || controller.signal.aborted) return;
    if (res.ok) {
      setSessions(prev => stabilizeSessionList(prev, res.value));
      if (stoppingSessionsRef.current.size > 0) {
        const runningIds = new Set(res.value.filter(s => s.status === "running").map(s => s.id));
        for (const id of Array.from(stoppingSessionsRef.current)) {
          if (!runningIds.has(id)) {
            trackSessionId(stoppingSessionsRef, setStoppingSessions, id, false);
          }
        }
      }
    }
    setDataErrors(previous => {
      const nextList = res.ok ? "" : res.error;
      return previous.list === nextList ? previous : { ...previous, list: nextList };
    });
  }, [isPluginEffective]);
  const listLoaderRef = useRef(refreshListSnapshot);
  listLoaderRef.current = refreshListSnapshot;
  const refreshList = useMemo(() => createSingleFlightRefresh(() => listLoaderRef.current()), []);

  const acceptedSnapshotRevision = useRef<{id: string; revision: number} | null>(null);
  const transportRef = useRef<{sessionId: string | null; authoritativeRef: {current: boolean};
    epochRef: {current: string | null}; refresh: () => Promise<void>} | null>(null);
  const transportSnapshotRef = useRef<{id: string; epoch: string | null; value: unknown} | null>(null);
  const loadActiveSnapshot = useCallback(async (id: string, pushedSnapshot?: unknown, source: 'legacy' | 'transport' = 'legacy') => {
    if (!pluginEffectiveRef.current("sessions") || id !== activeIdRef.current) return;
    if (source === 'legacy' && transportRef.current?.sessionId === id && transportRef.current.authoritativeRef.current) return;
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    // Detail carries pending/approved/changed_files; the timeline carries the
    // real tool_call/tool_result sequence. Both come from the server; neither is
    // reconstructed client-side.
    const snapshot = pushedSnapshot === undefined ? await loadConversationSnapshot(id, controller.signal, {tail: 80})
      : {ok: true as const, value: parseConversationSnapshot(id, pushedSnapshot)};
    const detail = snapshot.ok ? {ok: true as const, value: snapshot.value.session} : snapshot;
    const timeline = snapshot.ok ? {ok: true as const, value: snapshot.value.timeline} : snapshot;
    const journal = snapshot.ok ? {ok: true as const, value: snapshot.value.journal} : snapshot;
    if (shouldIgnoreSessionResponse(id, activeIdRef.current, mountedRef.current, controller.signal) || !pluginEffectiveRef.current("sessions")) return;
    if (source === 'legacy' && transportRef.current?.sessionId === id && transportRef.current.authoritativeRef.current) return;
    if (snapshot.ok) {
      const revision = snapshot.value.window?.historyRevision ?? snapshot.value.journal.history_revision;
      if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
        const accepted = acceptedSnapshotRevision.current;
        if (source === 'legacy' && accepted?.id === id && accepted.revision > revision) return;
        acceptedSnapshotRevision.current = {id, revision};
      }
      const window = snapshot.value.window;
      if (window) {
        if (olderRowsRef.current?.sessionId !== id) {
          olderAbortRef.current?.abort();
          olderRowsRef.current = {sessionId: id, rows: [], before: window.start};
        }
        transcriptWindowRef.current = {sessionId: id, start: window.start, total: window.total,
          revision: window.messageRevision};
      } else {
        olderRowsRef.current = {sessionId: id, rows: [], before: 0};
        transcriptWindowRef.current = null;
      }
    }
    if (detail.ok) {
      setSession(prev => stabilizeSession(prev, detail.value));
      if (detail.value.status !== "running" && detail.value.streaming?.status !== "streaming") {
        trackSessionId(stoppingSessionsRef, setStoppingSessions, id, false);
      }
    }
    if (snapshot.ok && timeline.ok) {
      const nextRows = projectSnapshotTimelineRows(snapshot.value, pluginEffectiveRef.current('files'));
      const prefix = olderRowsRef.current?.sessionId === id ? olderRowsRef.current : null;
      const mergedRows = mergeTimelineRowsByIdentity(prefix?.rows ?? [], nextRows);
      setRows(prevRows => stabilizeTimelineRows(prevRows, mergedRows));
      const hasOlder = prefix ? prefix.before > 0 : Boolean(snapshot.value.window?.hasOlder);
      setOlderTranscript(previous => ({sessionId: id, hasOlder,
        loading: previous.sessionId === id && previous.loading, error: previous.sessionId === id ? previous.error : ''}));
    }
    setDataErrors(previous => {
      const nextActive = !detail.ok ? detail.error : !timeline.ok ? timeline.error : "";
      return previous.active === nextActive ? previous : { ...previous, active: nextActive };
    });
  }, [isPluginEffective]);
  const loadOlderTranscript = useCallback(async () => {
    const id = activeIdRef.current;
    const latest = transcriptWindowRef.current;
    if (!id || !latest || latest.sessionId !== id || !isPluginEffective('sessions')) return;
    const prefix = olderRowsRef.current?.sessionId === id ? olderRowsRef.current : null;
    const before = prefix ? prefix.before : latest.start;
    if (before <= 0 || olderTranscript.loading) return;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setOlderTranscript(previous => ({sessionId: id, hasOlder: true, loading: true, error: ''}));
    const result = await loadOlderConversationPage(id, before, latest.revision, controller.signal);
    if (controller.signal.aborted || activeIdRef.current !== id || !mountedRef.current) return;
    if (!result.ok || !result.value.window) {
      setOlderTranscript(previous => ({sessionId: id, hasOlder: true, loading: false,
        error: result.ok ? tr('无法读取更早的会话记录，请刷新后重试。') : result.error}));
      return;
    }
    const current = transcriptWindowRef.current;
    if (current?.sessionId !== id || current.revision !== result.value.window.messageRevision) {
      setOlderTranscript(previous => ({sessionId: id, hasOlder: true, loading: false,
        error: tr('会话内容已变化，请重试加载。')}));
      return;
    }
    const pageRows = projectSnapshotTimelineRows(result.value, pluginEffectiveRef.current('files'));
    const nextPrefix = mergeTimelineRowsByIdentity(pageRows, prefix?.rows ?? []);
    olderRowsRef.current = {sessionId: id, rows: nextPrefix, before: result.value.window.start};
    setRows(previous => stabilizeTimelineRows(previous,
      mergeTimelineRowsByIdentity(nextPrefix, previous)));
    setOlderTranscript({sessionId: id, hasOlder: result.value.window.hasOlder,
      loading: false, error: ''});
  }, [isPluginEffective, olderTranscript.loading]);
  const activeLoaderRef = useRef(loadActiveSnapshot);
  activeLoaderRef.current = loadActiveSnapshot;
  const fileCandidatesRef = useRef(loadFileCandidates);
  fileCandidatesRef.current = loadFileCandidates;
  const loadActive = useMemo(() => {
    const refresh = createSingleFlightRefresh(async (id: string, includeFiles?: boolean) => {
      const transport = transportRef.current;
      if (transport?.sessionId === id && transport.authoritativeRef.current) {
        await transport.refresh();
        const latest = transportSnapshotRef.current;
        if (transport.authoritativeRef.current && latest?.id === id) {
          await activeLoaderRef.current(id, latest.value, 'transport');
        } else {
          await activeLoaderRef.current(id);
        }
      } else {
        await activeLoaderRef.current(id);
      }
      if (includeFiles !== false && id === activeIdRef.current && pluginEffectiveRef.current('sessions') && pluginEffectiveRef.current('files')) {
        await fileCandidatesRef.current(id);
      }
    });
    return (id: string, includeFiles?: boolean) => id === activeIdRef.current ? refresh(id, includeFiles) : Promise.resolve();
  }, []);

  const pollActiveSession = useCallback(() => activeId ? loadActive(activeId, false) : Promise.resolve(), [activeId, loadActive]);
  useEffect(() => {
    if (conversationFindRequest?.sessionId !== activeId || session?.id !== activeId
        || !conversationFindRequest.query || olderTranscript.sessionId !== activeId
        || !olderTranscript.hasOlder || olderTranscript.loading || olderTranscript.error
        || buildConversationFindMatches(rows, conversationFindRequest.query).length) return;
    void loadOlderTranscript();
  }, [conversationFindRequest, activeId, session?.id, olderTranscript, rows, loadOlderTranscript]);
  const activeSessionNeedsPolling = Boolean(activeId && (
    busy || stoppingSessions.has(activeId) || runRequestSessions.has(activeId)
    || session?.status === "running" || session?.streaming?.status === "streaming"
  ));
  const acceptPushedSnapshot = useCallback((value: unknown) => {
    const id = activeIdRef.current;
    if (id && !transportRef.current?.authoritativeRef.current) {
      parseConversationSnapshot(id, value);
      void activeLoaderRef.current(id, value).catch(() => {
        if (activeIdRef.current === id) setDataErrors(previous => ({...previous, active: tr('会话更新失败，请刷新后重试。')}));
      });
    }
  }, []);
  const acceptTransportSnapshot = useCallback((value: unknown) => {
    const id = activeIdRef.current;
    if (!id || !pluginEffectiveRef.current('sessions')) return;
    parseConversationSnapshot(id, value);
    const epoch = transportRef.current?.epochRef.current ?? null;
    const previous = transportSnapshotRef.current;
    if (previous?.id !== id || previous.epoch !== epoch) {
      olderAbortRef.current?.abort();
      olderRowsRef.current = null;
      transcriptWindowRef.current = null;
      acceptedSnapshotRevision.current = null;
    }
    transportSnapshotRef.current = {id, epoch, value};
    void activeLoaderRef.current(id, value, 'transport').catch(() => {
      if (activeIdRef.current === id) setDataErrors(previous => ({...previous, active: tr('会话更新失败，请刷新后重试。')}));
    });
  }, []);
  const conversationTransport = useConversationTransport(activeId, isPluginEffective('sessions'), acceptTransportSnapshot, {
    subscriberId: activeId ? paneSubscriptionIdentity('primary', activeId) : null,
  });
  transportRef.current = {sessionId: activeId, ...conversationTransport};
  const liveConversationConnected = useConversationUpdates(activeId,
    isPluginEffective("sessions") && !conversationTransport.connected, acceptPushedSnapshot);
  useSessionPolling(isPluginEffective("sessions") && Boolean(activeId) && !conversationTransport.connected && !liveConversationConnected, pollActiveSession,
    activeSessionNeedsPolling || !session || Boolean(dataErrors.active) ? 1000 : 15000);
  useEffect(() => {
    if (session?.id === activeId && session?.status !== "running" && session?.streaming?.status !== "streaming") {
      trackSessionId(stoppingSessionsRef, setStoppingSessions, activeId, false);
    }
  }, [activeId, session?.id, session?.status, session?.streaming?.status]);

  const anySessionRunning = sessions.some(s => s.status === "running");
  useSessionPolling(isPluginEffective("sessions"), refreshList,
    executingSessions.size > 0 || runRequestSessions.size > 0 || stoppingSessions.size > 0 || anySessionRunning || dataErrors.list ? 2000 : 15000);

  useEffect(() => {
    if (!pluginCatalogReady) return;
    if (isPluginEffective("sessions")) void refreshList();
    else {
      // Stop both legacy and sessions-index requests when the owning plugin is
      // disabled; their completion is ignored above, but aborting releases the
      // transport immediately and prevents a refresh from surviving the toggle.
      listAbortRef.current?.abort();
      setSessions([]);
      setActiveId(null);
      setSession(null);
      setRows([]);
      setDataErrors({ list: "", active: "" });
    }
  }, [pluginCatalogReady, pluginCatalog, isPluginEffective, refreshList]);

  // A session switch drops the previous conversation; the files plugin resets its own state.
  useEffect(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;

    setSession(null);
    setRows([]);
    setDataErrors(previous => ({ ...previous, active: "" }));
    setQueueError(null);
    setQueueCancelling(null);
    setRunError("");
  }, [activeId]);
  useEffect(() => {
    if (activeId) void loadActive(activeId);
  }, [activeId, loadActive]);

  const liveSessions = useMemo(() => {
    return sessions.map(item => {
      let status = item.status;
      if (stoppingSessions.has(item.id)) status = "stopping";
      else if (runRequestSessions.has(item.id)) status = "running";
      else if (activeId === item.id && session?.id === item.id) {
        if (session.status === "running" || session.streaming?.status === "streaming") status = "running";
      }
      return status === item.status ? item : { ...item, status };
    });
  }, [sessions, stoppingSessions, runRequestSessions, activeId, session?.id, session?.status, session?.streaming?.status]);

  const displayTimelineRows = useMemo(() => withAssistantStream(rows, session?.streaming), [rows, session?.streaming]);
  // 上下文压缩边界：由 sessions 插件从合并后的行与 compactions 记录推导；
  // 行集合随轮询、更早分页与推送快照更新时自动重算。
  const compactionMarker = useMemo(() => session && session.id === activeId
    ? conversationCompactionBoundary(displayTimelineRows, session.compactions)
    : null, [displayTimelineRows, session, activeId]);

  return {
    mountedRef, sessionCommands, primaryQuestionTransport,
    sessions, setSessions, session, setSession, sessionSnapshotRef, rows, setRows, dataErrors, setDataErrors,
    conversationFindRequest, setConversationFindRequest, olderTranscript, loadOlderTranscript,
    refreshList, loadActive, liveSessions, displayTimelineRows, compactionMarker,
  };
}

export type WorkbenchSessionData = ReturnType<typeof useWorkbenchSessionData>;
