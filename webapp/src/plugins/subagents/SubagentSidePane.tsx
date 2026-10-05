import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import { get, post } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import { startSessionPolling } from "../sessions/SessionPolling";
import "../../styles/subagent-sidepane.css";

export type SubagentTaskItem = {
  id: string;
  parent?: string;
  name?: string;
  title?: string;
  agent?: string | null;
  status: "running" | "completed" | "failed" | "cancelled" | string;
  steps: number;
  startedAt?: number | null;
  endedAt?: number | null;
  summary?: string;
  error?: string;
  promptChars?: number;
  workerActive?: boolean;
  root?: string | null;
};

export type SubagentSidePaneProps = {
  sessionId?: string | null;
  isOpen?: boolean;
  onClose?: () => void;
  activeRuntimeProfile?: string | null;
  subagentsEnabled?: boolean;
  lightweight?: boolean;
  mode?: "sidepane" | "panel";
  pollIntervalMs?: number;
  initialTasks?: SubagentTaskItem[];
  onCancel?: (taskId?: string) => Promise<void>;
  fetchTasksFn?: (sessionId: string, signal?: AbortSignal) => Promise<{ tasks: SubagentTaskItem[] }>;
};

type SubagentRequestScope = {
  sessionId: string;
  controller: AbortController;
  requestGeneration: number;
};

export function formatTaskDuration(startedAt?: number | null, endedAt?: number | null): string {
  if (!startedAt || typeof startedAt !== "number" || startedAt <= 0) return "-";
  const end = typeof endedAt === "number" && endedAt > 0 ? endedAt : Date.now() / 1000;
  const diff = Math.max(0, end - startedAt);
  if (diff < 1) return "< 1s";
  if (diff < 60) return `${diff.toFixed(1)}s`;
  const mins = Math.floor(diff / 60);
  const secs = Math.floor(diff % 60);
  return `${mins}m ${secs}s`;
}

export function formatTaskStatus(status: string): { label: string; tone: "ok" | "warn" | "error" | "muted" } {
  switch (status) {
    case "running":
      return { label: tr("运行中"), tone: "warn" };
    case "completed":
      return { label: tr("已完成"), tone: "ok" };
    case "failed":
      return { label: tr("失败"), tone: "error" };
    case "cancelled":
      return { label: tr("已取消"), tone: "muted" };
    default:
      return { label: status, tone: "muted" };
  }
}

