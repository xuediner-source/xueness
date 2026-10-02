import React from "react";
import { t as tr } from "../../i18n";
import type { ProviderSummary } from "../../xuenessWorkspace";
import { Badge, EmptyState, Panel, Spinner } from "../../ui/primitives";

// ============================================================================
// 2. ProvidersPanel
// ============================================================================

export type ProvidersPanelProps = {
  providers: ProviderSummary[];
  error?: string;
  loading?: boolean;
};

export function ProvidersPanel({
  providers,
  error,
  loading = false,
}: ProvidersPanelProps): React.ReactElement {
  return (
    <Panel title={tr("模型服务商 (Providers)")} subtitle={tr("配置的模型与 API 接入点")}>
      <div data-testid="providers-panel">
        {loading && (
          <div data-testid="providers-loading" style={{ padding: "8px 0" }}>
            <Spinner label={tr("加载服务商列表中...")} />
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="providers-error"
            style={{
              padding: "8px 12px",
              marginBottom: "12px",
              borderRadius: "4px",
              color: "var(--error, #b91c1c)",
              background: "rgba(239, 68, 68, 0.1)",
              fontSize: "13px",
            }}
          >{tr("获取服务商失败：")}{error}
          </div>
        )}

        {!loading && !error && providers.length === 0 && (
          <EmptyState
            title={tr("暂无模型服务商")}
            hint={tr("未配置任何外部模型供应商接入点")}
          />
        )}

        {providers.length > 0 && (
          <div
            data-testid="providers-list"
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            {providers.map((p) => (
              <div
                key={p.id}
                data-testid={`provider-card-${p.id}`}
                style={{
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: "6px",
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontWeight: 600, fontSize: "14px" }}>
                      {p.name}
                    </span>
                    <span
                      style={{
                        fontSize: "12px",
                        color: "var(--muted, #6b7280)",
                      }}
                    >
                      ({p.id})
                    </span>
                  </div>
                  <div>
                    {p.hasKey ? (
                      <Badge tone="ok">{tr("已配置密钥")}</Badge>
                    ) : (
                      <Badge tone="warn">{tr("未配置密钥")}</Badge>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: "4px 12px",
                    fontSize: "12px",
                  }}
                >
                  <span style={{ color: "var(--muted, #6b7280)" }}>{tr("默认模型:")}</span>
                  <code>{p.model}</code>
                  <span style={{ color: "var(--muted, #6b7280)" }}>Base URL:</span>
                  <code style={{ wordBreak: "break-all" }}>{p.baseUrl}</code>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
