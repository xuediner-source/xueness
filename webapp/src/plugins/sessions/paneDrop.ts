import { PANE_SESSION_DRAG_MIME } from './paneLayout';
import { validTreeBinding, type TreeBinding, type PaneSide } from './paneTree';

export const MAX_PANE_DROP_BYTES = 4096;
export function decodePaneDrop(raw: string): TreeBinding | null {
  if (!raw || raw.length > MAX_PANE_DROP_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1 && record.v !== 2) return null;
    const candidate = { sessionId: record.sessionId, scope: record.v === 1 ? { workspaceRoot: record.workspaceRoot } : record.scope } as TreeBinding;
    if (candidate.sessionId === null || !validTreeBinding(candidate)) return null;
    return { sessionId: candidate.sessionId, scope: { workspaceRoot: candidate.scope.workspaceRoot,
      ...(candidate.scope.workspaceIdentity ? { workspaceIdentity: candidate.scope.workspaceIdentity } : {}),
      ...(candidate.scope.remoteConnectionId ? { remoteConnectionId: candidate.scope.remoteConnectionId } : {}) } };
  } catch { return null; }
}
/** Only app-owned structured payloads establish scope; arbitrary text is never a session. */
export function readTreePaneDrop(transfer: { getData(type: string): string }): TreeBinding | null {
  try { return decodePaneDrop(transfer.getData(PANE_SESSION_DRAG_MIME)); } catch { return null; }
}
export function paneDropSide(x: number, y: number): PaneSide {
  const distances = [{ side: 'left', distance: x }, { side: 'right', distance: 1 - x },
    { side: 'up', distance: y }, { side: 'down', distance: 1 - y }] as const;
  return distances.reduce((best, item) => item.distance < best.distance ? item : best).side;
}