export function SubagentSidePane({
  sessionId,
  isOpen = true,
  onClose,
  activeRuntimeProfile,
  subagentsEnabled = true,
  lightweight = false,
  mode = "sidepane",
  pollIntervalMs = 2000,
  initialTasks,
  onCancel,
  fetchTasksFn,
}: SubagentSidePaneProps): React.JSX.Element | null {
  const isLightweight = lightweight || activeRuntimeProfile === "lightweight";

  const [tasks, setTasks] = useState<SubagentTaskItem[]>(initialTasks ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
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

  const handleCancel = useCallback(
    async (taskId: string) => {
      const scope = requestScope.current;
      if (!scope || !isScopeCurrent(scope)) return;
      setCancellingId(taskId);
      try {
        if (onCancel) {
          await onCancel(taskId);
        } else {
          await post<{ stopping: boolean }>(`/api/sessions/${encodeURIComponent(scope.sessionId)}/stop`, {});
        }
        if (isScopeCurrent(scope)) await loadTasks(false);
      } catch (err: unknown) {
        if (isScopeCurrent(scope)) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      } finally {
        if (isScopeCurrent(scope)) setCancellingId(null);
      }
    },
    [isScopeCurrent, onCancel, loadTasks],
  );

  useEffect(() => {
    setTasks(initialTasks ?? []);
    setError(null);
    setLoading(false);
    setCancellingId(null);
    setExpandedIds(new Set());
    initialLoadDone.current = false;
  }, [sessionId, initialTasks]);

  useEffect(() => {
    if (isLightweight || !isOpen || !sessionId || !subagentsEnabled) {
      initialLoadDone.current = false;
      setLoading(false);
      setCancellingId(null);
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

  if (isLightweight) {
    return null;
  }

  if (mode === "sidepane" && !isOpen) {
    return null;
  }

  const runningTasks = useMemo(() => tasks.filter(t => t.status === "running"), [tasks]);
  const endedTasks = useMemo(() => tasks.filter(t => t.status !== "running"), [tasks]);

  return (
    <aside
      className={`xn-subagent-sidepane xn-subagent-sidepane--${mode}`}
      data-testid="subagent-sidepane"
      aria-label={tr("子代理运行态")}
    >
      <header className="xn-subagent-sidepane__header">
        <div className="xn-subagent-sidepane__title-wrap">
          <Bot size={16} aria-hidden="true" />
          <h2 className="xn-subagent-sidepane__title">{tr("子代理运行态")}</h2>
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
          <button
            type="button"
            className="xn-subagent-sidepane__btn"
            aria-label={tr("刷新子任务")}
            title={tr("刷新子任务")}
            disabled={loading}
            data-testid="subagent-sidepane-refresh"
            onClick={() => void loadTasks(true)}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
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
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <div className="xn-subagent-sidepane__body">
        {!subagentsEnabled ? (
          <div className="xn-subagent-sidepane__empty" data-testid="subagent-sidepane-disabled">
            <Bot size={28} aria-hidden="true" />
            <p className="xn-subagent-sidepane__empty-title">{tr("子代理插件已禁用")}</p>
          </div>
        ) : !sessionId ? (
          <div className="xn-subagent-sidepane__empty" data-testid="subagent-sidepane-no-session">
            <Bot size={28} aria-hidden="true" />
            <p className="xn-subagent-sidepane__empty-hint">{tr("选择会话后查看子代理任务。")}</p>
          </div>
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
          <div className="xn-subagent-sidepane__empty" data-testid="subagent-sidepane-empty">
            <Bot size={28} aria-hidden="true" />
            <p className="xn-subagent-sidepane__empty-title">{tr("暂无子代理任务")}</p>
            <p className="xn-subagent-sidepane__empty-hint">
              {tr("主代理派发只读子任务时，运行状态将在此实时显示。")}
            </p>
          </div>
        ) : (
          <>
            {runningTasks.length > 0 && (
              <section className="xn-subagent-sidepane__section" data-testid="subagent-section-running">
                <h3 className="xn-subagent-sidepane__section-title">
                  {tr("运行中")} · {runningTasks.length}
                </h3>
                {runningTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    isExpanded={expandedIds.has(task.id)}
                    isCancelling={cancellingId === task.id}
                    onToggleExpand={() => toggleExpand(task.id)}
                    onCancel={() => handleCancel(task.id)}
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
                    key={task.id}
                    task={task}
                    isExpanded={expandedIds.has(task.id)}
                    isCancelling={cancellingId === task.id}
                    onToggleExpand={() => toggleExpand(task.id)}
                    onCancel={() => handleCancel(task.id)}
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

function TaskCard({
  task,
  isExpanded,
  isCancelling,
  onToggleExpand,
  onCancel,
}: {
  task: SubagentTaskItem;
  isExpanded: boolean;
  isCancelling: boolean;
  onToggleExpand: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const statusInfo = formatTaskStatus(task.status);
  const duration = formatTaskDuration(task.startedAt, task.endedAt);
  const agentLabel = task.agent || "general-purpose";
  const displayTitle = task.title || task.name || agentLabel;
  const shortId = task.id.startsWith("task-") ? task.id.slice(5, 13) : task.id.slice(0, 8);

  const statusIcon = useMemo(() => {
    switch (task.status) {
      case "running":
        return <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />;
      case "completed":
        return <Check size={14} aria-hidden="true" />;
      case "failed":
        return <AlertTriangle size={14} aria-hidden="true" />;
      case "cancelled":
        return <X size={14} aria-hidden="true" />;
      default:
        return <Bot size={14} aria-hidden="true" />;
    }
  }, [task.status]);

  const summaryPreview = task.error
    ? task.error
    : task.summary
    ? task.summary
    : task.status === "running"
    ? tr("子代理正在执行中…")
    : task.status === "completed"
    ? tr("执行完成，暂无摘要")
    : tr("暂无进展摘要");

  return (
    <article
      className={`xn-subagent-card xn-subagent-card--${task.status}`}
      data-testid={`subagent-task-${task.id}`}
      data-task-status={task.status}
    >
      <div className="xn-subagent-card__header">
        <div className="xn-subagent-card__agent-info">
          <span className="xn-subagent-card__icon" aria-hidden="true">
            {statusIcon}
          </span>
          <span className="xn-subagent-card__agent-name" title={displayTitle}>
            {displayTitle}
          </span>
          {displayTitle !== agentLabel && (
            <span className="xn-subagent-card__task-id" title={agentLabel}>
              ({agentLabel})
            </span>
          )}
          <span className="xn-subagent-card__task-id" title={task.id}>
            #{shortId}
          </span>
        </div>
        <span className="xn-subagent-card__status-badge" data-testid={`subagent-status-${task.id}`}>
          {statusInfo.label}
        </span>
      </div>

      <div className="xn-subagent-card__meta">
        <div className="xn-subagent-card__metrics">
          <span>{tf("第 {0} 步", [task.steps])}</span>
          <span>{duration}</span>
        </div>
        {task.status === "running" && (
          <button
            type="button"
            className="xn-subagent-card__cancel-btn"
            disabled={isCancelling}
            onClick={e => {
              e.stopPropagation();
              onCancel();
            }}
            data-testid={`subagent-cancel-${task.id}`}
            title={tr("目前没有单个子任务的取消接口：这会停止整个会话运行，并协作取消其全部子任务。")}
          >
            {isCancelling ? tr("正在停止…") : tr("停止会话（取消全部子任务）")}
          </button>
        )}
      </div>

      {summaryPreview ? (
        <div
          className="xn-subagent-card__summary-preview"
          onClick={onToggleExpand}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleExpand();
            }
          }}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? tr("收起详情") : tr("展开详情")}
          data-testid={`subagent-expand-${task.id}`}
        >
          <span
            className={`xn-subagent-card__summary-text ${task.error ? "xn-subagent-card__error-text" : ""}`}
            data-testid={`subagent-summary-${task.id}`}
          >
            {summaryPreview}
          </span>
          <span className="xn-subagent-card__expand-icon" aria-hidden="true">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
      ) : null}

      {isExpanded && (
        <div className="xn-subagent-card__expanded-details" data-testid={`subagent-details-${task.id}`}>
          {task.error && (
            <div className="xn-subagent-card__expanded-section">
              <span className="xn-subagent-card__expanded-heading">{tr("错误信息")}</span>
              <div className="xn-subagent-card__expanded-content xn-subagent-card__error-text">
                {task.error}
              </div>
            </div>
          )}

          {task.summary && (
            <div className="xn-subagent-card__expanded-section">
              <span className="xn-subagent-card__expanded-heading">{tr("结果摘要")}</span>
              <div className="xn-subagent-card__expanded-content">
                {task.summary}
              </div>
            </div>
          )}

          <div className="xn-subagent-card__expanded-meta-grid">
            <div>
              <strong>{tr("执行步数")}:</strong> {task.steps}
            </div>
            {task.promptChars !== undefined && (
              <div>
                <strong>{tr("提示词字符数")}:</strong> {task.promptChars}
              </div>
            )}
            {task.startedAt && (
              <div>
                <strong>{tr("开始时间")}:</strong>{" "}
                {new Date(task.startedAt * 1000).toLocaleTimeString()}
              </div>
            )}
            {task.endedAt && (
              <div>
                <strong>{tr("结束时间")}:</strong>{" "}
                {new Date(task.endedAt * 1000).toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
