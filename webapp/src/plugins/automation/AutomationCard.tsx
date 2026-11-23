import React from "react";
import type { AutomationRecord } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import { describeCronSchedule } from "./automationModel";
import { approvalLabel, formatDate, runStatusLabel } from "./automationFormat";

export function AutomationCard({
  record,
  busy,
  onOpen,
  onEdit,
  onApprove,
  onRun,
  onDelete,
}: {
  record: AutomationRecord;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onApprove: () => void;
  onRun: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const lastRun = record.history?.[record.history.length - 1];
  return (
    <article className="xn-automation__card">
      <div className="xn-automation__card-main">
        <div className="xn-automation__card-title-row">
          <h4>{record.name}</h4>
          <div className="xn-automation__badges">
            <span className={`xn-automation__badge ${record.enabled ? "is-enabled" : "is-paused"}`}>{record.enabled ? tr("已启用") : tr("已暂停")}</span>
            <span className={`xn-automation__badge ${record.approved ? "is-approved" : "is-pending"}`}>{approvalLabel(record)}</span>
          </div>
        </div>
        <div className="xn-automation__schedule-block">
          <p className="xn-automation__schedule">{describeCronSchedule(record.schedule, tr, tf)} <span>·</span> {record.timezone}</p>
          <p className="xn-automation__next-run"><span>{tr("下次运行：")}</span><strong>{record.nextRunAt ? formatDate(record.nextRunAt) : tr("未安排")}</strong></p>
        </div>
        <div className="xn-automation__card-meta">
          <span>{tr("工作流：")}{record.workflow.name}</span>
          <span>{record.workflow.nodes.length} {tr("个步骤")}</span>
          <span>{lastRun ? `${tr("最近运行：")}${runStatusLabel(lastRun.status)} · ${formatDate(lastRun.at)}` : tr("尚无运行记录")}</span>
        </div>
      </div>
      <div className="xn-automation__actions">
        <button type="button" onClick={onOpen}>{tr("查看详情和历史")}</button>
        <button type="button" onClick={onEdit}>{tr("编辑")}</button>
        {record.approved
          ? <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={onRun}>{tr("立即运行")}</button>
          : <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={onApprove}>{tr("批准计划")}</button>}
        <button type="button" className="xn-automation__button--quiet-danger" disabled={busy} onClick={onDelete}>{tr("删除")}</button>
      </div>
    </article>
  );
}
