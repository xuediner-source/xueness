import React from 'react';
import type { SidebarAction } from '../../XuenessShell';
import { displayBinding } from '../../xuenessShortcutDisplay';
import { t as tr } from '../../i18n';
import './ClaudexSidebar.css';

function actionTitle(action: SidebarAction, platform?: string): string {
  return action.shortcut ? `${action.label} (${displayBinding(action.shortcut, platform)})` : action.label;
}

/** Presentation only: the container supplies plugin-filtered existing actions. */
export function ClaudexSidebarRail({ actions, platform, activeId }: { actions: SidebarAction[]; platform?: string; activeId?: string }): React.JSX.Element {
  return <nav className="xn-claudex-rail" aria-label={tr('工作台')}>
    {actions.map(action => <button key={action.id} type="button" className="xn-claudex-rail__action"
      data-testid={`xn-sidebar-action-${action.id}`} aria-label={action.label} title={actionTitle(action, platform)}
      aria-current={activeId === action.id ? 'page' : undefined} data-active={activeId === action.id || undefined}
      onClick={action.onClick} data-sidebar-navigate="true">
      <span aria-hidden="true">{action.icon}</span>
    </button>)}
  </nav>;
}

/** A real brand/search row rather than pseudo-element content and coordinates. */
export function ClaudexSidebarHeader({ search, platform }: { search?: SidebarAction; platform?: string }): React.JSX.Element {
  return <div className="xn-claudex-sidebar-head" data-testid="xn-sidebar-brand-search">
    <span className="xn-claudex-sidebar-head__brand">Xueness</span>
    {search && <button type="button" className="xn-claudex-sidebar-head__search"
      data-testid={`xn-sidebar-action-${search.id}`} aria-label={search.label} title={actionTitle(search, platform)}
      onClick={search.onClick} data-sidebar-navigate="true">
      <span aria-hidden="true">{search.icon}</span>
    </button>}
  </div>;
}
