import React, { useEffect, useRef, useState, type FormEvent } from "react";
import {
  approveAutomation,
  createAutomation,
  deleteAutomation,
  listAutomations,
  runAutomation,
  updateAutomation,
  type AutomationRecord,
} from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { OffPeakTasks } from "./OffPeakTasks";
import {
  automationDraftFromRecord,
  cronFromScheduleDraft,
  emptyAutomationDraft,
  validateAutomationDraft,
  workflowNodesForApi,
  type AutomationDraft,
} from "./automationModel";
import { AutomationCard } from "./AutomationCard";
import { AutomationDetail } from "./AutomationDetail";
import { AutomationForm } from "./AutomationForm";
import "../../styles/automation.css";

import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";

export { AutomationCard } from "./AutomationCard";
export { AutomationDetail } from "./AutomationDetail";

type ConfirmAction = { kind: "approve" | "delete" | "run"; record: AutomationRecord };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function XuenessAutomationsPanel({
  offPeakEnabled = false, embedded = false,
}: {
  /** 闲时任务区块只在 automation 插件生效时渲染；默认关闭，容器传入实际归属。
   * `embedded`: inside a settings page that already shows the title, so only the actions stay. */
  offPeakEnabled?: boolean; embedded?: boolean;
}): React.JSX.Element {
  const [items, setItems] = useState<AutomationRecord[]>([]);
  const [form, setForm] = useState<AutomationDraft>(() => emptyAutomationDraft());
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [allowReal, setAllowReal] = useState(false);
  const confirmDialogRef = useRef<HTMLElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  useModalFocusScope({ open: confirm !== null, dialogRef: confirmDialogRef, initialFocusRef: confirmCancelRef });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await listAutomations();
      if (!mountedRef.current) return;
      setItems(res.automations);
      setError("");
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };
  useEffect(() => { void refresh(); }, []);

  const mutate = async (operation: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      if (!mountedRef.current) return;
      await refresh();
      if (!mountedRef.current) return;
      after?.();
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
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
  const enabledCount = items.filter((item) => item.enabled).length;
  const approvalCount = items.filter((item) => !item.approved).length;

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
    <section className="xn-automation" data-testid="automations-panel" data-embedded={embedded || undefined} aria-labelledby={embedded ? undefined : "xn-automation-title"} aria-label={embedded ? tr("自动化") : undefined}>
      <header className="xn-automation__header">
        {embedded ? <p className="xn-automation__lede">{tr("管理定时计划、工作流步骤、审批状态和运行记录。当前支持定时触发。")}</p> : <div>
          <span className="xn-automation__eyebrow">{tr("本地计划")}</span>
          <h3 id="xn-automation-title">{tr("自动化")}</h3>
          <p>{tr("管理定时计划、工作流步骤、审批状态和运行记录。当前支持定时触发。")}</p>
        </div>}
        <div className="xn-automation__header-actions">
          <button type="button" disabled={busy || refreshing} onClick={() => void refresh()} aria-busy={refreshing}>
            {refreshing ? tr("正在刷新…") : tr("刷新")}
          </button>
          <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={beginCreate}>{tr("新建定时计划")}</button>
        </div>
      </header>

      <div className="xn-automation__overview" role="group" aria-label={tr("计划概览")} data-testid="automation-overview">
        <div className="xn-automation__metric"><span>{tr("计划总数")}</span><strong>{loading ? "—" : items.length}</strong></div>
        <div className="xn-automation__metric"><span>{tr("已启用")}</span><strong>{loading ? "—" : enabledCount}</strong></div>
        <div className="xn-automation__metric"><span>{tr("待审批")}</span><strong>{loading ? "—" : approvalCount}</strong></div>
        <p className="xn-automation__overview-note">{tr("计划按时区运行；执行前仍遵循审批策略。")}</p>
      </div>

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
        <>
        <section className="xn-automation__list-section" aria-labelledby="xn-automation-list-title">
          <div className="xn-automation__section-heading">
            <h4 id="xn-automation-list-title">{tr("定时计划")} <span>{loading ? "—" : items.length}</span></h4>
            <p>{tr("计划按本地时间表执行工作流；每次运行都遵循审批策略。")}</p>
          </div>
          {loading && items.length === 0 ? (
            <div className="xn-automation__empty xn-automation__loading" role="status" aria-live="polite">
              <span className="xn-automation__loading-mark" aria-hidden="true" />
              <span>{tr("正在加载计划…")}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="xn-automation__empty">
              <h4>{tr("没有配置自动化")}</h4>
              <p>{tr("创建基于 Cron 的本地计划，并为它配置可执行的工作流步骤。")}</p>
              <button type="button" className="xn-automation__button--primary" onClick={beginCreate}>{tr("新建定时计划")}</button>
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
        <OffPeakTasks enabled={offPeakEnabled} />
        </>
      )}

      {confirm && (
        <div className="xn-automation__backdrop">
          <section ref={confirmDialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="xn-automation-confirm-title" aria-describedby="xn-automation-confirm-description" onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (shouldDismissModalOnEscape(event, busy)) { event.preventDefault(); setConfirm(null); }
          }}>
            <h3 id="xn-automation-confirm-title">
              {confirm.kind === "delete" ? tr("删除自动化") : confirm.kind === "approve" ? tr("批准定时计划") : tr("立即运行")}
            </h3>
            <p id="xn-automation-confirm-description">
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
              <button ref={confirmCancelRef} type="button" disabled={busy} onClick={() => setConfirm(null)}>{tr("取消")}</button>
              <button type="button" className={confirm.kind === "delete" ? "xn-automation__button--danger" : "xn-automation__button--primary"} disabled={busy} onClick={() => void confirmAction()}>{tr("确认")}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
