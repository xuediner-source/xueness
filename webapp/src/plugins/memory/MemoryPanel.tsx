import React from "react";
import { t as tr } from "../../i18n";
import type { MemoryTrack } from "../../xuenessWorkspace";
import { Badge, EmptyState, Panel, Spinner } from "../../ui/primitives";

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// ============================================================================
// 4. MemoryPanel
// ============================================================================

export type MemoryPanelProps = {
  tracks: MemoryTrack[];
  error?: string;
  loading?: boolean;
};

const TRACK_LABELS = (): Record<MemoryTrack["name"], { label: string; desc: string }> => ({
  memory: { label: tr("长期记忆 (MEMORY.md)"), desc: tr("存储跨会话提炼的核心事实与偏好") },
  user: { label: tr("用户画像 (USER.md)"), desc: tr("存储用户身份、环境背景与个性化指示") },
  key: { label: tr("关键意图 (Key Track)"), desc: tr("存储高优先级活动意图与短期轨道") },
});

export function MemoryPanel({
  tracks,
  error,
  loading = false,
}: MemoryPanelProps): React.ReactElement {
  return (
    <Panel title={tr("记忆轨道 (Memory Tracks)")} subtitle={tr("会话长期记忆与上下文文件状态")}>
      <div data-testid="memory-panel">
        {loading && (
          <div data-testid="memory-loading" style={{ padding: "8px 0" }}>
            <Spinner label={tr("加载记忆轨道中...")} />
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="memory-error"
            style={{
              padding: "8px 12px",
              marginBottom: "12px",
              borderRadius: "4px",
              color: "var(--error, #b91c1c)",
              background: "rgba(239, 68, 68, 0.1)",
              fontSize: "13px",
            }}
          >{tr("获取记忆轨道失败：")}{error}
          </div>
        )}

        {!loading && !error && tracks.length === 0 && (
          <EmptyState title={tr("未发现记忆轨道")} hint={tr("当前工作区未建立任何记忆文件")} />
        )}

        {tracks.length > 0 && (
          <div
            data-testid="memory-tracks-list"
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            {tracks.map((t) => {
              const meta = TRACK_LABELS()[t.name] ?? {
                label: t.name,
                desc: tr("工作区附加记忆轨道"),
              };
              return (
                <div
                  key={t.name}
                  data-testid={`memory-track-${t.name}`}
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
                    <div>
                      <span style={{ fontWeight: 600, fontSize: "14px" }}>
                        {meta.label}
                      </span>
                      <p
                        style={{
                          margin: "2px 0 0",
                          fontSize: "12px",
                          color: "var(--muted, #6b7280)",
                        }}
                      >
                        {meta.desc}
                      </p>
                    </div>
                    <div>
                      {t.present ? (
                        <Badge tone="ok">{tr("存在 (")}{formatSize(t.bytes)})</Badge>
                      ) : (
                        <Badge tone="neutral">{tr("未创建")}</Badge>
                      )}
                    </div>
                  </div>

                  <div style={{ fontSize: "12px", color: "var(--muted, #6b7280)" }}>{tr("文件路径:")}<code>{t.path}</code>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
