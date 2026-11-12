
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
export const PANE_SESSION_DRAG_MIME = 'application/x-xueness-pane-session';
const MAX_DRAG_PAYLOAD = 1200;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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

export function paneLayoutIsSplitVisible(state: PaneLayoutState, wide: boolean, enabled: boolean): boolean {
  return enabled && wide && (state.split === 'row' || state.split === 'column');
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

