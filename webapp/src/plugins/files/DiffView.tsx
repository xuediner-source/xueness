import React from "react";
import { t as tr } from "../../i18n";
import { CodeContent } from "../../ui/CodeContent";
import type { FileChange, FileChangeSet } from "../../xuenessWorkbench";
import "../../styles/office.css";

// -- change view -------------------------------------------------------------

export type DiffViewProps = {
  changeSet: FileChangeSet | null;
  error?: string;
};

function ChangeBlock({ change }: { change: FileChange }) {
  return (
    <div
      data-testid={`change-${change.path}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        marginBottom: 10,
        overflow: "hidden",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          background: "var(--bg-subtle)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--fg)", fontFamily: "var(--font-mono)" }}>
          {change.path}
        </span>
        <span style={{ color: change.ok ? "var(--ok-fg)" : "var(--error-fg)", fontWeight: 500 }}>
          {change.kind} · {change.ok ? tr("已应用") : tr("未应用")}
        </span>
      </div>
      {change.kind === "edit" ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <CodeContent text={change.old ?? ""} path={change.path} tone="remove" />
          <CodeContent text={change.new ?? ""} path={change.path} tone="add" />
        </div>
      ) : (
        <CodeContent text={change.content ?? ""} path={change.path} tone="add" />
      )}
    </div>
  );
}

export function DiffView({ changeSet, error }: DiffViewProps) {
  // The provenance line is not decoration: without it this reads as a live diff,
  // which it is not. Keep it first and keep it unconditional.
  const provenance = (
    <div
      data-testid="diff-provenance"
      className="xn-diff-provenance"
    >{tr("来自会话记录，不是当前磁盘差异")}</div>
  );

  if (error) {
    return (
      <div data-testid="diff-view" className="xn-diff-container">
        {provenance}
        <p role="alert" data-testid="diff-error" style={{ margin: 0, color: "var(--error-fg)", background: "var(--error-bg)", border: "1px solid var(--error-border)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: 12 }}>{tr("读取改动失败：")}{error}
        </p>
      </div>
    );
  }

  if (!changeSet || changeSet.changes.length === 0) {
    return (
      <div data-testid="diff-view" className="xn-diff-container">
        {provenance}
        <div data-testid="diff-empty" style={{ fontSize: 12, color: "var(--fg-muted)", padding: "8px 0" }}>{tr("暂无改动")}</div>
      </div>
    );
  }

  return (
    <div data-testid="diff-view" className="xn-diff-container">
      {provenance}
      {changeSet.changes.map((change, index) => (
        <ChangeBlock key={`${change.path}-${index}`} change={change} />
      ))}
    </div>
  );
}
