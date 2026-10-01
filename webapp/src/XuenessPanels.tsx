import { t as tr, tf } from './i18n';
import React, { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { XuenessTerminalShellSelect } from "./XuenessTerminalPreferences";
import type {
  ProviderSummary,
  UsageSummary,
  MemoryTrack,
  SettingsMap,
} from "./xuenessWorkspace";
import type { AgentCapabilities } from "./xuenessSettings";
import {
  Button,
  Panel,
  Badge,
  Field,
  EmptyState,
  Spinner,
  Stat,
} from "./ui/primitives";
import { Select } from "./ui/Select";
import { XuenessShortcutsPanel } from "./XuenessShortcutsPanel";
import {
  CODE_PREVIEW_THEME_OPTIONS,
  CodePreview,
  isCodePreviewTheme,
  type CodePreviewTheme,
} from "./ui/CodePreview";

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// 1. DirectoryBrowser
// ============================================================================

export type DirectoryBrowserProps = {
  /** 当前目录绝对路径，未选为 null */
  currentPath: string | null;
  entries: { name: string; path: string; isDir: boolean; size: number }[];
  error?: string;
  truncated?: boolean;
  loading?: boolean;
  onNavigate?: (path: string) => void;     // 进入子目录 / 上级
  onOpenFile?: (path: string) => void;     // 选中文件
  onCreateDir?: (name: string) => void;    // 新建文件夹
};

export function DirectoryBrowser({
  currentPath,
  entries,
  error,
  truncated = false,
  loading = false,
  onNavigate,
  onOpenFile,
  onCreateDir,
}: DirectoryBrowserProps): React.ReactElement {
  const [newDirName, setNewDirName] = useState("");

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newDirName.trim();
    if (trimmed && onCreateDir) {
      onCreateDir(trimmed);
      setNewDirName("");
    }
  };

  // 目录列在前面，然后按文件名排序
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return (
    <Panel
      title={tr("目录浏览")}
      subtitle={currentPath ? currentPath : tr("未选择目录")}
      padding="flush"
      actions={
        onCreateDir ? (
          <form
            onSubmit={handleCreateSubmit}
            data-testid="create-dir-form"
            style={{ display: "flex", gap: "6px", alignItems: "center" }}
          >
            <input
              type="text"
              aria-label={tr("新建文件夹名称")}
              placeholder={tr("新文件夹名称...")}
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              style={{
                fontSize: "12px",
                padding: "3px 6px",
                borderRadius: "4px",
                border: "1px solid var(--border, #d1d5db)",
                background: "var(--bg, #fff)",
                color: "inherit",
              }}
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!newDirName.trim()}
            >{tr("新建文件夹")}</Button>
          </form>
        ) : undefined
      }
    >
      <div data-testid="directory-browser" style={{ padding: "12px" }}>
        {loading && (
          <div data-testid="directory-loading" style={{ padding: "8px 0" }}>
            <Spinner label={tr("加载目录中...")} />
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="directory-error"
            style={{
              padding: "8px 12px",
              marginBottom: "8px",
              borderRadius: "4px",
              color: "var(--error, #b91c1c)",
              background: "rgba(239, 68, 68, 0.1)",
              fontSize: "13px",
            }}
          >{tr("目录读取失败：")}{error}
          </div>
        )}

        {!loading && !error && sortedEntries.length === 0 && (
          <EmptyState title={tr("目录为空")} hint={tr("当前目录下没有文件或子目录")} />
        )}

        {sortedEntries.length > 0 && (
          <ul
            aria-label={tr("目录内容")}
            data-testid="directory-list"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {sortedEntries.map((item) => {
              if (item.isDir) {
                return (
                  <li
                    key={item.path}
                    data-testid={`dir-entry-${item.name}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--border, #f3f4f6)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Badge tone="info">{tr("目录")}</Badge>
                      {onNavigate ? (
                        <button
                          type="button"
                          data-testid={`dir-navigate-${item.name}`}
                          onClick={() => onNavigate(item.path)}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            color: "var(--primary, #2563eb)",
                            cursor: "pointer",
                            fontWeight: 600,
                            fontSize: "13px",
                            textAlign: "left",
                            textDecoration: "underline",
                          }}
                        >
                          {item.name}
                        </button>
                      ) : (
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: 600,
                            color: "inherit",
                          }}
                        >
                          {item.name}
                        </span>
                      )}
                    </div>
                  </li>
                );
              }

              return (
                <li
                  key={item.path}
                  data-testid={`file-entry-${item.name}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    borderBottom: "1px solid var(--border, #f3f4f6)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Badge tone="neutral">{tr("文件")}</Badge>
                    {onOpenFile ? (
                      <button
                        type="button"
                        data-testid={`file-open-${item.name}`}
                        onClick={() => onOpenFile(item.path)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          color: "inherit",
                          cursor: "pointer",
                          fontSize: "13px",
                          textAlign: "left",
                        }}
                      >
                        {item.name}
                      </button>
                    ) : (
                      <span style={{ fontSize: "13px" }}>{item.name}</span>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--muted, #6b7280)",
                    }}
                  >
                    {formatSize(item.size)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {truncated && (
          <div
            data-testid="directory-truncated"
            style={{
              marginTop: "8px",
              padding: "6px 10px",
              fontSize: "12px",
              color: "var(--warn, #b45309)",
              background: "rgba(245, 158, 11, 0.1)",
              borderRadius: "4px",
            }}
          >{tr("内容过多，仅显示部分结果")}</div>
        )}
      </div>
    </Panel>
  );
}

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

// ============================================================================
// 5. SettingsSections
// ============================================================================

export type SettingsSectionsProps = {
  sections: { id: string; label: string }[];
  activeSection: string;
  onSelectSection?: (id: string) => void;
  values: SettingsMap;
  capabilities: AgentCapabilities;
  onToggleCapability?: (key: keyof AgentCapabilities, value: boolean) => void | Promise<unknown>;
  onUpdateSetting?: (key: string, value: unknown) => void | Promise<unknown>;
  onSave?: () => void | Promise<unknown>;
  saveError?: string;
  dirty?: boolean;
  embedded?: boolean;
  saving?: boolean;
};

function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="xn-setting-row">
      <div className="xn-setting-row__copy">
        <h3>{label}</h3>
        {description && <p>{description}</p>}
      </div>
      <div className="xn-setting-control">{control}</div>
    </div>
  );
}

function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="xn-settings-card-group">
      {(title || description) && (
        <header className="xn-settings-card-group__header">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="xn-settings-group">{children}</div>
    </section>
  );
}

function SettingsToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <input
      type="checkbox"
      role="switch"
      className="xn-settings-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

function SettingsSelect({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="xn-settings-select-wrap">
      <Select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {children}
      </Select>
    </div>
  );
}

function SettingsFontSizeInput({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void | Promise<unknown>;
}): React.ReactElement {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
    setDraft(String(next));
    if (next !== value) void onCommit(next);
  };
  return (
    <div className="xn-settings-font-size">
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
      />
      <span aria-hidden="true">px</span>
    </div>
  );
}

const CAPABILITY_SETTINGS: {
  key: keyof AgentCapabilities;
  label: string;
  description: string;
}[] = [
  { key: "allowMcp", label: "允许 MCP", description: "允许 Agent 启动已配置的 MCP 工具。" },
  { key: "allowSubagents", label: "允许子代理", description: "允许 Agent 启动嵌套子代理任务。" },
  { key: "allowHooks", label: "允许 Hooks", description: "允许运行已配置的工具调用钩子。" },
];

export function SettingsSections({
  activeSection,
  values,
  capabilities,
  onToggleCapability,
  onUpdateSetting,
  saving = false,
  embedded = false,
}: SettingsSectionsProps): React.ReactElement {
  const update = (key: string, value: unknown) => onUpdateSetting?.(key, value);
  const select = (label: string, value: string, options: React.ReactNode, onChange: (next: string) => void, forceDisabled = false) => (
    <SettingsSelect label={tr(label)} value={value} disabled={!onUpdateSetting || saving || forceDisabled} onChange={onChange}>
      {options}
    </SettingsSelect>
  );
  const toggle = (key: string, label: string, fallback = true) => (
    <SettingsToggle
      label={tr(label)}
      checked={values[key] === undefined ? fallback : values[key] === true}
      disabled={!onUpdateSetting || saving}
      onChange={(next) => { void update(key, next); }}
    />
  );
  const rawCodeSettings = values.codePreviewSettings && typeof values.codePreviewSettings === "object" && !Array.isArray(values.codePreviewSettings)
    ? values.codePreviewSettings as Record<string, unknown>
    : {};
  const codePreviewSettings = {
    lightTheme: isCodePreviewTheme(rawCodeSettings.lightTheme) ? rawCodeSettings.lightTheme : "github-light" as CodePreviewTheme,
    darkTheme: isCodePreviewTheme(rawCodeSettings.darkTheme) ? rawCodeSettings.darkTheme : "github-dark" as CodePreviewTheme,
    showLineNumbers: rawCodeSettings.showLineNumbers !== false,
    wrapLongLines: rawCodeSettings.wrapLongLines === true,
    fontSizePx: Number.isFinite(Number(rawCodeSettings.fontSizePx))
      ? Math.min(20, Math.max(12, Number(rawCodeSettings.fontSizePx)))
      : 12,
  };
  const updateCodePreviewSettings = (patch: Partial<typeof codePreviewSettings>) =>
    update("codePreviewSettings", { ...codePreviewSettings, ...patch });
  const themeMode = String(values.theme ?? "system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const apply = () => setSystemPrefersDark(media.matches);
    apply();
    media.addEventListener?.("change", apply);
    return () => media.removeEventListener?.("change", apply);
  }, []);
  const activePreviewMode = themeMode === "dark" ? "dark" : themeMode === "light" ? "light" : systemPrefersDark ? "dark" : "light";

  let controls: React.ReactNode = null;
  if (activeSection === "general") {
    const locale = String(values.language ?? "zh");
    const configuredArchiveDays = Number(values.taskAutoArchiveOlderThanDays ?? 7);
    const archiveDays = [3, 7, 14, 30].includes(configuredArchiveDays) ? configuredArchiveDays : 7;
    controls = <>
      <div className="xn-settings-general-locale" data-testid="settings-current-locale">
        {locale === "en" ? "English (US)" : tr("中文简体")}
      </div>
      <SettingsCard>
        <SettingsRow
          label={tr("界面语言")}
          description={tr("选择应用 UI 的显示语言。")}
          control={select("界面语言", String(values.language ?? "zh"), <><option value="zh">中文</option><option value="en">English</option></>, (next) => { void update("language", next); })}
        />
      </SettingsCard>
      <SettingsCard title={tr("对话行为")} description={tr("控制消息到达时的显示方式。")}>
        <SettingsRow label={tr("新消息自动滚动")} description={tr("收到新消息时保持对话在最新位置。")} control={toggle("autoScroll", "新消息自动滚动")} />
        <SettingsRow label={tr("显示推理内容")} description={tr("展示模型通过流式接口返回的推理文本；模型未返回时不会显示。")} control={toggle("messageStreamShowReasoning", "显示推理内容", true)} />
        <SettingsRow label={tr("显示任务待办")} description={tr("在对话中显示模型创建的待办事项。")} control={toggle("showTodos", "显示任务待办")} />
        <SettingsRow label={tr("默认收起工具详情")} description={tr("工具调用保留在时间线中，展开后查看详情。")} control={toggle("collapseTools", "默认收起工具详情")} />
      </SettingsCard>
      <SettingsCard title={tr("自动归档旧任务")} description={tr("仅归档已完成、已查看且长期未更新的任务；归档可在历史记录中恢复。")}>
        <SettingsRow
          label={tr("启用自动归档")}
          description={tr("未查看、置顶、正在运行或有待处理操作的任务会保留。")}
          control={toggle("taskAutoArchiveEnabled", "启用自动归档", false)}
        />
        <SettingsRow
          label={tr("归档保留时长")}
          description={tr("从最近一次查看开始计时，超过所选时长后才会归档。")}
          control={select(
            "归档保留时长",
            String(archiveDays),
            <><option value="3">3 {tr("天")}</option><option value="7">7 {tr("天")}</option><option value="14">14 {tr("天")}</option><option value="30">30 {tr("天")}</option></>,
            (next) => { const days = Number(next); if ([3, 7, 14, 30].includes(days)) void update("taskAutoArchiveOlderThanDays", days); },
            values.taskAutoArchiveEnabled !== true,
          )}
        />
      </SettingsCard>
      <SettingsCard title={tr("工具分组")} description={tr("将相邻的同类工具调用合并显示。") }>
        <SettingsRow label={tr("分组探索工具")} description={tr("聚合连续的读取与搜索调用。")} control={toggle("toolGroupingExploreEnabled", "分组探索工具")} />
        <SettingsRow label={tr("分组终端命令")} description={tr("聚合连续的终端命令。")} control={toggle("toolGroupingTerminalEnabled", "分组终端命令")} />
        <SettingsRow label={tr("分组文件更改")} description={tr("聚合连续的文件写入和编辑调用。")} control={toggle("toolGroupingChangesEnabled", "分组文件更改", false)} />
      </SettingsCard>
      <SettingsCard title={tr("终端设置")} description={tr("选择新终端使用的 Shell，并调整终端文字。") }>
        <SettingsRow label={tr("默认 Shell")} description={tr("只影响之后打开的终端；现有终端保持当前 Shell。")} control={<XuenessTerminalShellSelect value={typeof values.defaultShell === "string" ? values.defaultShell : undefined} disabled={!onUpdateSetting || saving} onChange={next => { void update("defaultShell", next); }} />} />
        <SettingsRow label={tr("终端字体")} description={tr("缺少所选字体时使用系统等宽字体。")} control={select("终端字体", String(values.terminalFontFamily ?? "system"), <><option value="system">{tr("系统等宽")}</option><option value="Menlo">Menlo</option><option value="SFMono-Regular">SF Mono</option><option value="monospace">monospace</option></>, next => { void update("terminalFontFamily", next); })} />
        <SettingsRow label={tr("终端字号")} description={tr("调整交互式终端中的文字大小。")} control={<SettingsFontSizeInput label={tr("终端字号")} value={Number(values.terminalFontSize ?? 13)} disabled={!onUpdateSetting || saving} min={10} max={24} onCommit={next => update("terminalFontSize", next)} />} />
      </SettingsCard>
    </>;
  } else if (activeSection === "agent") {
    controls = <SettingsCard>
      {CAPABILITY_SETTINGS.map(({ key, label, description }) => (
        <div key={key} data-testid={`capability-${key}`} data-enabled={capabilities[key] ? "true" : "false"}>
          <SettingsRow
            label={tr(label)}
            description={tr(description)}
            control={<SettingsToggle label={tr(label)} checked={capabilities[key]} disabled={!onToggleCapability || saving} onChange={(next) => { void onToggleCapability?.(key, next); }} />}
          />
        </div>
      ))}
    </SettingsCard>;
  } else if (activeSection === "appearance") {
    controls = <>
      <SettingsCard title={tr("界面设置")} description={tr("设置应用主题和界面文字大小。") }>
        <SettingsRow
          label={tr("界面主题")}
          description={tr("选择浅色、深色或跟随系统主题。")}
          control={select("界面主题", String(values.theme ?? "system"), <>
            <option value="system"><span className="xn-settings-theme-option"><Monitor size={16} aria-hidden="true" />{tr("跟随系统")}</span></option>
            <option value="dark"><span className="xn-settings-theme-option"><Moon size={16} aria-hidden="true" />{tr("深色")}</span></option>
            <option value="light"><span className="xn-settings-theme-option"><Sun size={16} aria-hidden="true" />{tr("浅色")}</span></option>
          </>, (next) => { void update("theme", next); })}
        />
        <SettingsRow
          label={tr("界面字号")}
          description={tr("调整应用界面的文字大小，图标和布局尺寸不受影响。")}
          control={<SettingsFontSizeInput label={tr("界面字号")} value={Number(values.fontSize ?? 14)} disabled={!onUpdateSetting || saving} min={12} max={20} onCommit={(next) => update("fontSize", next)} />}
        />
      </SettingsCard>

      <SettingsCard title={tr("代码设置")} description={tr("设置代码内容的主题、字号和显示方式，不受界面字号影响。") }>
        <SettingsRow
          label={tr("浅色代码主题")}
          description={tr("浅色界面下代码内容使用的高亮主题。")}
          control={select("浅色代码主题", codePreviewSettings.lightTheme, <>{CODE_PREVIEW_THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</>, (next) => {
            if (isCodePreviewTheme(next)) void updateCodePreviewSettings({ lightTheme: next });
          })}
        />
        <SettingsRow
          label={tr("深色代码主题")}
          description={tr("深色界面下代码内容使用的高亮主题。")}
          control={select("深色代码主题", codePreviewSettings.darkTheme, <>{CODE_PREVIEW_THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</>, (next) => {
            if (isCodePreviewTheme(next)) void updateCodePreviewSettings({ darkTheme: next });
          })}
        />
        <SettingsRow
          label={tr("显示行号")}
          description={tr("在代码内容和差异视图中显示行号。")}
          control={<SettingsToggle label={tr("显示行号")} checked={codePreviewSettings.showLineNumbers} disabled={!onUpdateSetting || saving} onChange={(next) => { void updateCodePreviewSettings({ showLineNumbers: next }); }} />}
        />
        <SettingsRow
          label={tr("长行自动换行")}
          description={tr("代码内容过长时自动换行。")}
          control={<SettingsToggle label={tr("长行自动换行")} checked={codePreviewSettings.wrapLongLines} disabled={!onUpdateSetting || saving} onChange={(next) => { void updateCodePreviewSettings({ wrapLongLines: next }); }} />}
        />
        <SettingsRow
          label={tr("代码字号")}
          description={tr("调整代码块、文件预览和差异视图的默认字号。")}
          control={<SettingsFontSizeInput label={tr("代码字号")} value={codePreviewSettings.fontSizePx} disabled={!onUpdateSetting || saving} min={12} max={20} onCommit={(next) => updateCodePreviewSettings({ fontSizePx: next })} />}
        />
      </SettingsCard>

      <section className="xn-settings-card-group xn-settings-code-previews">
        <header className="xn-settings-card-group__header">
          <h2>{tr("代码预览")}</h2>
          <p>{tr("同时预览浅色与深色代码主题，当前界面使用的主题会标记为“当前生效”。")}</p>
        </header>
        <div className="xn-settings-code-previews__grid">
          {CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === codePreviewSettings.lightTheme) && (
            <CodePreview
              mode="light"
              theme={codePreviewSettings.lightTheme}
              themeName={CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === codePreviewSettings.lightTheme)!.label}
              active={activePreviewMode === "light"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
          )}
          <CodePreview
            mode="dark"
            theme={codePreviewSettings.darkTheme}
            themeName={CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === codePreviewSettings.darkTheme)?.label ?? codePreviewSettings.darkTheme}
            active={activePreviewMode === "dark"}
            showLineNumbers={codePreviewSettings.showLineNumbers}
            wrapLongLines={codePreviewSettings.wrapLongLines}
            fontSizePx={codePreviewSettings.fontSizePx}
          />
        </div>
      </section>


    </>;
  } else if (activeSection === "workspace-display") {
    controls = <SettingsCard title={tr("工作区显示")} description={tr("调整文件预览中 Tab 字符的显示宽度。") }>
        <SettingsRow
          label={tr("缩进宽度")}
          description={tr("文件内容中 Tab 字符的显示宽度。")}
          control={select("缩进宽度", String(Number(values.tabSize ?? 2)), <>{[2, 4, 8].map((size) => <option key={size} value={size}>{size}</option>)}</>, (next) => { void update("tabSize", Number(next)); })}
        />
      </SettingsCard>;
  } else if (activeSection === "shortcuts") {
    const bindings = values.bindings && typeof values.bindings === "object" && !Array.isArray(values.bindings)
      ? Object.fromEntries(Object.entries(values.bindings).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    controls = <>
      <XuenessShortcutsPanel bindings={bindings} disabled={!onUpdateSetting || saving} onChange={(next) => update("bindings", next)} />
      <SettingsCard title={tr("发送行为")} description={tr("选择发送消息时使用的 Enter 组合。") }>
        <SettingsRow
          label={tr("发送消息快捷键")}
          description={tr("选择 Enter 或 Mod+Enter 发送。Shift+Enter 始终用于换行。")}
          control={select("发送消息快捷键", values.sendShortcut === "mod-enter" ? "mod-enter" : "enter", <><option value="enter">Enter</option><option value="mod-enter">Mod+Enter</option></>, (next) => { void update("sendShortcut", next); })}
        />
      </SettingsCard>
      <div className="xn-settings-shortcut-hints" aria-label={tr("固定快捷键")}>
        <div><span>{tr("输入换行")}</span><kbd>Shift+Enter</kbd></div>
        <div><span>{tr("关闭菜单或停止运行")}</span><kbd>Escape</kbd></div>
      </div>
    </>;
  } else if (activeSection === "browser") {
    controls = <>
      <SettingsCard title={tr("浏览器工具")}>
        <SettingsRow
          label={tr("新任务启用浏览器")}
          description={tr("为新对话启用浏览器工具；工具执行仍遵循所选权限模式。")}
          control={toggle("browserControlEnabled", "新任务启用浏览器", false)}
        />
      </SettingsCard>
      <div className="xn-settings-readonly">
        <h2>{tr("浏览器运行环境")}</h2>
        <p>{tr("使用服务器上的 Node、Playwright 和 Chromium，配置独立于你当前浏览器的标签页。")}</p>
        <p>{tr("可执行程序通过 XUENESS_BROWSER_EXECUTABLE 指定；没有安装依赖时，实际运行会显示错误。")}</p>
      </div>
    </>;
  }

  const content = (
    <div className="xn-settings-controls" data-testid={`settings-section-content-${activeSection}`}>
      {controls}
    </div>
  );
  return embedded ? content : <div className="xn-settings-controls">{content}</div>;
}
