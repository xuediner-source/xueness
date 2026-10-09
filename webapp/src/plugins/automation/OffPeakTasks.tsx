import React, { useEffect, useRef, useState, type FormEvent } from "react";
import {
  approveOffPeakTask,
  cancelOffPeakTask,
  createOffPeakTask,
  listOffPeakTasks,
  runOffPeakTask,
  saveOffPeakSettings,
  type OffPeakSettings,
  type OffPeakTaskRecord,
} from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import {
  DEFAULT_OFF_PEAK_WINDOW,
  OFF_PEAK_DEADLINE,
  attemptIds,
  describeWindow,
  emptyOffPeakDraft,
  latestAttempt,
  offPeakDraftForApi,
  pendingNotices,
  queuedCount,
  validateOffPeakDraft,
  validateWindow,
  type OffPeakDraft,
  type OffPeakNotice,
} from "./offPeakModel";

const POLL_MS = 30_000;
const NOTICE_LIMIT = 6;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatTime(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString() : tr("未安排");
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued": return tr("排队中");
    case "running": return tr("正在闲时运行");
    case "completed": return tr("已完成");
    case "cancelled": return tr("已取消");
    case "failed": return tr("失败");
    case "awaiting_approval": return tr("等待批准");
    case "started": return tr("已启动");
    default: return status;
  }
}

function noticeLabel(notice: OffPeakNotice): string {
  if (notice.status === "completed") return tf("「{0}」已在低峰窗口完成。", [notice.name]);
  if (notice.status === "awaiting_approval") return tf("「{0}」已到窗口，但仍在等待你的批准。", [notice.name]);
  return tf("「{0}」本次未能运行：{1}", [notice.name, notice.error || tr("请查看运行历史")]);
}

/**
 * 闲时任务面板（automation.off_peak）。
 *
 * 面板只在所属插件生效时渲染与轮询：`enabled` 为 false 时既不输出界面，也不发
 * 任何请求，因此关闭插件后不会留下后台轮询或新任务。批准、真实服务商调用与工作
 * 区边界仍由主机与队列决定，这里只提供入口。
 */
