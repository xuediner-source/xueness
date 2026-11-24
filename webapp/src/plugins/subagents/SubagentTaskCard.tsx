import React, { useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, LoaderCircle, X } from "lucide-react";
import { newSubagentRequestId } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
import { SubagentTranscript } from "./SubagentTranscript";
import type { SubagentTaskItem } from "./SubagentTaskTypes";
import { formatTaskDuration, formatTaskStatus } from "./SubagentTaskFormat";

export function TaskCard({
  task,
  parentSessionId,
  isExpanded,
  canCancel,
  isCancelling,
  actionsDisabled,
  onToggleExpand,
  onCancel,
  canGuide,
  canResume,
  canResumeWhenParentActive,
  onRequestResume,
  onSendMessage,
  onResume,
}: {
  task: SubagentTaskItem;
  parentSessionId?: string | null;
  isExpanded: boolean;
  canCancel: boolean;
  isCancelling: boolean;
  actionsDisabled: boolean;
  onToggleExpand: () => void;
  onCancel: () => void;
  canGuide: boolean;
  canResume: boolean;
  canResumeWhenParentActive: boolean;
  onRequestResume?: () => void;
  onSendMessage: (taskId: string, message: string, requestId: string) => Promise<void>;
  onResume: (taskId: string, message: string | undefined, requestId: string) => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [action, setAction] = useState<"message" | "resume" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionRequestId = useRef<string | null>(null);
  const actionRequestText = useRef<string | null>(null);
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
        {task.status === "running" && canCancel && (
          <button
            type="button"
            className="xn-subagent-card__cancel-btn"
            disabled={actionsDisabled}
            onClick={e => {
              e.stopPropagation();
              onCancel();
            }}
            data-testid={`subagent-cancel-${task.id}`}
            title={tr("只取消此子任务；主会话和其他子任务继续运行。")}
          >
            {isCancelling ? tr("正在取消此项…") : tr("取消此项")}
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
            if (isImeComposingEvent(e)) return;
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

      {(canGuide || canResume) && (
        <form
          className="xn-subagent-card__followup"
          onSubmit={event => {
            event.preventDefault();
            const text = draft.trim();
            const resumeNeedsMessage = !canGuide && task.recoveryReason === "followup_required";
            if (action || (canGuide && !text) || (resumeNeedsMessage && !text)) return;
            if (actionRequestText.current !== text) {
              actionRequestText.current = text;
              actionRequestId.current = null;
            }
            const requestId = actionRequestId.current ?? (actionRequestId.current = newSubagentRequestId());
            const kind = canGuide ? "message" : "resume";
            setAction(kind);
            setActionError(null);
            void (kind === "message"
              ? onSendMessage(task.id, text, requestId)
              : onResume(task.id, text || undefined, requestId))
              .then(() => {
                setDraft("");
                actionRequestId.current = null;
                actionRequestText.current = null;
              })
              .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
              .finally(() => setAction(null));
          }}
          data-testid={`${canGuide ? "subagent-message" : "subagent-resume"}-${task.id}`}
        >
          <textarea
            value={draft}
            onChange={event => setDraft(event.currentTarget.value)}
            maxLength={24000}
            rows={2}
            aria-label={canGuide ? tr("给子代理发送消息") : tr("继续任务")}
            placeholder={canGuide ? tr("在下一个安全边界发送消息") : tr("继续任务的消息（可选）")}
          />
          {canGuide ? (
            <button type="submit" disabled={actionsDisabled || action !== null || !draft.trim()}>
              {action === "message" ? tr("正在发送…") : tr("发送")}
            </button>
          ) : (
            <button type="submit" disabled={actionsDisabled || action !== null ||
              (task.recoveryReason === "followup_required" && !draft.trim())}>
              {action === "resume" ? tr("正在继续…") : tr("继续")}
            </button>
          )}
          {actionError && <span role="alert">{actionError}</span>}
        </form>
      )}

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
          {task.childSessionId && parentSessionId && (
            <div className="xn-subagent-transcript-launch">
              {!showTranscript && <button type="button" onClick={() => setShowTranscript(true)}
                data-testid={`subagent-transcript-open-${task.id}`}>{tr("查看子会话记录")}</button>}
              {showTranscript && <SubagentTranscript key={`${parentSessionId}:${task.id}:${task.childSessionId}`}
                parentSessionId={parentSessionId} taskId={task.id} childSessionId={task.childSessionId}
                onClose={() => setShowTranscript(false)} />}
            </div>
          )}
          {canResumeWhenParentActive && (
            <div className="xn-subagent-card__parent-resume">
              <p>{tr("子任务可在主会话下一轮恢复。恢复指令只会放入主会话输入框，不会自动发送。")}</p>
              <button type="button" disabled={!onRequestResume}
                onClick={() => onRequestResume?.()} data-testid={`subagent-parent-resume-${task.id}`}>
                {tr("在主会话中继续")}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
