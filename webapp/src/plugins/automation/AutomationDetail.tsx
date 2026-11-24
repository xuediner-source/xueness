import React from "react";
import type { AutomationRecord } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import { describeCronSchedule, type WorkflowNodeDraft } from "./automationModel";
import { approvalLabel, formatDate, runStatusLabel } from "./automationFormat";
import { formatCommandArgv } from "../../xuenessWorkbench";

export function AutomationDetail({
  record,
  busy,
  onBack,
  onEdit,
  onApprove,
  onRun,
  onDelete,
}: {
  record: AutomationRecord;
  busy: boolean;
  onBack: () => void;
  onEdit: () => void;
  onApprove: () => void;
  onRun: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <section className="xn-automation__detail" data-testid="automation-detail">
      <div className="xn-automation__detail-heading">
        <button type="button" onClick={onBack}>{tr("返回计划列表")}</button>
        <div className="xn-automation__detail-title">
          <h4>{record.name}</h4>
          <div className="xn-automation__badges">
            <span className={`xn-automation__badge ${record.enabled ? "is-enabled" : "is-paused"}`}>{record.enabled ? tr("已启用") : tr("已暂停")}</span>
            <span className={`xn-automation__badge ${record.approved ? "is-approved" : "is-pending"}`}>{approvalLabel(record)}</span>
          </div>
          <p>{describeCronSchedule(record.schedule, tr, tf)} <span>·</span> {record.timezone}</p>
        </div>
        <div className="xn-automation__actions">
          <button type="button" onClick={onEdit}>{tr("编辑")}</button>
          {record.approved
            ? <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={onRun}>{tr("立即运行")}</button>
            : <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={onApprove}>{tr("批准计划")}</button>}
          <button type="button" className="xn-automation__button--quiet-danger" disabled={busy} onClick={onDelete}>{tr("删除")}</button>
        </div>
      </div>
      <div className="xn-automation__detail-grid">
        <section className="xn-automation__detail-panel">
          <h5>{tr("计划详情")}</h5>
          <dl>
            <div><dt>{tr("状态")}</dt><dd>{record.enabled ? tr("已启用") : tr("已暂停")}</dd></div>
            <div><dt>{tr("审批")}</dt><dd>{approvalLabel(record)}</dd></div>
            <div><dt>{tr("Cron 时间表")}</dt><dd><code>{record.schedule}</code></dd></div>
            <div><dt>{tr("下次运行")}</dt><dd>{record.nextRunAt ? formatDate(record.nextRunAt) : tr("未安排")}</dd></div>
            <div><dt>{tr("工作区路径")}</dt><dd><code>{record.workflow.root}</code></dd></div>
            <div><dt>{tr("工作流名称")}</dt><dd>{record.workflow.name}</dd></div>
            <div><dt>{tr("并发数")}</dt><dd>{record.workflow.concurrency ?? 1}</dd></div>
          </dl>
        </section>
        <section className="xn-automation__detail-panel">
          <h5>{tr("工作流步骤")} <span>{record.workflow.nodes.length}</span></h5>
          <ol className="xn-automation__steps">
            {record.workflow.nodes.map((value, index) => {
              const node = value as Partial<WorkflowNodeDraft>;
              const id = typeof node.id === "string" ? node.id : `step-${index + 1}`;
              const kind = node.kind === "agent" ? "agent" : "command";
              return (
                <li key={`${id}-${index}`}>
                  <div className="xn-automation__step-heading"><strong>{id}</strong><span>{kind === "agent" ? tr("代理步骤") : tr("命令步骤")}</span></div>
                  <p>{tr("工作目录：")}<code>{typeof node.cwd === "string" ? node.cwd : "."}</code> · {tr("超时：")}{typeof node.timeout === "number" ? node.timeout : 300}{tr(" 秒")}</p>
                  {Array.isArray(node.needs) && node.needs.length > 0 && <p>{tr("依赖：")}{node.needs.join(", ")}</p>}
                  {kind === "command" ? (
                    <pre><code>{Array.isArray(node.argv) ? formatCommandArgv(node.argv) : ""}</code></pre>
                  ) : (
                    <>
                      <p className="xn-automation__prompt">{typeof node.prompt === "string" ? node.prompt : ""}</p>
                      {(node.provider_id || node.model) && <p>{[node.provider_id, node.model].filter(Boolean).join(" · ")}</p>}
                      {node.writable === true && <p>{tr("允许代理步骤写入文件")}</p>}
                    </>
                  )}
                  {typeof node.phase === "string" && node.phase && <p>{tr("阶段：")}{node.phase}</p>}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
      <section className="xn-automation__detail-panel xn-automation__history">
        <div className="xn-automation__section-heading">
          <h5>{tr("运行历史")} <span>{record.history?.length ?? 0}</span></h5>
          <p>{tr("最近的运行记录显示在最前面。")}</p>
        </div>
        {!record.history?.length ? (
          <p className="xn-automation__empty-history">{tr("尚无运行记录")}</p>
        ) : (
          <ol className="xn-automation__history-list">
            {[...record.history].reverse().map((run) => (
              <li key={run.id}>
                <span className={`xn-automation__run-status status-${run.status}`}>{runStatusLabel(run.status)}</span>
                <span>{formatDate(run.at)}</span>
                {run.workflowId && <span>{tr("工作流运行 ID：")}<code>{run.workflowId}</code></span>}
                {run.error && <span className="xn-automation__error-text" role="alert">{run.error}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
