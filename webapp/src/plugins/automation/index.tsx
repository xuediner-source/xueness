import React, { useEffect, useState, type FormEvent } from "react";
import {
  approveAutomation,
  createAutomation,
  deleteAutomation,
  listAutomations,
  runAutomation,
  updateAutomation,
  type AutomationRecord,
} from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import {
  automationDraftFromRecord,
  cronFromScheduleDraft,
  describeCronSchedule,
  emptyAutomationDraft,
  newWorkflowNode,
  validateAutomationDraft,
  workflowNodesForApi,
  type AutomationDraft,
  type ScheduleMode,
  type WorkflowNodeDraft,
} from "./automationModel";
import "../../styles/automation.css";

type ConfirmAction = { kind: "approve" | "delete" | "run"; record: AutomationRecord };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString() : tr("未安排");
}

function approvalLabel(record: AutomationRecord): string {
  return record.approved ? tr("计划已批准") : tr("待审批");
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "claimed": return tr("等待调度");
    case "awaiting_approval": return tr("等待运行审批");
    case "started": return tr("已启动");
    case "failed": return tr("启动失败");
    default: return status;
  }
}

export function XuenessAutomationsPanel(): React.JSX.Element {
  const [items, setItems] = useState<AutomationRecord[]>([]);
  const [form, setForm] = useState<AutomationDraft>(() => emptyAutomationDraft());
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [allowReal, setAllowReal] = useState(false);

  const refresh = async () => {
    try {
      setItems((await listAutomations()).automations);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  useEffect(() => { void refresh(); }, []);

  const mutate = async (operation: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
      after?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const resetForm = () => {
    setForm(emptyAutomationDraft());
    setEditing(null);
    setFormOpen(false);
  };

  const beginCreate = () => {
    setForm(emptyAutomationDraft());
    setEditing(null);
    setDetailId(null);
    setFormOpen(true);
  };

  const beginEdit = (record: AutomationRecord) => {
    setForm(automationDraftFromRecord(record));
    setEditing(record.id);
    setDetailId(null);
    setFormOpen(true);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateAutomationDraft(form);
    if (validation) {
      setError(validation);
      return;
    }
    const data = {
      name: form.name.trim(),
      schedule: cronFromScheduleDraft(form.schedule),
      timezone: form.timezone.trim(),
      enabled: form.enabled,
      workflow: {
        root: form.root.trim(),
        name: form.workflowName.trim(),
        nodes: workflowNodesForApi(form.nodes),
        concurrency: form.concurrency,
      },
    };
    await mutate(
      () => editing ? updateAutomation(editing, data) : createAutomation(data),
      () => {
        resetForm();
        setDetailId(null);
      },
    );
  };

  const selected = items.find((item) => item.id === detailId) ?? null;

  const confirmAction = async () => {
    if (!confirm) return;
    const current = confirm;
    setConfirm(null);
    if (current.kind === "delete") {
      await mutate(() => deleteAutomation(current.record.id), () => {
        if (detailId === current.record.id) setDetailId(null);
      });
    } else if (current.kind === "approve") {
      await mutate(() => approveAutomation(current.record.id, allowReal));
    } else {
      await mutate(() => runAutomation(current.record.id));
    }
  };

  return (
    <section className="xn-automation" data-testid="automations-panel">
      <header className="xn-automation__header">
        <div>
          <h3>{tr("自动化")}</h3>
          <p>{tr("管理定时计划、工作流步骤、审批状态和运行记录。当前支持定时触发。")}</p>
        </div>
        <div className="xn-automation__header-actions">
          <button type="button" disabled={busy} onClick={() => void refresh()}>{tr("刷新")}</button>
          <button type="button" disabled={busy} onClick={beginCreate}>{tr("新建定时计划")}</button>
        </div>
      </header>

      {error && <p className="xn-automation__error" role="alert">{tr("自动化操作失败：")}{error}</p>}

      {formOpen && (
        <AutomationForm
          draft={form}
          setDraft={setForm}
          editing={Boolean(editing)}
          busy={busy}
          onSubmit={(event) => void save(event)}
          onCancel={resetForm}
        />
      )}

      {selected ? (
        <AutomationDetail
          record={selected}
          busy={busy}
          onBack={() => setDetailId(null)}
          onEdit={() => beginEdit(selected)}
          onApprove={() => { setAllowReal(false); setConfirm({ kind: "approve", record: selected }); }}
          onRun={() => setConfirm({ kind: "run", record: selected })}
          onDelete={() => setConfirm({ kind: "delete", record: selected })}
        />
      ) : (
        <section className="xn-automation__list-section" aria-labelledby="xn-automation-list-title">
          <div className="xn-automation__section-heading">
            <h4 id="xn-automation-list-title">{tr("定时计划")} <span>{items.length}</span></h4>
            <p>{tr("计划按本地时间表执行工作流；每次运行都遵循审批策略。")}</p>
          </div>
          {items.length === 0 ? (
            <div className="xn-automation__empty">
              <h4>{tr("没有配置自动化")}</h4>
              <p>{tr("创建基于 Cron 的本地计划，并为它配置可执行的工作流步骤。")}</p>
              <button type="button" onClick={beginCreate}>{tr("新建定时计划")}</button>
            </div>
          ) : (
            <div className="xn-automation__list">
              {items.map((record) => (
                <AutomationCard
                  key={record.id}
                  record={record}
                  busy={busy}
                  onOpen={() => setDetailId(record.id)}
                  onEdit={() => beginEdit(record)}
                  onApprove={() => { setAllowReal(false); setConfirm({ kind: "approve", record }); }}
                  onRun={() => setConfirm({ kind: "run", record })}
                  onDelete={() => setConfirm({ kind: "delete", record })}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {confirm && (
        <div className="xn-automation__backdrop">
          <section role="alertdialog" aria-modal="true" aria-labelledby="xn-automation-confirm-title">
            <h3 id="xn-automation-confirm-title">
              {confirm.kind === "delete" ? tr("删除自动化") : confirm.kind === "approve" ? tr("批准定时计划") : tr("立即运行")}
            </h3>
            <p>
              {confirm.kind === "delete"
                ? tr("删除此计划及其保留的运行记录？")
                : confirm.kind === "approve"
                  ? tr("批准会绑定当前保存的工作流计划；每次运行仍会记录审批状态。")
                  : tr("这会创建一次运行记录。未经批准的计划会进入待审批状态。")}
            </p>
            <strong>{confirm.record.name}</strong>
            {confirm.kind === "approve" && (
              <label className="xn-automation__checkbox">
                <input type="checkbox" checked={allowReal} onChange={(event) => setAllowReal(event.target.checked)} />
                {tr("允许计划调用真实网络（需主机启用）")}
              </label>
            )}
            <div className="xn-automation__dialog-actions">
              <button type="button" disabled={busy} onClick={() => setConfirm(null)}>{tr("取消")}</button>
              <button type="button" disabled={busy} onClick={() => void confirmAction()}>{tr("确认")}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

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
          <span className={`xn-automation__badge ${record.enabled ? "is-enabled" : "is-paused"}`}>{record.enabled ? tr("已启用") : tr("已暂停")}</span>
          <span className={`xn-automation__badge ${record.approved ? "is-approved" : "is-pending"}`}>{approvalLabel(record)}</span>
        </div>
        <p className="xn-automation__schedule">{describeCronSchedule(record.schedule, tr, tf)} <span>·</span> {record.timezone}</p>
        <div className="xn-automation__card-meta">
          <span>{tr("下次运行：")}{record.nextRunAt ? formatDate(record.nextRunAt) : tr("未安排")}</span>
          <span>{tr("工作流：")}{record.workflow.name}</span>
          <span>{record.workflow.nodes.length} {tr("个步骤")}</span>
          <span>{lastRun ? `${tr("最近运行：")}${runStatusLabel(lastRun.status)} · ${formatDate(lastRun.at)}` : tr("尚无运行记录")}</span>
        </div>
      </div>
      <div className="xn-automation__actions">
        <button type="button" onClick={onOpen}>{tr("查看详情和历史")}</button>
        <button type="button" onClick={onEdit}>{tr("编辑")}</button>
        <button type="button" disabled={busy} onClick={onRun}>{tr("立即运行")}</button>
        {!record.approved && <button type="button" disabled={busy} onClick={onApprove}>{tr("批准计划")}</button>}
        <button type="button" disabled={busy} onClick={onDelete}>{tr("删除")}</button>
      </div>
    </article>
  );
}

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
        <div>
          <h4>{record.name}</h4>
          <p>{describeCronSchedule(record.schedule, tr, tf)} <span>·</span> {record.timezone}</p>
        </div>
        <div className="xn-automation__actions">
          <button type="button" onClick={onEdit}>{tr("编辑")}</button>
          <button type="button" disabled={busy} onClick={onRun}>{tr("立即运行")}</button>
          {!record.approved && <button type="button" disabled={busy} onClick={onApprove}>{tr("批准计划")}</button>}
          <button type="button" disabled={busy} onClick={onDelete}>{tr("删除")}</button>
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
                    <pre><code>{Array.isArray(node.argv) ? node.argv.join(" ") : ""}</code></pre>
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
                {run.error && <span className="xn-automation__error-text">{run.error}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function AutomationForm({
  draft,
  setDraft,
  editing,
  busy,
  onSubmit,
  onCancel,
}: {
  draft: AutomationDraft;
  setDraft: React.Dispatch<React.SetStateAction<AutomationDraft>>;
  editing: boolean;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const schedule = draft.schedule;
  const setSchedule = (patch: Partial<AutomationDraft["schedule"]>) => setDraft((current) => ({
    ...current,
    schedule: { ...current.schedule, ...patch },
  }));

  const updateNode = (index: number, patch: Partial<WorkflowNodeDraft>) => setDraft((current) => {
    const before = current.nodes[index];
    if (!before) return current;
    const changed = { ...before, ...patch };
    const previousId = before.id.trim();
    const nextId = changed.id.trim();
    return {
      ...current,
      nodes: current.nodes.map((node, nodeIndex) => {
        if (nodeIndex === index) return changed;
        return previousId !== nextId
          ? { ...node, needs: node.needs.map((dependency) => dependency === previousId ? nextId : dependency) }
          : node;
      }),
    };
  });

  const addNode = () => setDraft((current) => {
    const used = new Set(current.nodes.map((node) => node.id));
    let suffix = current.nodes.length + 1;
    while (used.has(`step-${suffix}`)) suffix += 1;
    return { ...current, nodes: [...current.nodes, newWorkflowNode(`step-${suffix}`)] };
  });

  const removeNode = (index: number) => setDraft((current) => {
    const removedId = current.nodes[index]?.id;
    return {
      ...current,
      nodes: current.nodes.filter((_, nodeIndex) => nodeIndex !== index)
        .map((node) => ({ ...node, needs: node.needs.filter((dependency) => dependency !== removedId) })),
    };
  });

  const preview = (() => {
    try { return describeCronSchedule(cronFromScheduleDraft(schedule), tr, tf); }
    catch { return tr("时间表预览将在字段有效后显示。"); }
  })();

  return (
    <form className="xn-automation__form" onSubmit={onSubmit}>
      <div className="xn-automation__form-header">
        <div><h4>{editing ? tr("编辑自动化") : tr("新建定时计划")}</h4><p>{tr("设置本地时间表，再为计划添加一个或多个真实工作流步骤。")}</p></div>
        <button type="button" onClick={onCancel}>{tr("取消")}</button>
      </div>

      <fieldset className="xn-automation__fieldset">
        <legend>{tr("计划设置")}</legend>
        <label>{tr("名称")}
          <input required maxLength={120} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label>{tr("运行频率")}
          <select value={schedule.mode} onChange={(event) => setSchedule({ mode: event.target.value as ScheduleMode })}>
            <option value="hourly">{tr("每小时")}</option>
            <option value="daily">{tr("每天")}</option>
            <option value="weekdays">{tr("工作日")}</option>
            <option value="weekly">{tr("每周")}</option>
            <option value="custom">{tr("自定义 Cron")}</option>
          </select>
        </label>
        {schedule.mode === "custom" ? (
          <label className="span-two">{tr("Cron 时间表")}
            <input required value={schedule.custom} placeholder="0 9 * * 1-5" onChange={(event) => setSchedule({ custom: event.target.value })} />
            <small>{tr("使用五个字段：分钟、小时、日期、月份、星期。")}</small>
          </label>
        ) : (
          <>
            {schedule.mode !== "hourly" && (
              <label>{tr("小时")}
                <input type="number" min={0} max={23} value={schedule.hour} onChange={(event) => setSchedule({ hour: Number(event.target.value) })} />
              </label>
            )}
            <label>{schedule.mode === "hourly" ? tr("分钟") : tr("分钟")}
              <input type="number" min={0} max={59} value={schedule.minute} onChange={(event) => setSchedule({ minute: Number(event.target.value) })} />
            </label>
            {schedule.mode === "weekly" && (
              <label>{tr("星期")}
                <select value={schedule.weekday} onChange={(event) => setSchedule({ weekday: Number(event.target.value) })}>
                  {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((day, index) => <option key={day} value={index}>{tr(day)}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <label>{tr("时区")}
          <input required value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} placeholder="Asia/Shanghai" />
        </label>
        <label className="xn-automation__checkbox span-two">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
          {tr("启用计划（仍需审批后运行）")}
        </label>
        <p className="xn-automation__schedule-preview span-two">{tr("下次运行计划：")}<strong>{preview}</strong></p>
      </fieldset>

      <fieldset className="xn-automation__fieldset">
        <legend>{tr("工作流")}</legend>
        <label className="span-two">{tr("工作区路径")}
          <input required value={draft.root} onChange={(event) => setDraft((current) => ({ ...current, root: event.target.value }))} placeholder="/path/to/project" />
          <small>{tr("选择已有工作区；各步骤的工作目录必须位于其中。")}</small>
        </label>
        <label>{tr("工作流名称")}
          <input required maxLength={120} value={draft.workflowName} onChange={(event) => setDraft((current) => ({ ...current, workflowName: event.target.value }))} />
        </label>
        <label>{tr("并发数")}
          <input type="number" min={1} max={8} value={draft.concurrency} onChange={(event) => setDraft((current) => ({ ...current, concurrency: Number(event.target.value) }))} />
        </label>
        <div className="xn-automation__nodes-heading span-two">
          <div><h5>{tr("执行步骤")} <span>{draft.nodes.length}</span></h5><p>{tr("可配置命令或代理步骤、依赖、工作目录和超时。")}</p></div>
          <button type="button" disabled={draft.nodes.length >= 64} onClick={addNode}>{tr("添加步骤")}</button>
        </div>
        {draft.nodes.length === 0 && <p className="xn-automation__empty-steps span-two">{tr("至少添加一个执行步骤才能保存计划。")}</p>}
        {draft.nodes.map((node, index) => (
          <WorkflowNodeEditor
            key={`${index}-${node.id}`}
            node={node}
            index={index}
            nodes={draft.nodes}
            onChange={(patch) => updateNode(index, patch)}
            onRemove={() => removeNode(index)}
          />
        ))}
      </fieldset>

      <div className="xn-automation__form-actions">
        <button type="submit" disabled={busy}>{editing ? tr("保存") : tr("创建")}</button>
        <button type="button" disabled={busy} onClick={onCancel}>{tr("取消")}</button>
      </div>
    </form>
  );
}

function WorkflowNodeEditor({
  node,
  index,
  nodes,
  onChange,
  onRemove,
}: {
  node: WorkflowNodeDraft;
  index: number;
  nodes: WorkflowNodeDraft[];
  onChange: (patch: Partial<WorkflowNodeDraft>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const dependencies = nodes.filter((candidate) => candidate.id !== node.id);
  return (
    <fieldset className="xn-automation__node span-two">
      <legend>{tr("步骤")} {index + 1}</legend>
      <div className="xn-automation__node-grid">
        <label>{tr("步骤 ID")}
          <input required maxLength={64} value={node.id} onChange={(event) => onChange({ id: event.target.value })} />
        </label>
        <label>{tr("步骤类型")}
          <select value={node.kind} onChange={(event) => onChange({ kind: event.target.value as WorkflowNodeDraft["kind"] })}>
            <option value="command">{tr("命令")}</option>
            <option value="agent">{tr("代理")}</option>
          </select>
        </label>
        <label>{tr("工作目录（相对路径）")}
          <input required value={node.cwd} onChange={(event) => onChange({ cwd: event.target.value })} placeholder="." />
        </label>
        <label>{tr("超时（秒）")}
          <input type="number" min={1} max={3600} value={node.timeout} onChange={(event) => onChange({ timeout: Number(event.target.value) })} />
        </label>
        <label>{tr("依赖步骤")}
          <select multiple value={node.needs} onChange={(event) => onChange({ needs: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}>
            {dependencies.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
          </select>
          <small>{tr("可用 Ctrl 或 Command 选择多个步骤；空白表示无需等待其他步骤。")}</small>
        </label>
        <label>{tr("阶段名称（可选）")}
          <input maxLength={120} value={node.phase} onChange={(event) => onChange({ phase: event.target.value })} />
        </label>
      </div>

      {node.kind === "command" ? (
        <div className="xn-automation__argv">
          <div className="xn-automation__inline-heading"><h6>{tr("命令参数")}</h6><button type="button" disabled={node.argv.length >= 128} onClick={() => onChange({ argv: [...node.argv, ""] })}>{tr("添加参数")}</button></div>
          <p>{tr("第一项必须是要运行的命令；每项会作为独立参数传给进程。")}</p>
          {node.argv.map((argument, argumentIndex) => (
            <div className="xn-automation__argv-row" key={argumentIndex}>
              <label>{argumentIndex === 0 ? tr("命令") : `${tr("参数")} ${argumentIndex}`}
                <input required={argumentIndex === 0} maxLength={16000} value={argument} onChange={(event) => onChange({ argv: node.argv.map((value, i) => i === argumentIndex ? event.target.value : value) })} />
              </label>
              <button type="button" disabled={node.argv.length <= 1} onClick={() => onChange({ argv: node.argv.filter((_, i) => i !== argumentIndex) })}>{tr("移除参数")}</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="xn-automation__agent-fields">
          <label className="span-two">{tr("代理提示词")}
            <textarea required maxLength={5000} rows={4} value={node.prompt} onChange={(event) => onChange({ prompt: event.target.value })} />
          </label>
          <label>{tr("服务商 ID（可选）")}
            <input maxLength={200} value={node.provider_id} onChange={(event) => onChange({ provider_id: event.target.value })} />
          </label>
          <label>{tr("模型 ID（可选）")}
            <input maxLength={200} value={node.model} onChange={(event) => onChange({ model: event.target.value })} />
          </label>
          <label className="xn-automation__checkbox span-two">
            <input type="checkbox" checked={node.writable} onChange={(event) => onChange({ writable: event.target.checked })} />
            {tr("允许代理步骤写入文件")}
          </label>
        </div>
      )}
      <button type="button" className="xn-automation__remove-node" onClick={onRemove}>{tr("移除此步骤")}</button>
    </fieldset>
  );
}
