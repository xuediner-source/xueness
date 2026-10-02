import React from "react";
import { t as tr } from "../../i18n";
import type { SettingsMap, AgentCapabilities } from "../../xuenessSettings";

// -- settings panel ----------------------------------------------------------

export type SettingsPanelProps = {
  values: SettingsMap;
  capabilities: AgentCapabilities;
  onToggleCapability?: (key: keyof AgentCapabilities, value: boolean) => void;
  onSave?: () => void | Promise<unknown>;
  saveError?: string;
  dirty?: boolean;
};

const CAPABILITY_LABELS = (): { key: keyof AgentCapabilities; label: string; hint: string }[] => ([
  { key: "allowMcp", label: tr("允许 MCP"), hint: tr("会启动外部 MCP 子进程") },
  { key: "allowSubagents", label: tr("允许子代理"), hint: tr("会发起嵌套模型调用") },
  { key: "allowHooks", label: tr("允许 Hooks"), hint: tr("会在工具调用前后执行钩子") },
]);

export function SettingsPanel({
  capabilities,
  onToggleCapability,
  onSave,
  saveError,
  dirty = false,
}: SettingsPanelProps) {
  return (
    <section data-testid="settings-panel" className="xn-settings-container">
      <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>{tr("Agent 能力")}</h3>
      <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--warn-fg)", background: "var(--warn-bg)", border: "1px solid var(--warn-border)", borderRadius: "var(--radius-md)", padding: "8px 12px" }}>{tr("以下能力会启动子进程或嵌套模型调用，默认关闭，开启前请确认风险。")}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {CAPABILITY_LABELS().map(({ key, label, hint }) => {
          const enabled = capabilities[key] === true;
          return (
            <label
              key={key}
              data-testid={`capability-${key}`}
              data-enabled={enabled ? "true" : "false"}
              className="xn-settings-card"
            >
              <input
                type="checkbox"
                aria-label={label}
                checked={enabled}
                readOnly={!onToggleCapability}
                onChange={
                  onToggleCapability ? (e) => onToggleCapability(key, e.target.checked) : undefined
                }
                style={{ marginTop: 2, accentColor: "var(--primary)" }}
              />
              <span>
                <span style={{ fontWeight: 600, color: "var(--fg)" }}>{label}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{hint}</span>
              </span>
            </label>
          );
        })}
      </div>

      {saveError && (
        <p role="alert" data-testid="settings-save-error" style={{ margin: "14px 0 0", color: "var(--error-fg)", background: "var(--error-bg)", border: "1px solid var(--error-border)", borderRadius: "var(--radius-md)", padding: "8px 12px", fontSize: 12 }}>{tr("保存失败：")}{saveError}
        </p>
      )}

      {onSave && (
        <button
          type="button"
          data-testid="settings-save"
          onClick={() => void onSave()}
          disabled={!dirty}
          className="xn-btn xn-btn--primary xn-btn--md"
          style={{
            marginTop: 16,
          }}
        >{tr("保存")}</button>
      )}
    </section>
  );
}
