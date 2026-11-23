import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, LoaderCircle, RefreshCw, X } from "lucide-react";
import { cancelSubagentTask, get, post, resumeSubagentTask, sendSubagentMessage } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { startSessionPolling } from "../sessions/SessionPolling";
import { SubagentEmptyState } from './SubagentEmptyState';
import { TaskCard } from "./SubagentTaskCard";
import type { SubagentTaskItem } from "./SubagentTaskTypes";
import "../../styles/subagent-sidepane.css";

export type { SubagentTaskItem } from "./SubagentTaskTypes";
export { formatTaskDuration, formatTaskStatus } from "./SubagentTaskFormat";


export type SubagentSidePaneProps = {
  sessionId?: string | null;
  isOpen?: boolean;
  onClose?: () => void;
  activeRuntimeProfile?: string | null;
  subagentsEnabled?: boolean;
  cancelOneEnabled?: boolean;
  lightweight?: boolean;
  mode?: "sidepane" | "panel" | "summary";
  onOpenTasks?: () => void;
  pollIntervalMs?: number;
  initialTasks?: SubagentTaskItem[];
  onCancelTask?: (taskId: string) => Promise<void>;
  onStopSession?: () => Promise<void>;
  onRequestResumeChild?: (taskId: string) => void;
  fetchTasksFn?: (sessionId: string, signal?: AbortSignal) => Promise<{ tasks: SubagentTaskItem[] }>;
};

type SubagentRequestScope = {
  sessionId: string;
  controller: AbortController;
  requestGeneration: number;
};


