import React from "react";
import { t as tr, tf } from "../../i18n";
import type { UsageToolOutcomes, UsageToolOutcomeTotals } from "../../xuenessApi";

/**
 * How often tool calls failed in the selected range, why, and what the
 * failures cost. "Avoidable" failures are the ones a check before execution
 * (or a decision model) could have stopped; policy refusals and interruptions
 * are shown but are not counted as avoidable. The recovery time is an
 * estimate (the share of the following model request spent on the failed
 * calls); tool time and parse-repair time are measured.
 */
const GROUP_LABELS: Record<string, string> = {
  arguments: "参数错误", edit_mismatch: "编辑未匹配", unknown_tool: "未知工具", path: "路径问题", command: "命令写法错误",
  network: "网络错误", command_exit: "命令返回非零", policy: "权限与审批", interrupted: "中断", other: "其他",
};

function seconds(ms: number, locale: "zh" | "en"): string {
  const value = ms / 1000;
  if (value < 60) return tf("{0} 秒", [value.toLocaleString(locale === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: value < 10 ? 1 : 0 })]);
  const minutes = Math.floor(value / 60), rest = Math.round(value % 60);
  return tf("{0} 分 {1} 秒", [minutes, rest]);
}

const percent = (part: number, whole: number): string => whole > 0 ? `${Math.round(part / whole * 1000) / 10}%` : "—";
const lost = (row: Pick<UsageToolOutcomeTotals, "failedToolMs" | "recoveryMs" | "protocolMs">): number => row.failedToolMs + row.recoveryMs + row.protocolMs;

export function UsageToolOutcomes({ report, locale }: { report: UsageToolOutcomes; locale: "zh" | "en" }): React.JSX.Element {
  const { total } = report;
  const largest = Math.max(1, ...report.groups.map((group) => group.failed));
  return (
    <section className="xn-usage-settings__card xn-usage-outcomes" aria-labelledby="xn-usage-outcomes-title" data-testid="xn-usage-tool-outcomes">
      <div className="xn-usage-settings__card-heading">
        <div>
          <h2 id="xn-usage-outcomes-title">{tr("工具调用")}</h2>
          <p>{tr("统计工具调用失败的原因与耗时。可避免的失败是调用前检查或决策模型可以挡下的部分；权限、审批和中断不计入。")}</p>
        </div>
        <span className="xn-usage-settings__model-total">{tf("{0} 个会话", [report.sessions])}</span>
      </div>
      <div className="xn-usage-outcomes__stats">
        <OutcomeStat value={total.calls.toLocaleString()} label={tr("次调用")} />
        <OutcomeStat value={total.failed.toLocaleString()} label={tf("次失败（{0}）", [percent(total.failed, total.calls)])} />
        <OutcomeStat value={total.avoidable.toLocaleString()} label={tf("次可避免（{0}）", [percent(total.avoidable, total.calls)])} tone={total.avoidable > 0 ? "warn" : undefined} />
        <OutcomeStat value={seconds(lost(total), locale)} label={tr("失败多花的时间")} tone={lost(total) > 0 ? "warn" : undefined} />
      </div>
      <p className="xn-usage-outcomes__breakdown">
        {tf("失败的工具本身 {0} · 读错误后重新请求（估算）{1} · 模型输出无法解析为工具调用 {2} 次、{3}", [seconds(total.failedToolMs, locale), seconds(total.recoveryMs, locale), total.protocolRepairs, seconds(total.protocolMs, locale)])}
      </p>
      {report.groups.length > 0 ? (
        <div className="xn-usage-outcomes__groups" role="list" aria-label={tr("失败原因")}>
          {report.groups.map((group) => (
            <div key={group.group} className="xn-usage-outcomes__group" role="listitem" data-avoidable={group.avoidable || undefined}>
              <span className="xn-usage-outcomes__label">{tr(GROUP_LABELS[group.group] ?? group.group)}{group.avoidable && <small>{tr("可避免")}</small>}</span>
              <span className="xn-usage-outcomes__meter" aria-hidden="true"><span style={{ width: `${Math.max(3, group.failed / largest * 100)}%` }} /></span>
              <span className="xn-usage-outcomes__value">{tf("{0} 次", [group.failed])}</span>
              <span className="xn-usage-outcomes__value">{seconds(group.failedToolMs + group.recoveryMs, locale)}</span>
            </div>
          ))}
        </div>
      ) : <div className="xn-usage-settings__empty-chart">{tr("此周期没有失败的工具调用")}</div>}
      {(report.tools.some((tool) => tool.failed > 0) || report.models.length > 0) && (
        <div className="xn-usage-outcomes__tables">
          {report.tools.some((tool) => tool.failed > 0) && (
            <table>
              <caption>{tr("失败最多的工具")}</caption>
              <thead><tr><th scope="col">{tr("工具")}</th><th scope="col">{tr("失败 / 调用")}</th><th scope="col">{tr("失败率")}</th></tr></thead>
              <tbody>{report.tools.filter((tool) => tool.failed > 0).slice(0, 8).map((tool) => (
                <tr key={tool.name}><td><code>{tool.name}</code></td><td>{tool.failed} / {tool.calls}</td><td>{percent(tool.failed, tool.calls)}</td></tr>
              ))}</tbody>
            </table>
          )}
          {report.models.length > 0 && (
            <table>
              <caption>{tr("按模型")}</caption>
              <thead><tr><th scope="col">{tr("模型")}</th><th scope="col">{tr("失败率")}</th><th scope="col">{tr("可避免")}</th><th scope="col">{tr("多花时间")}</th></tr></thead>
              <tbody>{report.models.map((model) => (
                <tr key={model.model}><td title={model.model}>{model.model}</td><td>{percent(model.failed, model.calls)}</td><td>{model.avoidable}</td><td>{seconds(lost(model), locale)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
      {report.codes.length > 0 && (
        <p className="xn-usage-outcomes__codes" aria-label={tr("错误代码")}>{report.codes.map((code) => <span key={code.code}><code>{code.code}</code> ×{code.count}</span>)}</p>
      )}
    </section>
  );
}

function OutcomeStat({ value, label, tone }: { value: string; label: string; tone?: "warn" }): React.JSX.Element {
  return <div className="xn-usage-outcomes__stat" data-tone={tone}><strong>{value}</strong><span>{label}</span></div>;
}
