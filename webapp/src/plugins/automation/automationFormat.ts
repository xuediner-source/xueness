import type { AutomationRecord } from "../../xuenessApi";
import { t as tr } from "../../i18n";

export function formatDate(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString() : tr("未安排");
}

export function approvalLabel(record: AutomationRecord): string {
  return record.approved ? tr("计划已批准") : tr("待审批");
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case "claimed": return tr("等待调度");
    case "awaiting_approval": return tr("等待运行审批");
    case "started": return tr("已启动");
    case "failed": return tr("启动失败");
    default: return status;
  }
}
