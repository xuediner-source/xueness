import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import './sidebar-resize.css';

export type SidebarAppearance = 'xueness' | 'claudex';
export const SIDEBAR_WIDTH_STORAGE = 'xueness.sidebar-widths.v1';
export const DEFAULT_SIDEBAR_WIDTHS = { xueness: 270, claudex: 340 } as const;
type Widths = Partial<Record<SidebarAppearance, number>>;

export function sidebarWidthLimits(appearance: SidebarAppearance, viewport: number) {
  const min = appearance === 'claudex' ? 280 : 220;
  return { min, max: Math.max(min, Math.min(appearance === 'claudex' ? 560 : 480, viewport - 480)) };
}

export function clampSidebarWidth(value: number, appearance: SidebarAppearance, viewport: number): number {
  const { min, max } = sidebarWidthLimits(appearance, viewport);
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : DEFAULT_SIDEBAR_WIDTHS[appearance])));
}

export function decodeSidebarWidths(raw: string | null): Widths {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Widths = {};
    for (const appearance of ['xueness', 'claudex'] as const) {
      const value = (parsed as Record<string, unknown>)[appearance];
      if (typeof value === 'number' && Number.isFinite(value)) result[appearance] = clampSidebarWidth(value, appearance, 1920);
    }
    return result;
  } catch { return {}; }
}

function readWidths(): Widths {
  try { return decodeSidebarWidths(localStorage.getItem(SIDEBAR_WIDTH_STORAGE)); }
  catch { return {}; }
}

/** Device presentation preference only. Disabled sessions never read, write or
 * listen; no model/API operation is involved in resizing. */
export function useSessionSidebarWidth(appearance: SidebarAppearance, enabled: boolean) {
  const [widths, setWidths] = useState<Widths>(() => enabled && typeof window !== 'undefined' ? readWidths() : {});
  const [viewport, setViewport] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  useEffect(() => {
    if (!enabled) return;
    setWidths(readWidths());
    const resize = () => setViewport(window.innerWidth);
    const storage = (event: StorageEvent) => {
      if (event.key === SIDEBAR_WIDTH_STORAGE || event.key === null) setWidths(readWidths());
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('storage', storage); };
  }, [enabled]);
  const onChange = useCallback((value: number, commit: boolean) => {
    if (!enabled) return;
    const next = { ...widthsRef.current, [appearance]: clampSidebarWidth(value, appearance, 1920) };
    widthsRef.current = next;
    setWidths(next);
    if (commit) try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE, JSON.stringify(next)); } catch { /* Keep the in-memory preference. */ }
  }, [appearance, enabled]);
  return { width: enabled ? clampSidebarWidth(widths[appearance] ?? DEFAULT_SIDEBAR_WIDTHS[appearance], appearance, viewport) : undefined,
    limits: sidebarWidthLimits(appearance, viewport), onChange };
}

export function SidebarResizeHandle({ appearance, width, min, max, onChange }: {
  appearance: SidebarAppearance; width: number; min: number; max: number;
  onChange: (width: number, commit: boolean) => void;
}) {
  const drag = useRef<{ pointer: number; startX: number; startWidth: number; next: number } | null>(null);
  const frame = useRef<number | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const finish = useCallback((commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    onChange(commit ? current.next : current.startWidth, commit);
    if (handle.current?.hasPointerCapture(current.pointer)) handle.current.releasePointerCapture(current.pointer);
    setResizing(false);
  }, [onChange]);
  useEffect(() => () => finish(false), [finish]);
  useEffect(() => {
    const cancel = () => finish(false);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); };
  }, [finish]);
  return <div ref={handle} role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={tr('调整侧栏宽度')} aria-controls="xn-shell-sidebar" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    title={tr('拖动调整侧栏宽度，双击恢复默认')} className="xn-sidebar-resizer" data-testid="xn-sidebar-resizer" data-resizing={resizing}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: width, next: width };
      setResizing(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.next = clampSidebarWidth(current.startWidth + event.clientX - current.startX, appearance, window.innerWidth);
      if (frame.current === null) frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (drag.current) onChange(drag.current.next, false);
      });
    }}
    onPointerUp={event => { if (drag.current?.pointer === event.pointerId) finish(true); }}
    onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}
    onDoubleClick={() => { finish(false); onChange(DEFAULT_SIDEBAR_WIDTHS[appearance], true); }}
    onKeyDown={event => {
      if (isImeComposingEvent(event)) return;
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(false); return; }
      const value = event.key === 'Home' ? min : event.key === 'End' ? max : event.key === 'Enter' ? DEFAULT_SIDEBAR_WIDTHS[appearance]
        : event.key === 'ArrowLeft' ? width - (event.shiftKey ? 24 : 10) : event.key === 'ArrowRight' ? width + (event.shiftKey ? 24 : 10) : null;
      if (value !== null) { event.preventDefault(); onChange(value, true); }
    }} />;
}
