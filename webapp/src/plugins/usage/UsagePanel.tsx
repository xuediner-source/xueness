import React from "react";
import { t as tr, tf } from "../../i18n";
import type { UsageSummary } from "../../xuenessWorkspace";
import { EmptyState, Panel, Spinner, Stat } from "../../ui/primitives";

// ============================================================================
// 3. UsagePanel
// ============================================================================

export type UsagePanelProps = {
  usage: UsageSummary | null;
  error?: string;
  loading?: boolean;
};

export function UsagePanel({
  usage,
  error,
  loading = false,
}: UsagePanelProps): React.ReactElement {
  return (
    <Panel title={tr("用量统计 (Usage)")} subtitle={usage?.range ? tf("统计周期: {0}", [usage.range]) : undefined}>
      <div data-testid="usage-panel">
        {loading && (
          <div data-testid="usage-loading" style={{ padding: "8px 0" }}>
            <Spinner label={tr("加载用量数据中...")} />
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="usage-error"
            style={{
              padding: "8px 12px",
              marginBottom: "12px",
              borderRadius: "4px",
              color: "var(--error, #b91c1c)",
              background: "rgba(239, 68, 68, 0.1)",
              fontSize: "13px",
            }}
          >{tr("获取用量数据失败：")}{error}
          </div>
        )}

        {!loading && !error && !usage && (
          <EmptyState title={tr("暂无用量数据")} hint={tr("尚未产生任何会话或步骤记录")} />
        )}

        {usage && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div
              data-testid="usage-totals"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "12px",
              }}
            >
              <Stat label={tr("总会话数")} value={usage.totals.sessions} />
              <Stat label={tr("总步骤数")} value={usage.totals.steps} />
              <Stat label={tr("完成会话数")} value={usage.totals.completed} />
            </div>

            <div data-testid="usage-provider-reported" style={{ padding: "14px", border: "1px solid var(--border)", borderRadius: "8px" }}>
              <strong>{tr("模型报告的用量")}</strong>
              {usage.tokens && usage.tokens.reportedRequests > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px", marginTop: "12px" }}>
                  <Stat label={tr("输入 Token")} value={usage.tokens.input} />
                  <Stat label={tr("输出 Token")} value={usage.tokens.output} />
                </div>
              ) : <p className="muted">{tr("服务商尚未报告 Token 用量")}</p>}
              {!!usage.tokens?.unknownRequests && <p className="muted">{tf("有 {0} 次请求未报告完整 Token 用量", [String(usage.tokens.unknownRequests)])}</p>}
              {Object.entries(usage.costs ?? {}).filter(([, value]) => Number.isFinite(value) && value >= 0).length > 0 ? (
                <p>{tr("已报告费用")}: {Object.entries(usage.costs ?? {}).filter(([, value]) => Number.isFinite(value) && value >= 0).map(([currency, amount]) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`).join(" · ")}</p>
              ) : <p className="muted">{tr("服务商尚未报告费用")}</p>}
              <small className="muted">{tr("仅统计服务商返回的数据，缺失费用不作估算。")}</small>
            </div>

            {usage.series && usage.series.length > 0 && (
              <div
                data-testid="usage-series"
                style={{
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: "6px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "8px 12px",
                    fontWeight: 600,
                    fontSize: "13px",
                    borderBottom: "1px solid var(--border, #e5e7eb)",
                    background: "rgba(0, 0, 0, 0.02)",
                  }}
                >{tr("历史用量明细")}</div>
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                  }}
                >
                  {usage.series.map((item) => (
                    <li
                      key={item.date}
                      data-testid={`usage-series-${item.date}`}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "6px 12px",
                        fontSize: "12px",
                        borderBottom: "1px solid var(--border, #f3f4f6)",
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{item.date}</span>
                      <span>{tr("会话:")}<strong>{item.sessions}</strong>{tr("次 / 步骤:")}{" "}
                        <strong>{item.steps}</strong>{tr("步")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {usage.updatedAt && (
              <div
                data-testid="usage-updated-at"
                style={{
                  fontSize: "11px",
                  color: "var(--muted, #6b7280)",
                  textAlign: "right",
                }}
              >{tr("更新时间:")}{" "}{usage.updatedAt}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
