import React from "react";
import { t as tr, tf } from "../../i18n";
import { asJudgeRecord, type JudgeRecord } from "./toolJudgeApi";
import "./tool-judge.css";

type Tone = "info" | "warn" | "danger";

function describe(record: JudgeRecord): { label: string; tone: Tone } | null {
  switch (record.verdict) {
    case "advise": return { label: tr("判定：建议"), tone: "info" };
    case "repair": return record.applied === "repaired" ? { label: tr("已修正"), tone: "warn" } : { label: tr("判定：建议修正"), tone: "info" };
    case "reject":
      if (record.model === "preflight") return { label: tr("前置检查已拦下"), tone: "danger" };
      return record.applied === "rejected" ? { label: tr("已拦下"), tone: "danger" } : { label: tr("判定：建议拦下"), tone: "info" };
    case "unavailable": return { label: tr("判定超时"), tone: "info" };
    default: return record.retryOfReject ? { label: tr("原样重试，已放行"), tone: "info" } : null;
  }
}

/** One compact badge on a tool row; a plain pass shows nothing. The title carries the reason and, for a repair, the original arguments. */
export function ToolJudgeBadge({ judge }: { judge: unknown }): React.JSX.Element | null {
  const record = asJudgeRecord(judge);
  const shown = record ? describe(record) : null;
  if (!record || !shown) return null;
  const lines = [record.reason || tr("没有给出理由"), record.model === "preflight" ? tr("检查来源：零模型前置检查") : record.model ? tf("判定模型：{0}", [record.model]) : "", record.judgeMs > 0 ? tf("判定耗时 {0} 毫秒", [Math.round(record.judgeMs)]) : ""];
  if (record.original) {
    let original = "";
    try { original = JSON.stringify(record.original, null, 2).slice(0, 1200); } catch { original = ""; }
    if (original) lines.push(`${tr("原参数")}\n${original}`);
  }
  return <span className="xn-judge-badge" data-tone={shown.tone} title={lines.filter(Boolean).join("\n")} data-testid="tool-judge-badge">{shown.label}</span>;
}

export default ToolJudgeBadge;
