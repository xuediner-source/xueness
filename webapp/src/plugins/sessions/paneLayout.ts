import { useCallback, useEffect, useRef, useState } from 'react';

/** Bounded two-pane conversation layout for sessions.pane_layout.
 * The primary binding stays with the workbench selection. Only the optional
 * secondary conversation, its workspace label, split direction, ratio and focus are
 * stored here. This is device-local presentation state, not a new event source. */

export type PaneId = 'primary' | 'secondary';
export type PaneSplit = 'row' | 'column';
export type PaneBinding = { readonly sessionId: string; readonly workspaceRoot: string };
export type PaneLayoutState = {
  readonly v: 1;
  readonly split: PaneSplit | null;
  readonly focus: PaneId;
  readonly secondary: PaneBinding | null;
  readonly ratio: number;
};

export const PANE_LAYOUT_STORAGE_KEY = 'xueness.sessions.pane-layout.v1';
export const PANE_LAYOUT_WIDE_MIN_PX = 1100;
export const PANE_RATIO_MIN = 0.25;
export const PANE_RATIO_MAX = 0.75;
export const PANE_SESSION_DRAG_MIME = 'application/x-xueness-pane-session';
const MAX_STORED_LAYOUT = 4096;
const MAX_DRAG_PAYLOAD = 1200;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function initialPaneLayout(): PaneLayoutState {
  return { v: 1, split: null, focus: 'primary', secondary: null, ratio: 0.5 };
}

export function boundPaneRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(PANE_RATIO_MIN, Math.min(PANE_RATIO_MAX, value)) : 0.5;
}

export function isPaneSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** Empty is allowed. Control characters and over-long paths are rejected. */
export function boundWorkspaceRoot(value: unknown): string | null {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 512 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

export function paneSubscriptionIdentity(pane: PaneId, sessionId: string): string | null {
  if (!isPaneSessionId(sessionId)) return null;
  return `sessions.pane:${pane}:${sessionId}`;
}

export function paneLayoutViewportIsWide(width: number): boolean {
  return Number.isFinite(width) && width >= PANE_LAYOUT_WIDE_MIN_PX;
}

export function paneWorkspaceLabel(root: string): string {
  const parts = root.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function binding(value: unknown): PaneBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const workspaceRoot = boundWorkspaceRoot(record.workspaceRoot);
  if (!isPaneSessionId(record.sessionId) || workspaceRoot === null) return null;
  return { sessionId: record.sessionId, workspaceRoot };
}

export function normalizePaneLayout(value: unknown): PaneLayoutState {
  const empty = initialPaneLayout();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return empty;
  const split = record.split === 'row' || record.split === 'column' ? record.split : null;
  const secondary = split ? binding(record.secondary) : null;
  const focus = record.focus === 'secondary' && split ? 'secondary' : 'primary';
  return { v: 1, split, focus, secondary, ratio: split ? boundPaneRatio(record.ratio) : 0.5 };
}

export function decodePaneLayout(raw: string | null): PaneLayoutState {
  if (!raw || raw.length > MAX_STORED_LAYOUT) return initialPaneLayout();
  try { return normalizePaneLayout(JSON.parse(raw)); }
  catch { return initialPaneLayout(); }
}

export function encodePaneLayout(state: PaneLayoutState): string {
  return JSON.stringify(normalizePaneLayout(state));
}

/** Sessions must be effective before a stored split is allowed to exist. */
export function paneLayoutForFeature(enabled: boolean, raw: string | null): PaneLayoutState {
  return enabled ? decodePaneLayout(raw) : initialPaneLayout();
}

export function paneLayoutIsSplitVisible(state: PaneLayoutState, wide: boolean, enabled: boolean): boolean {
  return enabled && wide && (state.split === 'row' || state.split === 'column');
}

function sameLayout(left: PaneLayoutState, right: PaneLayoutState): boolean {
  return left.split === right.split && left.focus === right.focus && left.ratio === right.ratio
    && left.secondary?.sessionId === right.secondary?.sessionId
    && left.secondary?.workspaceRoot === right.secondary?.workspaceRoot;
}

export function splitPaneLayout(state: PaneLayoutState, direction: PaneSplit): PaneLayoutState {
  const next = normalizePaneLayout({ ...state, v: 1, split: direction });
  return sameLayout(state, next) ? state : next;
}

export function closeSecondaryPane(state: PaneLayoutState): PaneLayoutState {
  if (!state.split && !state.secondary && state.focus === 'primary') return state;
  return initialPaneLayout();
}

export function resizePaneLayout(state: PaneLayoutState, ratio: number): PaneLayoutState {
  if (!state.split) return state;
  const next = normalizePaneLayout({ ...state, ratio });
  return sameLayout(state, next) ? state : next;
}

export function focusPane(state: PaneLayoutState, pane: PaneId): PaneLayoutState {
  if (pane === 'secondary' && !state.split) return state;
  const next = normalizePaneLayout({ ...state, focus: pane });
  return sameLayout(state, next) ? state : next;
}

export function bindSecondaryPane(state: PaneLayoutState, nextBinding: PaneBinding): PaneLayoutState {
  if (state.split !== 'row' && state.split !== 'column') return state;
  const secondary = binding(nextBinding);
  if (!secondary) return state;
  const next = normalizePaneLayout({ ...state, secondary, focus: 'secondary' });
  return sameLayout(state, next) ? state : next;
}

export function paneDragPayload(session: {
  id?: unknown; root?: unknown; workspace?: unknown; workspacePath?: unknown;
}): string | null {
  if (!isPaneSessionId(session.id)) return null;
  const workspaceRoot = boundWorkspaceRoot(session.workspacePath ?? session.workspace ?? session.root ?? '');
  if (workspaceRoot === null) return null;
  const payload = JSON.stringify({ v: 1, sessionId: session.id, workspaceRoot });
  return payload.length <= MAX_DRAG_PAYLOAD ? payload : null;
}

export function parsePaneDragPayload(raw: string): PaneBinding | null {
  if (!raw || raw.length > MAX_DRAG_PAYLOAD) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    return binding({ sessionId: record.sessionId, workspaceRoot: record.workspaceRoot });
  } catch { return null; }
}

