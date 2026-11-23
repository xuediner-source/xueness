import React, { type FormEvent } from "react";
import { t as tr, tf } from "../../i18n";
import {
  cronFromScheduleDraft,
  describeCronSchedule,
  newWorkflowNode,
  type AutomationDraft,
  type ScheduleMode,
  type WorkflowNodeDraft,
} from "./automationModel";

export function AutomationForm({
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
        <button type="submit" className="xn-automation__button--primary" disabled={busy}>{editing ? tr("保存") : tr("创建")}</button>
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