export function SubagentSidePane({
  sessionId,
  isOpen = true,
  onClose,
  activeRuntimeProfile,
  subagentsEnabled = true,
  cancelOneEnabled = false,
  lightweight = false,
  mode = "sidepane",
  onOpenTasks,
  pollIntervalMs = 2000,
  initialTasks,
  onCancelTask,
  onStopSession,
  onRequestResumeChild,
  fetchTasksFn,
}: SubagentSidePaneProps): React.JSX.Element | null {
  const isLightweight = lightweight || activeRuntimeProfile === "lightweight";

  const [tasks, setTasks] = useState<SubagentTaskItem[]>(initialTasks ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const initialLoadDone = useRef(false);
  const requestScope = useRef<SubagentRequestScope | null>(null);
  const latestProps = useRef({ sessionId, isOpen, isLightweight, subagentsEnabled });
  latestProps.current = { sessionId, isOpen, isLightweight, subagentsEnabled };

  const isScopeCurrent = useCallback((scope: SubagentRequestScope) => {
    const latest = latestProps.current;
    return requestScope.current === scope
      && !scope.controller.signal.aborted
      && latest.sessionId === scope.sessionId
      && latest.isOpen
      && !latest.isLightweight
      && latest.subagentsEnabled;
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const loadTasks = useCallback(
    async (showLoadingSpinner = false) => {
      const scope = requestScope.current;
      if (!scope || !isScopeCurrent(scope)) return;
      // A newer refresh in the same session supersedes this response too.
      const requestGeneration = ++scope.requestGeneration;
      const requestSignal = scope.controller.signal;
      try {
        if (showLoadingSpinner) {
          setLoading(true);
        }
        setError(null);
        const data = fetchTasksFn
          ? await fetchTasksFn(scope.sessionId, requestSignal)
          : await get<{ tasks: SubagentTaskItem[] }>(`/api/sessions/${encodeURIComponent(scope.sessionId)}/tasks`, requestSignal);
        if (isScopeCurrent(scope) && scope.requestGeneration === requestGeneration) {
          setTasks(Array.isArray(data.tasks) ? data.tasks : []);
        }
      } catch (err: unknown) {
        if (isScopeCurrent(scope) && scope.requestGeneration === requestGeneration) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      } finally {
        if (isScopeCurrent(scope) && scope.requestGeneration === requestGeneration) {
          setLoading(false);
        }
      }
    },
    [fetchTasksFn, isScopeCurrent],
  );

  const handleCancelTask = useCallback(
    async (taskId: string) => {
      const scope = requestScope.current;
      if (!cancelOneEnabled || !scope || !isScopeCurrent(scope) || cancellingId || stoppingSession) return;
      if (!window.confirm(tr("取消此子任务？主会话和其他子任务将继续运行。"))) return;
      setCancellingId(taskId);
      try {
        if (onCancelTask) await onCancelTask(taskId);
        else await cancelSubagentTask(scope.sessionId, taskId);
        if (isScopeCurrent(scope)) await loadTasks(false);
      } catch (err: unknown) {
        if (isScopeCurrent(scope)) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isScopeCurrent(scope)) setCancellingId(null);
      }
    },
    [cancelOneEnabled, cancellingId, stoppingSession, isScopeCurrent, onCancelTask, loadTasks],
  );

  const handleStopSession = useCallback(async () => {
    const scope = requestScope.current;
    if (!scope || !isScopeCurrent(scope) || cancellingId || stoppingSession) return;
    if (!window.confirm(tr("中止整个会话？这会停止主会话并取消全部运行中的子任务。"))) return;
    setStoppingSession(true);
    try {
      if (onStopSession) await onStopSession();
      else await post<{ stopping: boolean }>(`/api/sessions/${encodeURIComponent(scope.sessionId)}/stop`, {});
      if (isScopeCurrent(scope)) await loadTasks(false);
    } catch (err: unknown) {
      if (isScopeCurrent(scope)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isScopeCurrent(scope)) setStoppingSession(false);
    }
  }, [cancellingId, stoppingSession, isScopeCurrent, onStopSession, loadTasks]);

  const handleSendChildMessage = useCallback(async (taskId: string, message: string, requestId: string) => {
    const scope = requestScope.current;
    if (!scope || !isScopeCurrent(scope)) throw new Error(tr("会话已切换，请重试。"));
    await sendSubagentMessage(scope.sessionId, taskId, message, requestId);
    if (isScopeCurrent(scope)) await loadTasks(false);
  }, [isScopeCurrent, loadTasks]);

  const handleResumeChild = useCallback(async (taskId: string, message: string | undefined, requestId: string) => {
    const scope = requestScope.current;
    if (!scope || !isScopeCurrent(scope)) throw new Error(tr("会话已切换，请重试。"));
    await resumeSubagentTask(scope.sessionId, taskId, message, requestId);
    if (isScopeCurrent(scope)) await loadTasks(false);
  }, [isScopeCurrent, loadTasks]);

  useEffect(() => {
    setTasks(initialTasks ?? []);
    setError(null);
    setLoading(false);
    setCancellingId(null);
    setStoppingSession(false);
    setExpandedIds(new Set());
    initialLoadDone.current = false;
  }, [sessionId, initialTasks]);

  useEffect(() => {
    if (isLightweight || !isOpen || !sessionId || !subagentsEnabled) {
      initialLoadDone.current = false;
      setLoading(false);
      setCancellingId(null);
      setStoppingSession(false);
      return;
    }

    const scope: SubagentRequestScope = {
      sessionId,
      controller: new AbortController(),
      requestGeneration: 0,
    };
    requestScope.current = scope;
    const shouldShowSpinner = !initialLoadDone.current;
    initialLoadDone.current = true;
    void loadTasks(shouldShowSpinner);

    const stop = startSessionPolling({
      refresh: () => loadTasks(false),
      visibleDelayMs: pollIntervalMs,
      hiddenDelayMs: 30000,
    });

    return () => {
      if (requestScope.current === scope) requestScope.current = null;
      scope.controller.abort();
      stop();
    };
  }, [isLightweight, isOpen, sessionId, subagentsEnabled, pollIntervalMs, loadTasks]);

  const runningTasks = useMemo(() => tasks.filter(t => t.status === "running"), [tasks]);
  const endedTasks = useMemo(() => tasks.filter(t => t.status !== "running"), [tasks]);

  if (isLightweight) {
    return null;
  }

  if (mode === "sidepane" && !isOpen) {
    return null;
  }

  if (mode === 'summary') return <section className="xn-subagent-context-summary" aria-label={tr('子智能体')}>
    <header><h2>{tr('子智能体')}</h2></header>
    {error ? <p role="alert">{error}</p> : loading && !tasks.length ? <p>{tr('正在加载子任务…')}</p> : !tasks.length ? <p>{tr('暂无子任务')}</p> :
      <button type="button" className="xn-session-context__item" onClick={onOpenTasks} disabled={!onOpenTasks}>
        <span className="xn-subagent-context-summary__agents" aria-hidden="true">{tasks.slice(0,4).map((task,index)=><Bot key={task.id} size={15} data-agent-color={index} />)}</span>
        <span>{runningTasks.length > 0 ? `${runningTasks.length} ${tr('运行中')}` : `${tasks.filter(task=>task.status==='completed').length} ${tr('已完成')}`}
          {tasks.some(task=>task.status==='failed') && ` · ${tasks.filter(task=>task.status==='failed').length} ${tr('失败')}`}
          {tasks.some(task=>task.status==='cancelled') && ` · ${tasks.filter(task=>task.status==='cancelled').length} ${tr('已取消')}`}</span>
      </button>}
  </section>;

  return (
    <aside
      className={`xn-subagent-sidepane xn-subagent-sidepane--${mode}`}
      data-testid="subagent-sidepane"
      aria-label={tr("子代理运行态")}
    >
      <header className="xn-subagent-sidepane__header">
        <div className="xn-subagent-sidepane__title-wrap">
          <Bot size={16} className="xn-subagent-sidepane__mark" aria-hidden="true" />
          <div className="xn-subagent-sidepane__heading-copy"><h2 className="xn-subagent-sidepane__title">{tr(mode === 'panel' ? '智能体团队' : '子代理运行态')}</h2>
            {mode === 'panel' && <p>{tr('集中查看子任务进展，随时跟进执行结果。')}</p>}</div>
          {tasks.length > 0 && (
            <span
              className={`xn-subagent-sidepane__badge ${runningTasks.length > 0 ? "xn-subagent-sidepane__badge--active" : ""}`}
              data-testid="subagent-sidepane-count"
            >
              {runningTasks.length > 0 ? `${runningTasks.length} ${tr("运行中")}` : `${tasks.length}`}
            </span>
          )}
        </div>
        <div className="xn-subagent-sidepane__actions">
          {subagentsEnabled && sessionId && runningTasks.length > 0 && (
            <button
              type="button"
              className="xn-subagent-sidepane__stop-btn"
              disabled={stoppingSession || cancellingId !== null}
              onClick={() => void handleStopSession()}
              data-testid="subagent-stop-session"
              title={tr("停止主会话并取消全部运行中的子任务。")}
            >
              {stoppingSession ? tr("正在中止会话…") : tr("中止整个会话")}
            </button>
          )}
          <button
            type="button"
            className="xn-subagent-sidepane__btn"
            aria-label={tr("刷新子任务")}
            title={tr("刷新子任务")}
            disabled={loading || !subagentsEnabled || !sessionId}
            data-testid="subagent-sidepane-refresh"
            onClick={() => void loadTasks(true)}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
            {mode === 'panel' && <span>{tr('刷新')}</span>}
          </button>
          {onClose && (
            <button
              type="button"
              className="xn-subagent-sidepane__btn"
              aria-label={mode === "sidepane" ? tr("关闭侧栏") : tr("关闭面板")}
              title={mode === "sidepane" ? tr("关闭侧栏") : tr("关闭面板")}
              data-testid="subagent-sidepane-close"
              onClick={onClose}
            >
              {mode === 'panel' ? <><ArrowLeft size={14} aria-hidden="true" /><span>{tr('返回会话')}</span></> : <X size={16} aria-hidden="true" />}
            </button>
          )}
        </div>
      </header>

      <div className="xn-subagent-sidepane__body">
        {!subagentsEnabled ? (
          <SubagentEmptyState kind="disabled" />
        ) : !sessionId ? (
          <SubagentEmptyState kind="no-session" />
        ) : loading && tasks.length === 0 ? (
          <div className="xn-subagent-sidepane__loading" data-testid="subagent-sidepane-loading">
            <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
            <span>{tr("正在加载子任务…")}</span>
          </div>
        ) : error && tasks.length === 0 ? (
          <div className="xn-subagent-sidepane__error" role="alert" data-testid="subagent-sidepane-error">
            <span>{error}</span>
            <button
              type="button"
              className="xn-subagent-card__cancel-btn"
              onClick={() => void loadTasks()}
            >
              {tr("重试")}
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <SubagentEmptyState kind="empty" />
        ) : (
          <>
            {runningTasks.length > 0 && (
              <section className="xn-subagent-sidepane__section" data-testid="subagent-section-running">
                <h3 className="xn-subagent-sidepane__section-title">
                  {tr("运行中")} · {runningTasks.length}
                </h3>
                {runningTasks.map(task => (
                  <TaskCard
                    key={`${task.id}:${task.childSessionId ?? ""}`}
                    task={task}
                    parentSessionId={sessionId}
                    isExpanded={expandedIds.has(task.id)}
                    canCancel={cancelOneEnabled}
                    isCancelling={cancellingId === task.id}
                    actionsDisabled={stoppingSession || cancellingId !== null}
                    onToggleExpand={() => toggleExpand(task.id)}
                    onCancel={() => handleCancelTask(task.id)}
                    canGuide={task.canGuide === true}
                    canResume={task.canResume === true && task.canResumeNow === true}
                    canResumeWhenParentActive={task.canResume === true && task.canResumeNow !== true}
                    onRequestResume={onRequestResumeChild ? () => onRequestResumeChild(task.id) : undefined}
                    onSendMessage={handleSendChildMessage}
                    onResume={handleResumeChild}
                  />
                ))}
              </section>
            )}

            {endedTasks.length > 0 && (
              <section className="xn-subagent-sidepane__section" data-testid="subagent-section-ended">
                <h3 className="xn-subagent-sidepane__section-title">
                  {tr("已结束")} · {endedTasks.length}
                </h3>
                {endedTasks.map(task => (
                  <TaskCard
                    key={`${task.id}:${task.childSessionId ?? ""}`}
                    task={task}
                    parentSessionId={sessionId}
                    isExpanded={expandedIds.has(task.id)}
                    canCancel={false}
                    isCancelling={false}
                    actionsDisabled={stoppingSession || cancellingId !== null}
                    onToggleExpand={() => toggleExpand(task.id)}
                    onCancel={() => undefined}
                    canGuide={false}
                    canResume={task.canResume === true && task.canResumeNow === true}
                    canResumeWhenParentActive={task.canResume === true && task.canResumeNow !== true}
                    onRequestResume={onRequestResumeChild ? () => onRequestResumeChild(task.id) : undefined}
                    onSendMessage={handleSendChildMessage}
                    onResume={handleResumeChild}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