export function acceptsPaneDrag(types: Iterable<string> | ArrayLike<string> | undefined): boolean {
  const list = Array.from(types ?? [], value => String(value).toLowerCase());
  return list.includes(PANE_SESSION_DRAG_MIME) || list.includes('application/x-xueness-session');
}

export function readPaneDrop(dataTransfer: { getData(type: string): string }): PaneBinding | null {
  const parsed = parsePaneDragPayload(dataTransfer.getData(PANE_SESSION_DRAG_MIME));
  if (parsed) return parsed;
  const sessionId = dataTransfer.getData('application/x-xueness-session').trim();
  return isPaneSessionId(sessionId) ? { sessionId, workspaceRoot: '' } : null;
}

function readStoredPaneLayout(): PaneLayoutState {
  try { return decodePaneLayout(localStorage.getItem(PANE_LAYOUT_STORAGE_KEY)); }
  catch { return initialPaneLayout(); }
}

/** Reads and writes the bounded layout only while sessions is effective.
 * A narrow viewport hides the secondary pane without forgetting it. */
export function useSessionPaneLayout(enabled: boolean) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [layout, setLayout] = useState<PaneLayoutState>(initialPaneLayout);
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && paneLayoutViewportIsWide(window.innerWidth));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    if (!enabled) {
      setLayout(initialPaneLayout());
      return;
    }
    setLayout(readStoredPaneLayout());
    const resize = () => setWide(paneLayoutViewportIsWide(window.innerWidth));
    const storage = (event: StorageEvent) => {
      if (!enabledRef.current) return;
      if (event.key === PANE_LAYOUT_STORAGE_KEY || event.key === null) setLayout(readStoredPaneLayout());
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('storage', storage);
    };
  }, [enabled]);
  const commit = useCallback((next: PaneLayoutState) => {
    if (!enabledRef.current) return;
    const safe = normalizePaneLayout(next);
    layoutRef.current = safe;
    setLayout(safe);
    try { localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, encodePaneLayout(safe)); }
    catch { /* Keep the in-memory layout when storage is unavailable. */ }
  }, []);
  const split = useCallback((direction: PaneSplit) => { commit(splitPaneLayout(layoutRef.current, direction)); }, [commit]);
  const close = useCallback(() => { commit(closeSecondaryPane(layoutRef.current)); }, [commit]);
  const focus = useCallback((pane: PaneId) => { commit(focusPane(layoutRef.current, pane)); }, [commit]);
  const bindSecondary = useCallback((nextBinding: PaneBinding) => { commit(bindSecondaryPane(layoutRef.current, nextBinding)); }, [commit]);
  const resize = useCallback((ratio: number) => { commit(resizePaneLayout(layoutRef.current, ratio)); }, [commit]);
  return {
    wide: enabled && wide,
    layout: enabled ? layout : initialPaneLayout(),
    split, close, focus, bindSecondary, resize,
  };
}
