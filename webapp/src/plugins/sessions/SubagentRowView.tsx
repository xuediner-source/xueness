import React from "react";
import { Bot, ChevronRight } from "lucide-react";
import { t as tr } from "../../i18n";
import { conversationFindRowKey } from "./ConversationFind";
import { subagentDetailAllowed, type SubagentRow, type SubagentRowStatus } from "./subagentRows";

const Transcript = React.lazy(() => import("../subagents/SubagentTranscript").then(module => ({ default: module.SubagentTranscript })));
// Step wording stays out of the startup graph until a row actually has a count.
const StepProgress = React.lazy(() => import("./subagentRowProgress").then(module => ({ default: module.SubagentStepProgress })));
const STATUS_LABELS: Record<SubagentRowStatus, string> = {
  running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", unknown: "状态未知",
};

export function SubagentRowView({ row, sessionId, effectivePluginIds, findActive = false }: {
  row: SubagentRow;
  sessionId?: string;
  effectivePluginIds?: ReadonlySet<string>;
  findActive?: boolean;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = React.useState(false);
  const [showTranscript, setShowTranscript] = React.useState(false);
  const allowed = subagentDetailAllowed(row, sessionId, effectivePluginIds);
  const open = expanded || findActive;
  React.useEffect(() => { if (!allowed || !open) setShowTranscript(false); }, [allowed, open]);
  if (!effectivePluginIds?.has("sessions")) return null;
  return <details className="xn-zc-subagent" open={open} onToggle={event => setExpanded(event.currentTarget.open)}
    data-zcode-row-key={conversationFindRowKey(row)} data-zcode-row-kind="subagent" data-zcode-row-seq={row.seq}
    data-testid={`timeline-item-subagent-${row.taskId}`} data-task-status={row.status}
    data-task-steps={row.steps}>
    <summary><Bot size={14} aria-hidden="true" /><span className="xn-zc-subagent__label">{row.label}</span>
      {row.agent && row.agent !== row.label && <span className="xn-zc-subagent__agent">{row.agent}</span>}
      <span className="xn-zc-subagent__status">{tr(STATUS_LABELS[row.status])}</span>
      {typeof row.steps === "number" ? <React.Suspense fallback={null}><StepProgress steps={row.steps} /></React.Suspense> : null}
      <ChevronRight size={14} className="xn-zc-chevron" aria-hidden="true" /></summary>
    {open && <div className="xn-zc-subagent__body">
      <p>{row.summary || tr("暂无进展摘要")}</p>
      {allowed && !showTranscript && <button type="button" className="xn-zc-text-button"
        data-testid={`subagent-row-detail-${row.taskId}`} onClick={() => { if (allowed) setShowTranscript(true); }}>{tr("查看子会话记录")}</button>}
      {allowed && showTranscript && <React.Suspense fallback={<p role="status">{tr("正在加载子会话记录…")}</p>}>
        <Transcript key={`${sessionId}:${row.taskId}:${row.childSessionId}`} parentSessionId={sessionId!}
          taskId={row.taskId} childSessionId={row.childSessionId!} onClose={() => setShowTranscript(false)} />
      </React.Suspense>}
    </div>}
  </details>;
}
