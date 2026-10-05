import React from "react";
import "../../styles/settings.css";

/**
 * Presentation-only primitives owned by the `settings` plugin.
 *
 * They render whatever the caller passes and never read state, send requests or
 * decide permissions, so other plugin settings surfaces may reuse them for a
 * consistent group/row/empty layout (recorded sharing reason per CONTRIBUTING).
 */

export type SettingsGroupProps = {
  title?: string;
  description?: string;
  children: React.ReactNode;
};

export type SettingsRowProps = {
  label: string;
  description?: string;
  control: React.ReactNode;
};

export type SettingsEmptyStateProps = {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  linkLabel?: string;
  href?: string;
};

export type SettingsAccountBadge = { label: string; title?: string };

export type SettingsAccountCardProps = {
  name: string;
  path?: string;
  subtitle?: string;
  badges?: SettingsAccountBadge[];
};

export function SettingsGroup({ title, description, children }: SettingsGroupProps): React.ReactElement {
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

export function SettingsRow({ label, description, control }: SettingsRowProps): React.ReactElement {
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

export function SettingsEmptyState({
  title,
  description,
  icon,
  actionLabel,
  onAction,
  actionDisabled = false,
  linkLabel,
  href,
}: SettingsEmptyStateProps): React.ReactElement {
  const hasLink = Boolean(linkLabel && href);
  return (
    <div className="xn-settings-empty" data-testid="xn-settings-empty">
      {icon && <span className="xn-settings-empty__icon" aria-hidden="true">{icon}</span>}
      <p className="xn-settings-empty__title">{title}</p>
      {description && <p className="xn-settings-empty__description">{description}</p>}
      {(actionLabel || hasLink) && (
        <div className="xn-settings-empty__actions">
          {actionLabel && (
            <button
              type="button"
              className="xn-btn xn-btn--primary xn-btn--md"
              disabled={actionDisabled || !onAction}
              onClick={() => onAction?.()}
            >
              {actionLabel}
            </button>
          )}
          {hasLink && (
            <a className="xn-settings-empty__link" href={href}>{linkLabel}</a>
          )}
        </div>
      )}
    </div>
  );
}

/** Keep the tail of a long path, which is the part that identifies a workspace. */
function abbreviatePath(path: string): string {
  const segments = path.split(/[/\\]+/u).filter(Boolean);
  const isAbsolute = /^[/\\]/u.test(path);
  if (segments.length <= 3) return path;
  return `${isAbsolute ? "…/" : ""}${segments.slice(-2).join("/")}`;
}

export function SettingsAccountCard({ name, path, subtitle, badges }: SettingsAccountCardProps): React.ReactElement {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
  const details = path ? abbreviatePath(path) : subtitle;
  return (
    <div className="xn-settings-account" data-testid="xn-settings-account">
      <span className="xn-settings-account__avatar" aria-hidden="true">{initial}</span>
      <span className="xn-settings-account__copy">
        <span className="xn-settings-account__name" title={name}>{name}</span>
        {details && (
          <span className="xn-settings-account__path" title={path}>{details}</span>
        )}
      </span>
      {badges && badges.length > 0 && (
        <span className="xn-settings-account__badges">
          {badges.map((badge) => (
            <span key={`${badge.label}:${badge.title ?? ""}`} className="xn-settings-account__badge" title={badge.title}>
              {badge.label}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
