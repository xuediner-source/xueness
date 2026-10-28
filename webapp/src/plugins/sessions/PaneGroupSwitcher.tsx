import React from 'react';
import { Check, ChevronDown, PanelsTopLeft, X } from 'lucide-react';
import { t as tr } from '../../i18n';
import './pane-group-switcher.css';

export interface PaneGroupOption { id: string; title: string; panes: number; }
export function PaneGroupSwitcher({ groups, value, onSelect, onClose }: {
  groups: readonly PaneGroupOption[]; value?: string | null;
  onSelect(id: string): void; onClose(id: string): void;
}) {
  if (!groups.length) return null;
  const closePopover = (button: HTMLButtonElement) => {
    const details = button.closest('details')!;
    details.open = false; details.querySelector('summary')?.focus();
  };
  return <details className="xn-pane-group-picker" data-testid="pane-group-picker"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }}>
    <summary aria-label={tr('切换分屏组')}><PanelsTopLeft size={14} aria-hidden="true" /><span>{tr('分屏组')}</span><b>{groups.length}</b><ChevronDown size={12} aria-hidden="true" /></summary>
    <div className="xn-pane-group-picker__popover">
      <div className="xn-pane-group-picker__heading">{tr('分屏组')}<span>{groups.length}</span></div>
      <ul>{groups.map((group, index) => <li key={group.id} data-active={group.id === value}>
        <button type="button" className="xn-pane-group-picker__select" aria-pressed={group.id === value} data-group-id={group.id}
          onClick={event => { closePopover(event.currentTarget); onSelect(group.id); }}>
          <span className="xn-pane-group-picker__number">{index + 1}</span><span className="xn-pane-group-picker__copy"><strong title={group.title}>{group.title}</strong><small>{group.panes} {tr('分屏')}</small></span>
          {group.id === value && <Check size={14} aria-hidden="true" />}
        </button>
        {groups.length > 1 && <button type="button" className="xn-pane-group-picker__close" aria-label={`${tr('关闭分屏组')}: ${group.title}`} title={tr('关闭分屏组')}
          onClick={event => { closePopover(event.currentTarget); onClose(group.id); }}><X size={13} aria-hidden="true" /></button>}
      </li>)}</ul>
    </div>
  </details>;
}
