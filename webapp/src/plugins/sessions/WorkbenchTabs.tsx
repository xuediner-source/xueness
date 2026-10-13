import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Plus, X } from 'lucide-react';
import { t as tr, tf } from '../../i18n';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import type { SessionSummary } from '../../xuenessWorkbench';
import { commandPaletteStatusLabel } from './CommandPalette';

export const WORKBENCH_TABS_STORAGE_KEY = 'xueness.workbench.conversation-tabs.v1';

/** Only presentation metadata is persisted. Drafts and session lifecycle stay with their existing owners. */
export type SavedWorkbenchTab = { id: string; title?: string; root?: string };
export type WorkbenchTab = SavedWorkbenchTab & { status?: string };

export function readWorkbenchTabs(value: string | null): SavedWorkbenchTab[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.flatMap((item): SavedWorkbenchTab[] => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) return [];
      seen.add(item.id);
      return [{
        id: item.id,
        ...(typeof item.title === 'string' && item.title.trim() ? { title: item.title } : {}),
        ...(typeof item.root === 'string' && item.root ? { root: item.root } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/** An incomplete or temporarily empty catalog never proves that a saved session has been deleted. */
export function reconcileWorkbenchTabs(
  tabs: SavedWorkbenchTab[],
  sessions: readonly SessionSummary[],
  activeId: string | null,
  loaded: boolean,
): SavedWorkbenchTab[] {
  const catalog = new Map((loaded ? sessions : []).map(session => [session.id, session]));
  let changed = false;
  const next = tabs.map(tab => {
    const session = catalog.get(tab.id);
    if (!session) return tab;
    const title = session.title?.trim() || session.task?.trim() || undefined;
    const root = session.root || undefined;
    if (tab.title === title && tab.root === root) return tab;
    changed = true;
    return { id: tab.id, title, root };
  });
  if (activeId && !next.some(tab => tab.id === activeId)) {
    const session = catalog.get(activeId);
    next.push({ id: activeId, title: session?.title?.trim() || session?.task?.trim() || undefined, root: session?.root });
    changed = true;
  }
  return changed ? next : tabs;
}

export function closeWorkbenchTab(tabs: readonly SavedWorkbenchTab[], id: string, activeId: string | null): {
  tabs: SavedWorkbenchTab[];
  activeId: string | null;
} {
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return { tabs: [...tabs], activeId };
  return {
    tabs: tabs.filter(tab => tab.id !== id),
    activeId: id === activeId ? (tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null) : activeId,
  };
}

export type WorkbenchTabsProps = {
  enabled: boolean;
  tabs: readonly WorkbenchTab[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onClose(id: string): void;
  panelId?: string;
};

export function useWorkbenchTabs({ enabled, loaded, sessions, activeId, onSelect, onNew }: {
  enabled: boolean;
  /** True once the supplied session catalog is ready; it need not contain every historical session. */
  loaded: boolean;
  sessions: readonly SessionSummary[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
}): WorkbenchTabsProps {
  const [savedTabs, setSavedTabs] = useState<SavedWorkbenchTab[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const pendingClose = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || hydrated) return;
    let tabs: SavedWorkbenchTab[] = [];
    try { tabs = readWorkbenchTabs(window.localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY)); } catch { /* Storage may be unavailable. */ }
    setSavedTabs(tabs);
    setHydrated(true);
  }, [enabled, hydrated]);

  useEffect(() => {
    if (!enabled || !hydrated) return;
    if (pendingClose.current !== activeId) pendingClose.current = null;
    const openedId = pendingClose.current === activeId ? null : activeId;
    setSavedTabs(tabs => reconcileWorkbenchTabs(tabs, sessions, openedId, loaded));
  }, [enabled, hydrated, sessions, activeId, loaded]);

  useEffect(() => {
    if (!enabled || !hydrated) return;
    try { window.localStorage.setItem(WORKBENCH_TABS_STORAGE_KEY, JSON.stringify(savedTabs)); } catch { /* Keep tabs usable when storage is full or disabled. */ }
  }, [enabled, hydrated, savedTabs]);

  const tabs = useMemo(() => {
    const catalog = new Map((loaded ? sessions : []).map(session => [session.id, session]));
    return savedTabs.map(tab => ({ ...tab, status: catalog.get(tab.id)?.status }));
  }, [savedTabs, sessions, loaded]);

  return {
    enabled,
    tabs,
    activeId,
    onSelect(id) {
      if (!enabled) return;
      pendingClose.current = null;
      onSelect(id);
    },
    onNew() { if (enabled) onNew(); },
    onClose(id) {
      if (!enabled) return;
      const next = closeWorkbenchTab(savedTabs, id, activeId);
      if (id === activeId) pendingClose.current = id;
      setSavedTabs(next.tabs);
      if (next.activeId !== activeId) {
        if (next.activeId) onSelect(next.activeId);
        else onNew();
      }
    },
  };
}

/** Closing a tab only changes navigation. It never cancels, archives, or deletes its conversation. */
export function WorkbenchTabs({ enabled, tabs, activeId, onSelect, onNew, onClose, panelId }: WorkbenchTabsProps) {
  const [focusId, setFocusId] = useState<string | null>(activeId);
  const buttons = useRef(new Map<string | null, HTMLButtonElement>());
  const ids = [null, ...tabs.map(tab => tab.id)];
  const rovingId = ids.includes(focusId) ? focusId : ids.includes(activeId) ? activeId : null;

  useEffect(() => {
    if (!enabled) return;
    setFocusId(activeId);
    buttons.current.get(activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [enabled, activeId, tabs.length]);

  if (!enabled) return null;

  const close = (id: string) => {
    const next = closeWorkbenchTab(tabs, id, activeId);
    onClose(id);
    setFocusId(next.activeId);
    buttons.current.get(next.activeId)?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: string | null) => {
    if (isImeComposingEvent(event) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Delete' && id) {
      event.preventDefault();
      close(id);
      return;
    }
    const index = ids.indexOf(id);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % ids.length
        : event.key === 'ArrowLeft' ? (index - 1 + ids.length) % ids.length : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = ids[nextIndex];
    setFocusId(nextId);
    buttons.current.get(nextId)?.focus();
  };
  const buttonRef = (id: string | null) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(id, node);
    else buttons.current.delete(id);
  };

  return <div className="xn-workbench-tabs" role="tablist" aria-label={tr('会话标签页')} data-testid="xn-workbench-tabs">
    <div className={`xn-workbench-tabs__item xn-workbench-tabs__item--new${activeId === null ? ' is-active' : ''}`} role="presentation">
      <button type="button" role="tab" ref={buttonRef(null)} className="xn-workbench-tabs__tab" aria-selected={activeId === null}
        aria-controls={panelId} tabIndex={rovingId === null ? 0 : -1} onFocus={() => setFocusId(null)}
        onKeyDown={event => onKeyDown(event, null)} onClick={onNew} data-testid="workbench-tab-new">
        <Plus size={14} aria-hidden="true" /><span className="xn-workbench-tabs__label">{tr('新建任务')}</span>
      </button>
    </div>
    {tabs.map(tab => {
      const selected = activeId === tab.id;
      const label = tab.title || `${tr('会话')} ${tab.id.slice(0, 8)}`;
      const status = tab.status ? commandPaletteStatusLabel(tab.status) : '';
      return <div key={tab.id} className={`xn-workbench-tabs__item${selected ? ' is-active' : ''}`} role="presentation" data-session-id={tab.id}>
        <button type="button" role="tab" ref={buttonRef(tab.id)} className="xn-workbench-tabs__tab" aria-selected={selected}
          aria-controls={panelId} tabIndex={rovingId === tab.id ? 0 : -1} onFocus={() => setFocusId(tab.id)}
          onKeyDown={event => onKeyDown(event, tab.id)} onClick={() => onSelect(tab.id)}
          title={[label, tab.root, status].filter(Boolean).join('\n')} data-testid="workbench-tab-session">
          <MessageCircle size={14} aria-hidden="true" />
          <span className="xn-workbench-tabs__label">{label}</span>
          {tab.status && <span className="xn-workbench-tabs__status" data-status={tab.status} role="img" aria-label={`${tr('会话状态')}: ${status}`} />}
        </button>
        <button type="button" className="xn-workbench-tabs__close" tabIndex={-1} aria-label={tf('关闭标签页：{0}', [label])}
          title={tf('关闭标签页：{0}', [label])} onClick={() => close(tab.id)} data-testid="workbench-tab-close">
          <X size={12} aria-hidden="true" />
        </button>
      </div>;
    })}
  </div>;
}
