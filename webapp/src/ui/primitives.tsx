/**
 * Shared presentational primitives.
 *
 * Signatures are frozen by docs/xueness-batch6.md so the panel and workbench
 * lanes can build against them in parallel; the styling lane owns the visual
 * implementation. Presentational components have no IO. RegionBoundary adds
 * local render recovery without changing persisted state or permissions.
 */
import React from "react";
import { t as tr } from "../i18n";

/** Local render recovery. It never changes persisted data or plugin permissions. */
export class RegionBoundary extends React.Component<{
  children: React.ReactNode;
  resetKey?: string;
  onRecover?: () => void;
  onReload?: () => void;
  recoverLabel?: string;
}, { failed: boolean; loadFailure: boolean }> {
  state = { failed: false, loadFailure: false };
  static getDerivedStateFromError(error?: unknown): { failed: boolean; loadFailure: boolean } {
    return { failed: true, loadFailure: error instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(error.message) };
  }
  componentDidUpdate(previous: Readonly<typeof this.props>): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false, loadFailure: false });
  }
  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return <section role="alert" className="xn-region-error" data-testid="region-error">
      <h2>{tr("此区域暂时无法显示")}</h2>
      <p>{tr(this.state.loadFailure ? "界面资源加载失败，请重新加载界面。已保存的会话和配置不会被删除。" : "可以重试此区域。已保存的会话和配置不会被删除。")}</p>
      <div>
        {(!this.state.loadFailure || !this.props.onReload) && <Button onClick={() => this.setState({ failed: false, loadFailure: false })}>{tr("重试此区域")}</Button>}
        {this.props.onReload && <Button onClick={this.props.onReload}>{tr("重新加载界面")}</Button>}
        {this.props.onRecover && <Button onClick={this.props.onRecover}>{this.props.recoverLabel ?? tr("返回插件管理")}</Button>}
      </div>
    </section>;
  }
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  disabled = false,
  onClick,
  type = "button",
  title,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type={type}
      className={`xn-btn xn-btn--${variant} xn-btn--${size}`}
      data-testid="primitive-button"
      data-variant={variant}
      data-size={size}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  padding = "normal",
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  padding?: "normal" | "flush";
}) {
  return (
    <section className="xn-panel" data-testid="primitive-panel" data-padding={padding}>
      {(title || subtitle || actions) && (
        <header className="xn-panel__head" data-testid="primitive-panel-head">
          <div>
            {title && <h2 className="xn-panel__title">{title}</h2>}
            {subtitle && <p className="xn-panel__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="xn-panel__actions">{actions}</div>}
        </header>
      )}
      <div className="xn-panel__body">{children}</div>
    </section>
  );
}

export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="xn-tabs" role="tablist" data-testid="primitive-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          data-testid={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          className="xn-tab"
          data-active={tab.id === active ? "true" : undefined}
          onClick={onSelect ? () => onSelect(tab.id) : undefined}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn" | "error" | "info";
}) {
  return (
    <span className="xn-badge" data-testid="primitive-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="xn-field" data-testid="primitive-field">
      <span className="xn-field__label">{label}</span>
      {children}
      {hint && <span className="xn-field__hint">{hint}</span>}
    </label>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="xn-empty" data-testid="empty-state">
      <p className="xn-empty__title">{title}</p>
      {hint && <p className="xn-empty__hint">{hint}</p>}
    </div>
  );
}

export function CodeBlock({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: "neutral" | "add" | "remove";
}) {
  return (
    <pre className="xn-code" data-testid="primitive-code" data-tone={tone}>
      {text}
    </pre>
  );
}

export function Spinner({ label }: { label?: string } = {}) {
  return (
    <div className="xn-spinner" role="status" data-testid="primitive-spinner">
      <span className="xn-spinner__dot" />
      {label && <span className="xn-spinner__label">{label}</span>}
    </div>
  );
}

export function AppShell({
  header,
  sidebar,
  children,
}: {
  header: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="xn-shell" data-testid="primitive-shell">
      <header className="xn-shell__header">{header}</header>
      <div className="xn-shell__body">
        {sidebar && <aside className="xn-shell__sidebar">{sidebar}</aside>}
        <main className="xn-shell__main">{children}</main>
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="xn-stat" data-testid="primitive-stat">
      <span className="xn-stat__label">{label}</span>
      <span className="xn-stat__value">{value}</span>
    </div>
  );
}
