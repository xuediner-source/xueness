import type { OffPeakSettings, OffPeakTaskRecord } from "../../xuenessApi";

/**
 * Pure data helpers behind the 闲时任务 panel: the same limits the off-peak queue
 * applies on the host, so a draft is rejected before it costs a request. Nothing
 * here starts a timer, a request or a run — the scheduler owns execution.
 */

export type OffPeakDraft = {
  name: string;
  prompt: string;
  root: string;
  model: string;
  deadlineSeconds: number;
  onlyWhenIdle: boolean;
  approveExecution: boolean;
  allowReal: boolean;
};

export const DEFAULT_OFF_PEAK_WINDOW: OffPeakSettings["window"] = { start: "00:00", end: "08:00" };
export const OFF_PEAK_DEADLINE = { min: 60, max: 14_400, fallback: 3_600 };
export const OFF_PEAK_MAX_TASKS = 50;

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ABSOLUTE_ROOT = /^(?:[A-Za-z]:[\\/]|[\\/])/;
/** Outcomes worth telling the operator about once the queue settles a run. */
const NOTABLE = new Set(["completed", "failed", "awaiting_approval"]);

export function emptyOffPeakDraft(root = ""): OffPeakDraft {
  return {
    name: "",
    prompt: "",
    root,
    model: "",
    deadlineSeconds: OFF_PEAK_DEADLINE.fallback,
    onlyWhenIdle: false,
    approveExecution: false,
    allowReal: false,
  };
}

/** Same rule as the host: an equal start and end is an empty window, never all day. */
export function validateWindow(window: OffPeakSettings["window"]): string | null {
  if (!CLOCK.test(window.start) || !CLOCK.test(window.end)) return "窗口时间需要是 HH:MM。";
  if (window.start === window.end) return "窗口的开始与结束时间不能相同。";
  return null;
}

export function windowSpansMidnight(window: OffPeakSettings["window"]): boolean {
  return window.start > window.end;
}

export function describeWindow(
  window: OffPeakSettings["window"],
  translate: (key: string) => string = (key) => key,
): string {
  const base = `${window.start}–${window.end}`;
  return windowSpansMidnight(window) ? `${base}${translate("（跨午夜）")}` : base;
}

export function validateOffPeakDraft(draft: OffPeakDraft): string | null {
  const prompt = draft.prompt.trim();
  if (!prompt) return "请填写要延迟执行的任务说明。";
  if (prompt.length > 5_000) return "任务说明最多 5000 个字符。";
  if (draft.name.trim().length > 120) return "任务名称最多 120 个字符。";
  const root = draft.root.trim();
  if (!root) return "请填写工作区路径。";
  if (!ABSOLUTE_ROOT.test(root)) return "工作区路径需要是绝对路径。";
  if (draft.model.trim().length > 200) return "模型 ID 最多 200 个字符。";
  if (!Number.isInteger(draft.deadlineSeconds)
    || draft.deadlineSeconds < OFF_PEAK_DEADLINE.min || draft.deadlineSeconds > OFF_PEAK_DEADLINE.max) {
    return `超时需要是 ${OFF_PEAK_DEADLINE.min} 到 ${OFF_PEAK_DEADLINE.max} 秒的整数。`;
  }
  if (draft.allowReal && !draft.approveExecution) return "允许真实服务商前，需要先批准该不可变计划。";
  return null;
}

/** The request body the queue accepts; optional fields stay absent when unused. */
export function offPeakDraftForApi(draft: OffPeakDraft): Record<string, unknown> {
  const value: Record<string, unknown> = {
    prompt: draft.prompt.trim(),
    root: draft.root.trim(),
    deadlineSeconds: draft.deadlineSeconds,
    onlyWhenIdle: draft.onlyWhenIdle,
    confirm: draft.approveExecution,
    allowReal: draft.allowReal,
  };
  if (draft.name.trim()) value.name = draft.name.trim();
  if (draft.model.trim()) value.model = draft.model.trim();
  return value;
}

export function latestAttempt(row: OffPeakTaskRecord) {
  return row.history[row.history.length - 1] ?? null;
}

export function attemptIds(rows: OffPeakTaskRecord[]): string[] {
  return rows.map((row) => latestAttempt(row)?.id).filter((id): id is string => Boolean(id));
}

export type OffPeakNotice = {
  taskId: string;
  name: string;
  attemptId: string;
  status: string;
  at: number;
  workflowId?: string;
  error?: string;
};

/**
 * One notice per settled attempt, and never a notice for history the operator has
 * already seen — the first load only records what is already there.
 */
export function pendingNotices(rows: OffPeakTaskRecord[], seen: readonly string[]): OffPeakNotice[] {
  const known = new Set(seen);
  const notices: OffPeakNotice[] = [];
  for (const row of rows) {
    const attempt = latestAttempt(row);
    if (!attempt || known.has(attempt.id) || !NOTABLE.has(attempt.status)) continue;
    notices.push({
      taskId: row.id,
      name: row.name,
      attemptId: attempt.id,
      status: attempt.status,
      at: attempt.at,
      ...(attempt.workflowId ? { workflowId: attempt.workflowId } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
    });
  }
  return notices;
}

export function queuedCount(rows: OffPeakTaskRecord[]): number {
  return rows.filter((row) => row.status === "queued").length;
}
