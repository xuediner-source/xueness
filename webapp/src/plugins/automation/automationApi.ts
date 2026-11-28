import { del, get, post } from "../../xuenessBridge";

export type AutomationRecord = {
  id: string; name: string; schedule: string; timezone: string; enabled: boolean;
  workflow: { root: string; name: string; nodes: unknown[]; concurrency?: number };
  approvalRequired: true; approved?: boolean; allowReal?: boolean; nextRunAt: number;
  history: { id: string; at: number; status: string; workflowId?: string; error?: string }[];
};

/** One queued 闲时任务 and its bounded per-attempt history. */
export type OffPeakTaskRecord = {
  id: string; name: string; prompt: string; root: string;
  model: string | null; provider_id: string | null; deadlineSeconds: number;
  onlyWhenIdle: boolean; window: { start: string; end: string } | null; timezone: string | null;
  status: string; createdAt: number; nextEligibleAt: number; holdUntil: number | null;
  approved: boolean; allowReal: boolean; runId: string | null; workflowId: string | null;
  claimedAt: number | null; finishedAt: number | null; digest: string;
  history: { id: string; at: number; status: string; workflowId?: string; error?: string }[];
};

export type OffPeakSettings = {
  window: { start: string; end: string };
  timezone: string | null;
};

export type OffPeakOverview = {
  tasks: OffPeakTaskRecord[];
  settings: OffPeakSettings;
  windowOpen: boolean;
  nextWindowAt: number;
};

export async function listAutomations(signal?: AbortSignal): Promise<{ automations: AutomationRecord[] }> {
  const payload = await get<{ automations: AutomationRecord[] }>("/api/automations", signal);
  if (!Array.isArray(payload.automations)) throw new Error("Invalid automations response");
  return { automations: payload.automations };
}

export async function createAutomation(data: Omit<AutomationRecord, "id" | "approvalRequired" | "nextRunAt" | "history">): Promise<{ automation: AutomationRecord }> {
  return post<{ automation: AutomationRecord }>("/api/automations", data);
}

export async function updateAutomation(id: string, data: Partial<AutomationRecord>): Promise<{ automation: AutomationRecord }> {
  return post<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}`, data);
}

export async function deleteAutomation(id: string): Promise<{ deleted: string }> {
  return del<{ deleted: string }>(`/api/automations/${encodeURIComponent(id)}`);
}

export async function runAutomation(id: string): Promise<{ run: AutomationRecord["history"][number] & { workflowId: string } }> {
  return post<{ run: AutomationRecord["history"][number] & { workflowId: string } }>(`/api/automations/${encodeURIComponent(id)}/run`, {});
}

export async function approveAutomation(id: string, allowReal: boolean): Promise<{ automation: AutomationRecord }> {
  return post<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}/approve`, { confirmed: true, allowReal });
}

/* 闲时任务（automation.off_peak）：本地低峰窗口队列，纯数据，不引入可执行配置。 */
export async function listOffPeakTasks(signal?: AbortSignal): Promise<OffPeakOverview> {
  const payload = await get<OffPeakOverview>("/api/automation/offpeak", signal);
  if (!Array.isArray(payload.tasks)) throw new Error("Invalid off-peak queue response");
  return payload;
}

export async function createOffPeakTask(data: Record<string, unknown>): Promise<{ task: OffPeakTaskRecord }> {
  return post<{ task: OffPeakTaskRecord }>("/api/automation/offpeak", data);
}

export async function cancelOffPeakTask(id: string): Promise<{ cancelled: string }> {
  return del<{ cancelled: string }>(`/api/automation/offpeak/${encodeURIComponent(id)}`);
}

export async function runOffPeakTask(id: string): Promise<{ result: { id: string; status: string; error?: string; workflowId?: string } }> {
  return post<{ result: { id: string; status: string; error?: string; workflowId?: string } }>(`/api/automation/offpeak/${encodeURIComponent(id)}/run`, {});
}

/** 批准绑定已保存计划的摘要；真实服务商仍由主机决定是否放行。 */
export async function approveOffPeakTask(id: string, allowReal: boolean): Promise<{ task: OffPeakTaskRecord }> {
  return post<{ task: OffPeakTaskRecord }>(`/api/automation/offpeak/${encodeURIComponent(id)}/approve`, { confirmed: true, allowReal });
}

export async function saveOffPeakSettings(window: OffPeakSettings["window"], timezone: string | null): Promise<{ settings: OffPeakSettings }> {
  return post<{ settings: OffPeakSettings }>("/api/automation/offpeak/settings", { window, timezone });
}