export function OffPeakTasks({ enabled = false }: { enabled?: boolean }): React.JSX.Element | null {
  const [rows, setRows] = useState<OffPeakTaskRecord[]>([]);
  const [settings, setSettings] = useState<OffPeakSettings>({ window: DEFAULT_OFF_PEAK_WINDOW, timezone: null });
  const [windowOpen, setWindowOpen] = useState(false);
  const [nextWindowAt, setNextWindowAt] = useState<number | null>(null);
  const [draft, setDraft] = useState<OffPeakDraft>(() => emptyOffPeakDraft());
  const [formOpen, setFormOpen] = useState(false);
  const [windowDraft, setWindowDraft] = useState<OffPeakSettings["window"]>(DEFAULT_OFF_PEAK_WINDOW);
  const [timezoneDraft, setTimezoneDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [approveReal, setApproveReal] = useState(true);
  const [notices, setNotices] = useState<OffPeakNotice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const seen = useRef<string[] | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = async (signal?: AbortSignal) => {
    try {
      const payload = await listOffPeakTasks(signal);
      if (!mountedRef.current || signal?.aborted) return;
      setRows(payload.tasks);
      setSettings(payload.settings);
      setWindowOpen(payload.windowOpen === true);
      setNextWindowAt(Number.isFinite(payload.nextWindowAt) ? payload.nextWindowAt : null);
      const known = seen.current;
      if (known === null) {
        // 首次进入只登记已有历史，避免把旧运行当成新的完成通知。
        seen.current = attemptIds(payload.tasks);
      } else {
        const fresh = pendingNotices(payload.tasks, known);
        if (fresh.length > 0) {
          setNotices((current) => [...fresh, ...current].slice(0, NOTICE_LIMIT));
          seen.current = [...known, ...fresh.map((item) => item.attemptId)];
        }
      }
      setError("");
    } catch (cause) {
      if (mountedRef.current && !signal?.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(errorText(cause));
      }
    } finally {
      if (mountedRef.current && !signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [enabled]);

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      if (!mountedRef.current) return;
      await load();
    } catch (cause) {
      if (mountedRef.current) setError(errorText(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invalid = validateOffPeakDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    await mutate(async () => {
      await createOffPeakTask(offPeakDraftForApi(draft));
      setDraft(emptyOffPeakDraft(draft.root));
      setFormOpen(false);
    });
  };

  const saveWindow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invalid = validateWindow(windowDraft);
    if (invalid) {
      setError(invalid);
      return;
    }
    await mutate(async () => {
      const payload = await saveOffPeakSettings(windowDraft, timezoneDraft.trim() || null);
      setSettings(payload.settings);
      setSettingsOpen(false);
    });
  };

  // 窗口草稿只在打开表单时取最新已保存值，后台轮询不会覆盖正在输入的内容。
  const openSettings = () => {
    setWindowDraft(settings.window);
    setTimezoneDraft(settings.timezone ?? "");
    setSettingsOpen((current) => !current);
  };

  if (!enabled) return null;

  return (
    <section className="xn-automation__list-section" data-testid="offpeak-panel" aria-labelledby="xn-offpeak-title">
      <div className="xn-automation__section-heading xn-automation__offpeak-heading">
        <div className="xn-automation__offpeak-intro">
          <div className="xn-automation__offpeak-title">
            <h4 id="xn-offpeak-title">{tr("闲时任务")} <span>{queuedCount(rows)}</span></h4>
            <span className={"xn-automation__window-status" + (windowOpen ? " is-open" : "")}>
              <span aria-hidden="true" />{windowOpen ? tr("窗口内") : tr("等待窗口")}
            </span>
          </div>
          <p>{tr("把不急的任务排到本地低峰窗口，由现有自动化调度在窗口内按队列依次执行；未批准的计划不会无人值守运行。")}</p>
          <div className="xn-automation__window-summary" role="status">
            <span><strong>{tr("窗口")}</strong>{describeWindow(settings.window, tr)}{settings.timezone ? " · " + settings.timezone : ""}</span>
            {nextWindowAt && !windowOpen && <span><strong>{tr("下次开启")}</strong>{formatTime(nextWindowAt)}</span>}
          </div>
        </div>
        <div className="xn-automation__header-actions">
          <button type="button" disabled={busy} onClick={() => void load()}>{tr("刷新")}</button>
          <button type="button" disabled={busy} onClick={openSettings}>{tr("设置闲时窗口")}</button>
          <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={() => setFormOpen((current) => !current)}>{tr("排入闲时任务")}</button>
        </div>
      </div>

      {error && <p className="xn-automation__error" role="alert">{tr("闲时任务操作失败：")}{error}</p>}

      {notices.length > 0 && (
        <div className="xn-automation__card" role="status" aria-live="polite">
          {notices.map((notice) => (
            <p className="xn-automation__notice" key={notice.attemptId}>
              {noticeLabel(notice)}
              {notice.workflowId && <> {tr("工作流运行 ID：")}<code>{notice.workflowId}</code></>}
              {" "}{formatTime(notice.at)}
              <button type="button" onClick={() => setNotices((current) => current.filter((item) => item.attemptId !== notice.attemptId))}>{tr("知道了")}</button>
            </p>
          ))}
        </div>
      )}

      {settingsOpen && (
        <form className="xn-automation__form xn-automation__offpeak-form" onSubmit={(event) => void saveWindow(event)}>
          <div className="xn-automation__form-header">
            <div><h4>{tr("闲时窗口")}</h4><p>{tr("窗口按本地时间计算，可以跨越午夜；这里的改动只影响排队的闲时任务。")}</p></div>
            <button type="button" onClick={() => setSettingsOpen(false)}>{tr("取消")}</button>
          </div>
          <label>{tr("开始时间（HH:MM）")}
            <input required value={windowDraft.start} onChange={(event) => setWindowDraft((current) => ({ ...current, start: event.target.value }))} placeholder="00:00" />
          </label>
          <label>{tr("结束时间（HH:MM）")}
            <input required value={windowDraft.end} onChange={(event) => setWindowDraft((current) => ({ ...current, end: event.target.value }))} placeholder="08:00" />
          </label>
          <label>{tr("时区（可选）")}
            <input value={timezoneDraft} onChange={(event) => setTimezoneDraft(event.target.value)} placeholder="Asia/Shanghai" />
            <small>{tr("留空时使用运行本程序的主机本地时间。")}</small>
          </label>
          <div className="xn-automation__form-actions">
            <button type="submit" className="xn-automation__button--primary" disabled={busy}>{tr("保存窗口")}</button>
          </div>
        </form>
      )}

      {formOpen && (
        <form className="xn-automation__form xn-automation__offpeak-form" onSubmit={(event) => void create(event)}>
          <div className="xn-automation__form-header">
            <div><h4>{tr("排入闲时任务")}</h4><p>{tr("任务说明会作为一次单步代理运行的提示词；运行时遵循当前工作区与审批边界。")}</p></div>
            <button type="button" onClick={() => setFormOpen(false)}>{tr("取消")}</button>
          </div>
          <label>{tr("任务名称（可选）")}
            <input maxLength={120} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="span-two">{tr("任务说明")}
            <textarea required rows={3} maxLength={5_000} value={draft.prompt}
              onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} />
            <small>{tr("写清要交付的结果；不要在说明里再排新任务。")}</small>
          </label>
          <label className="span-two">{tr("工作区路径")}
            <input required value={draft.root} onChange={(event) => setDraft((current) => ({ ...current, root: event.target.value }))} placeholder="/path/to/project" />
          </label>
          <label>{tr("模型 ID（可选）")}
            <input maxLength={200} value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} />
          </label>
          <label>{tr("单次运行超时（秒）")}
            <input type="number" min={OFF_PEAK_DEADLINE.min} max={OFF_PEAK_DEADLINE.max} step={60} value={draft.deadlineSeconds}
              onChange={(event) => setDraft((current) => ({ ...current, deadlineSeconds: Number(event.target.value) }))} />
          </label>
          <label className="xn-automation__checkbox span-two">
            <input type="checkbox" checked={draft.onlyWhenIdle} onChange={(event) => setDraft((current) => ({ ...current, onlyWhenIdle: event.target.checked }))} />
            {tr("仅在空闲时（本机没有其他运行时才开始）")}
          </label>
          <label className="xn-automation__checkbox span-two">
            <input type="checkbox" checked={draft.approveExecution} onChange={(event) => setDraft((current) => ({ ...current, approveExecution: event.target.checked }))} />
            {tr("批准该不可变计划在窗口内无人值守执行")}
          </label>
          <label className="xn-automation__checkbox span-two">
            <input type="checkbox" checked={draft.allowReal} onChange={(event) => setDraft((current) => ({ ...current, allowReal: event.target.checked }))} />
            {tr("允许调用真实服务商（仍需主机开启）")}
          </label>
          <div className="xn-automation__form-actions">
            <button type="submit" className="xn-automation__button--primary" disabled={busy}>{tr("排入队列")}</button>
            <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>{tr("取消")}</button>
          </div>
        </form>
      )}

      {loading && rows.length === 0 ? (
        <div className="xn-automation__empty xn-automation__loading" role="status" aria-live="polite">
          <span className="xn-automation__loading-mark" aria-hidden="true" />
          <span>{tr("正在加载队列…")}</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="xn-automation__empty">
          <h4>{tr("队列是空的")}</h4>
          <p>{tr("排入一个不急的任务，让它在本地低峰窗口里完成。")}</p>
        </div>
      ) : (
        <div className="xn-automation__list">
          {rows.map((row) => (
            <OffPeakTaskCard
              key={row.id}
              row={row}
              busy={busy}
              approving={approving === row.id}
              approveReal={approveReal}
              onApproveReal={setApproveReal}
              onBeginApprove={() => { setApproving(row.id); setApproveReal(true); setError(""); }}
              onCancelApprove={() => setApproving(null)}
              onApprove={() => void mutate(async () => {
                await approveOffPeakTask(row.id, approveReal);
                setApproving(null);
              })}
              onRun={() => void mutate(() => runOffPeakTask(row.id))}
              onCancel={() => void mutate(() => cancelOffPeakTask(row.id))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function OffPeakTaskCard({
  row,
  busy,
  approving,
  approveReal,
  onApproveReal,
  onBeginApprove,
  onCancelApprove,
  onApprove,
  onRun,
  onCancel,
}: {
  row: OffPeakTaskRecord;
  busy: boolean;
  approving: boolean;
  approveReal: boolean;
  onApproveReal: (value: boolean) => void;
  onBeginApprove: () => void;
  onCancelApprove: () => void;
  onApprove: () => void;
  onRun: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const attempt = latestAttempt(row);
  const terminal = row.status === "completed" || row.status === "cancelled";
  const settings = settingsSummary(row);
  return (
    <article className="xn-automation__card">
      <div className="xn-automation__card-main">
        <div className="xn-automation__card-title-row">
          <h4>{row.name}</h4>
          <span className={`xn-automation__badge status-${row.status}`}>{statusLabel(row.status)}</span>
          <span className={`xn-automation__badge ${row.approved ? "is-approved" : "is-pending"}`}>
            {row.approved ? tr("计划已批准") : tr("待审批")}
          </span>
          {row.onlyWhenIdle && <span className="xn-automation__badge is-pending">{tr("仅在空闲时")}</span>}
        </div>
        <p className="xn-automation__prompt">{row.prompt}</p>
        <div className="xn-automation__card-meta">
          <span>{tr("工作区：")}<code>{row.root}</code></span>
          {row.model && <span>{tr("模型：")}{row.model}</span>}
          <span>{tr("超时：")}{row.deadlineSeconds}{tr(" 秒")}</span>
          <span>{tr("窗口：")}{row.window ? describeWindow(row.window, tr) : tr("跟随全局")}</span>
          {settings && <span>{settings}</span>}
          <span>{tr("不可变计划摘要：")}<code>{row.digest.slice(0, 12)}</code></span>
          {attempt && (
            <span>
              {statusLabel(attempt.status)} · {formatTime(attempt.at)}
              {attempt.workflowId && <> {tr("工作流运行 ID：")}<code>{attempt.workflowId}</code></>}
              {attempt.error && <span className="xn-automation__error-text">{attempt.error}</span>}
            </span>
          )}
          {row.status === "queued" && row.holdUntil && (
            <span>{tr("最早在窗口再次开启时尝试：")}{formatTime(row.holdUntil)}</span>
          )}
        </div>
      </div>
      <div className="xn-automation__actions">
        {!row.approved && !approving && row.status === "queued" && (
          <button type="button" disabled={busy} onClick={onBeginApprove}>{tr("批准计划")}</button>
        )}
        {approving && (
          <div className="xn-automation__approval-controls">
            <label>
              <input type="checkbox" checked={approveReal} onChange={(event) => onApproveReal(event.target.checked)} />
              {tr("同时允许调用真实服务商（仍需主机开启）")}
            </label>
            <button type="button" className="xn-automation__button--primary" disabled={busy} onClick={onApprove}>{tr("确认批准")}</button>
            <button type="button" disabled={busy} onClick={onCancelApprove}>{tr("取消")}</button>
          </div>
        )}
        {!terminal && <button type="button" className={row.approved ? "xn-automation__button--primary" : undefined} disabled={busy} onClick={onRun}>{tr("立即运行一次")}</button>}
        {!terminal && <button type="button" className="xn-automation__button--quiet-danger" disabled={busy} onClick={onCancel}>{tr("取消任务")}</button>}
      </div>
    </article>
  );
}

function settingsSummary(row: OffPeakTaskRecord): string {
  if (row.status !== "running") return "";
  if (!row.claimedAt) return "";
  return tf("开始于 {0}", [formatTime(row.claimedAt)]);
}
