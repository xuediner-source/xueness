import { t as tr } from "../../i18n";

export function formatTaskDuration(startedAt?: number | null, endedAt?: number | null): string {
  if (!startedAt || typeof startedAt !== "number" || startedAt <= 0) return "-";
  const end = typeof endedAt === "number" && endedAt > 0 ? endedAt : Date.now() / 1000;
  const diff = Math.max(0, end - startedAt);
  if (diff < 1) return "< 1s";
  if (diff < 60) return `${diff.toFixed(1)}s`;
  const mins = Math.floor(diff / 60);
  const secs = Math.floor(diff % 60);
  return `${mins}m ${secs}s`;
}

export function formatTaskStatus(status: string): { label: string; tone: "ok" | "warn" | "error" | "muted" } {
  switch (status) {
    case "running":
      return { label: tr("运行中"), tone: "warn" };
    case "completed":
      return { label: tr("已完成"), tone: "ok" };
    case "failed":
      return { label: tr("失败"), tone: "error" };
    case "cancelled":
      return { label: tr("已取消"), tone: "muted" };
    default:
      return { label: status, tone: "muted" };
  }
}
