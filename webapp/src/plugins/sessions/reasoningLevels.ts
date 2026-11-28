import { t as tr } from "../../i18n";

/** Whether a level means "reasoning off" (kept gray, no energy tint). */
export function reasoningSliderIsOffLevel(level: string | undefined): boolean {
  if (!level) return false;
  const flat = level.replace(/\s+/g, "").toLowerCase();
  return flat === "off" || flat === "none" || flat === "关闭" || flat === "无" || flat === "disable" || flat === "disabled";
}

export function normalizeReasoningLevels(levels: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const level of levels ?? []) {
    if (typeof level !== "string") continue;
    const value = level.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function reasoningEffortLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    none: "关闭思考", minimal: "极低", low: "低", medium: "中等",
    high: "高", xhigh: "极高", max: "最高",
  };
  return value ? tr(labels[value] ?? value) : tr("默认");
}
