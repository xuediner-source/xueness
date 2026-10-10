import React, { useEffect, useRef } from 'react';
import type { SidebarAction } from '../../XuenessShell';
import { displayBinding, isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { t as tr } from '../../i18n';
import './ClaudexSidebar.css';
import { Bell, ChevronDown, MoreHorizontal } from 'lucide-react';
import type { SessionSummary } from '../../xuenessWorkbench';
import { commandPaletteStatusLabel } from './CommandPalette';

function useSidebarMenuDismiss(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      ref.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(details => {
        if (!details.contains(event.target as Node)) details.open = false;
      });
    };
    document.addEventListener('pointerdown',dismiss);
    return () => document.removeEventListener('pointerdown',dismiss);
  },[ref]);
}

function actionTitle(action: SidebarAction, platform?: string): string {
  return action.shortcut ? `${action.label} (${displayBinding(action.shortcut, platform)})` : action.label;
}

/** Presentation only: the container supplies plugin-filtered existing actions. */
export function ClaudexSidebarRail({ actions, secondaryActions = [], moreActions = [], platform, activeId }: { actions: SidebarAction[]; secondaryActions?: SidebarAction[]; moreActions?: SidebarAction[]; platform?: string; activeId?: string }): React.JSX.Element {
  const ref=useRef<HTMLElement>(null);
  useSidebarMenuDismiss(ref);
  const renderAction = (action: SidebarAction) => <button key={action.id} type="button" className="xn-claudex-rail__action"
    data-testid={`xn-sidebar-action-${action.id}`} aria-label={action.label} title={actionTitle(action, platform)}
    aria-current={activeId === action.id ? 'page' : undefined} data-active={activeId === action.id || undefined}
    onClick={action.onClick} data-sidebar-navigate="true"><span aria-hidden="true">{action.icon}</span></button>;
  return <nav ref={ref} className="xn-claudex-rail" aria-label={tr('工作台')}>
    {actions.map(renderAction)}
    {moreActions.length > 0 && <details className="xn-claudex-rail__more" onKeyDown={event => {
      if(event.key==='Escape' && !isImeComposingEvent(event)) { event.stopPropagation(); event.currentTarget.open=false; event.currentTarget.querySelector('summary')?.focus(); }
    }} onBlur={event => { if(!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open=false; }}>
      <summary className="xn-claudex-rail__action" aria-label={tr('更多')} title={tr('更多')}><MoreHorizontal size={18} /></summary>
      <div className="xn-claudex-sidebar-menu">{moreActions.map(action => <button key={action.id} type="button" onClick={event => {
        event.currentTarget.closest('details')!.open=false; action.onClick?.(event);
      }}><span aria-hidden="true">{action.icon}</span>{action.label}</button>)}</div>
    </details>}
    {secondaryActions.length > 0 && <><div className="xn-claudex-rail__separator" role="separator" />{secondaryActions.map(renderAction)}</>}
  </nav>;
}

/** A real brand/search row rather than pseudo-element content and coordinates. */
export function ClaudexSidebarHeader({ search, platform, menuActions = [], activity = [], onSelectSession }: {
  search?: SidebarAction; platform?: string; menuActions?: SidebarAction[]; activity?: SessionSummary[]; onSelectSession?: (id: string) => void;
}): React.JSX.Element {
  const ref=useRef<HTMLDivElement>(null);
  useSidebarMenuDismiss(ref);
  const dismiss = (event: React.KeyboardEvent<HTMLDetailsElement>) => {
    if(event.key==='Escape' && !isImeComposingEvent(event)) { event.stopPropagation(); event.currentTarget.open=false; event.currentTarget.querySelector('summary')?.focus(); }
  };
  const blur = (event: React.FocusEvent<HTMLDetailsElement>) => { if(!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open=false; };
  return <div ref={ref} className="xn-claudex-sidebar-head" data-testid="xn-sidebar-brand-search">
    <details className="xn-claudex-sidebar-head__brand-menu" onKeyDown={dismiss} onBlur={blur}>
      <summary className="xn-claudex-sidebar-head__brand" aria-label={tr('工作台菜单')}>Xueness<ChevronDown size={12} /></summary>
      <div className="xn-claudex-sidebar-menu">{menuActions.map(action => <button key={action.id} type="button" onClick={event => {
        event.currentTarget.closest('details')!.open=false; action.onClick?.(event);
      }}><span aria-hidden="true">{action.icon}</span>{action.label}</button>)}</div>
    </details>
    <div className="xn-claudex-sidebar-head__utilities">
    {onSelectSession && <details className="xn-claudex-sidebar-head__activity" onKeyDown={dismiss} onBlur={blur}>
      <summary className="xn-claudex-sidebar-head__search" aria-label={tr('会话动态')} title={tr('会话动态')}>
        <Bell size={16} aria-hidden="true" />{activity.length>0 && <span className="xn-claudex-sidebar-head__activity-dot" />}
      </summary>
      <div className="xn-claudex-sidebar-menu xn-claudex-sidebar-menu--activity">
        <h2>{tr('会话动态')}</h2>
        {activity.length===0 ? <p>{tr('暂无会话动态')}</p> : activity.map(session => <button key={session.id} type="button" onClick={event => {
          event.currentTarget.closest('details')!.open=false; onSelectSession(session.id);
        }}><span>{session.title || session.task}</span><small>{commandPaletteStatusLabel(session.status)}</small></button>)}
      </div>
    </details>}
    {search && <button type="button" className="xn-claudex-sidebar-head__search"
      data-testid={`xn-sidebar-action-${search.id}`} aria-label={search.label} title={actionTitle(search, platform)}
      onClick={search.onClick} data-sidebar-navigate="true">
      <span aria-hidden="true">{search.icon}</span>
    </button>}
    </div>
  </div>;
}
