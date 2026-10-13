import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { t as tr } from '../../i18n';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import './workbench-dock.css';

export type WorkbenchDockTab = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  content: React.ReactNode;
};

export type WorkbenchDockProps = {
  placement: 'right' | 'bottom';
  /** Callers supply only effective plugin tabs. Inactive content is not mounted. */
  tabs: readonly WorkbenchDockTab[];
  activeId: string;
  onSelect(id: string): void;
  /** Hides the frame only; this component never closes a backend resource. */
  onClose(): void;
};

const DEFAULT_SIZE = { right: 420, bottom: 260 } as const;
const STORAGE_PREFIX = 'xueness.workbench-dock-size.v1.';

function readSize(placement: WorkbenchDockProps['placement']): number {
  try {
    const value = Number(localStorage.getItem(`${STORAGE_PREFIX}${placement}`));
    if (Number.isFinite(value) && value > 0) return value;
  } catch { /* Storage can be unavailable; resizing remains usable. */ }
  return DEFAULT_SIZE[placement];
}

function writeSize(placement: WorkbenchDockProps['placement'], size: number): void {
  try { localStorage.setItem(`${STORAGE_PREFIX}${placement}`, String(size)); }
  catch { /* Keep the current in-memory size. */ }
}

/** A presentation frame for real plugin panels, independent of their APIs. */
export function WorkbenchDock({ placement, tabs, activeId, onSelect, onClose }: WorkbenchDockProps): React.JSX.Element | null {
  const instanceId = useId();
  const frameId = `${instanceId}-dock`;
  const panelId = `${instanceId}-panel`;
  const frame = useRef<HTMLElement>(null);
  const separator = useRef<HTMLDivElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const [preferredSize, setPreferredSize] = useState(() => readSize(placement));
  const [available, setAvailable] = useState({ width: 1280, height: 800, viewportWidth: 1280, viewportHeight: 800 });
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointer: number; start: number; original: number; next: number; placement: WorkbenchDockProps['placement'] } | null>(null);
  const animation = useRef<number | null>(null);
  const stacked = placement === 'right' && (available.viewportWidth < 1000 || available.width < 680);
  const maximum = placement === 'right'
    ? Math.max(320, available.width - 360)
    : Math.max(150, Math.min(available.viewportHeight * 0.6, available.height - 160));
  const minimum = placement === 'right' ? 320 : 150;
  const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(minimum, value)));
  const size = clamp(preferredSize);
  const bounds = useRef({ minimum, maximum });
  bounds.current = { minimum, maximum };
  const activeTab = tabs.find(tab => tab.id === activeId) ?? tabs[0];
  const activeIndex = activeTab ? tabs.indexOf(activeTab) : -1;

  useEffect(() => setPreferredSize(readSize(placement)), [placement]);
  useLayoutEffect(() => {
    const parent = frame.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const rect = parent.getBoundingClientRect();
      const next = { width: rect.width || window.innerWidth, height: rect.height || window.innerHeight,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
      setAvailable(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(parent);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [placement, Boolean(activeTab)]);

  const finishResize = useCallback((commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    const next = commit ? current.next : current.original;
    setPreferredSize(next);
    if (commit) writeSize(current.placement, next);
    if (separator.current?.hasPointerCapture(current.pointer)) separator.current.releasePointerCapture(current.pointer);
    setResizing(false);
  }, []);

  useEffect(() => {
    const cancel = () => finishResize(false);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      const current = drag.current;
      drag.current = null;
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      if (current && separator.current?.hasPointerCapture(current.pointer)) separator.current.releasePointerCapture(current.pointer);
    };
  }, [finishResize]);
  useEffect(() => { finishResize(false); }, [stacked, placement, finishResize]);

  const commitSize = (value: number) => {
    finishResize(false);
    const next = clamp(value);
    setPreferredSize(next);
    writeSize(placement, next);
  };
  if (!activeTab) return null;

  return <aside ref={frame} id={frameId} className={`xn-workbench-dock xn-workbench-dock--${placement}`}
    data-placement={placement} data-stacked={stacked} data-resizing={resizing}
    aria-label={tr('工作台面板')} style={{ '--xn-dock-size': `${size}px` } as React.CSSProperties}>
    <div ref={separator} className="xn-workbench-dock__resizer" role="separator" tabIndex={stacked ? -1 : 0}
      hidden={stacked} aria-orientation={placement === 'right' ? 'vertical' : 'horizontal'}
      aria-label={tr(placement === 'right' ? '调整面板宽度' : '调整终端高度')} aria-controls={frameId}
      aria-valuemin={minimum} aria-valuemax={Math.round(maximum)} aria-valuenow={size}
      title={tr('拖动调整面板大小，双击恢复默认')}
      onPointerDown={event => {
        if (event.button !== 0 || event.isPrimary === false || stacked) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, start: placement === 'right' ? event.clientX : event.clientY,
          original: size, next: size, placement };
        setResizing(true);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        const coordinate = current.placement === 'right' ? event.clientX : event.clientY;
        current.next = Math.round(Math.min(bounds.current.maximum, Math.max(bounds.current.minimum, current.original + current.start - coordinate)));
        if (animation.current === null) animation.current = requestAnimationFrame(() => {
          animation.current = null;
          if (drag.current) setPreferredSize(drag.current.next);
        });
      }}
      onPointerUp={event => { if (drag.current?.pointer === event.pointerId) finishResize(true); }}
      onPointerCancel={() => finishResize(false)} onLostPointerCapture={() => finishResize(false)}
      onDoubleClick={() => commitSize(DEFAULT_SIZE[placement])}
      onKeyDown={event => {
        if (isImeComposingEvent(event)) return;
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finishResize(false); return; }
        const increase = placement === 'right' ? 'ArrowLeft' : 'ArrowUp';
        const decrease = placement === 'right' ? 'ArrowRight' : 'ArrowDown';
        const step = event.shiftKey ? 40 : 16;
        const next = event.key === 'Home' ? minimum : event.key === 'End' ? maximum : event.key === 'Enter' ? DEFAULT_SIZE[placement]
          : event.key === increase ? size + step : event.key === decrease ? size - step : null;
        if (next !== null) { event.preventDefault(); event.stopPropagation(); commitSize(next); }
      }} />
    <header className="xn-workbench-dock__header">
      <div className="xn-workbench-dock__tabs" role="tablist" aria-label={tr('工作台面板')}>
        {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${instanceId}-tab-${index}`}
          className="xn-workbench-dock__tab" aria-selected={tab.id === activeTab.id} aria-controls={panelId}
          tabIndex={tab.id === activeTab.id ? 0 : -1} title={tab.label}
          ref={element => { if (element) tabButtons.current.set(tab.id, element); else tabButtons.current.delete(tab.id); }}
          onClick={() => onSelect(tab.id)} onKeyDown={event => {
            if (isImeComposingEvent(event)) return;
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); event.stopPropagation();
            onSelect(tabs[next].id);
            tabButtons.current.get(tabs[next].id)?.focus();
          }}>
          {tab.icon && <span className="xn-workbench-dock__icon" aria-hidden="true">{tab.icon}</span>}
          <span>{tab.label}</span>
        </button>)}
      </div>
      <button type="button" className="xn-workbench-dock__close" onClick={() => { finishResize(false); onClose(); }}
        aria-label={tr('关闭面板')} title={tr('关闭面板')}><X size={16} aria-hidden="true" /></button>
    </header>
    <div key={activeTab.id} id={panelId} role="tabpanel" aria-labelledby={`${instanceId}-tab-${activeIndex}`}
      tabIndex={0} className="xn-workbench-dock__content">{activeTab.content}</div>
  </aside>;
}
