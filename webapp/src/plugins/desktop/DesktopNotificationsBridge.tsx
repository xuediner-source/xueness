import { useEffect, useRef } from 'react';

export type DesktopNotifySession = { id: string; task?: string; title?: string; status: string };
export type DesktopNotificationKind = 'approval' | 'question' | 'failed' | 'completed';
export type DesktopNotifyRequest = { kind: DesktopNotificationKind; sessionId: string; sessionTitle: string };

/** Session statuses worth leaving the workbench for. The main process
 * (`desktop/src/notifications.cjs`) owns the native copy and re-validates
 * every request; this mapping only picks which transitions notify. */
const STATUS_TO_KIND: Record<string, DesktopNotificationKind> = {
  needs_review: 'approval',
  awaiting_user: 'question',
  failed: 'failed',
  provider_error: 'failed',
  completed: 'completed',
};

const TITLE_LIMIT = 140;

/** Pure transition diff: only sessions whose previous status was already
 * observed can notify, so the first snapshot after mount never replays. */
export function collectSessionNotifications(previous: ReadonlyMap<string, string>,
  sessions: DesktopNotifySession[]): DesktopNotifyRequest[] {
  const requests: DesktopNotifyRequest[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string' || typeof session.status !== 'string' || seen.has(session.id)) continue;
    seen.add(session.id);
    const before = previous.get(session.id);
    if (before === undefined || before === session.status) continue;
    const kind = STATUS_TO_KIND[session.status];
    if (kind) requests.push({ kind, sessionId: session.id,
      sessionTitle: (session.title || session.task || session.id).slice(0, TITLE_LIMIT) });
  }
  return requests;
}

/** Publishes desktop notification requests for the Electron preload. The
 * request travels as the `data-xn-desktop-notify-request` attribute (same
 * channel pattern as the tray state); the preload forwards it only while the
 * desktop plugin is effective, and the main process validates it again. */
export function DesktopNotificationsBridge({ enabled, sessions, activeId, locale }: {
  enabled: boolean; sessions: DesktopNotifySession[]; activeId: string | null; locale: 'zh' | 'en';
}) {
  const previous = useRef<Map<string, string>>(new Map());
  const lastSeq = useRef(0);
  useEffect(() => {
    const desktopPage = window.top === window && new URLSearchParams(window.location.search).get('xuenessDesktop') === '1';
    if (!desktopPage || !enabled) {
      // Reset while disabled so re-enabling never replays old transitions.
      previous.current = new Map();
      return;
    }
    const requests = collectSessionNotifications(previous.current, sessions);
    const next = new Map<string, string>();
    for (const session of sessions) {
      if (session && typeof session.id === 'string' && typeof session.status === 'string') next.set(session.id, session.status);
    }
    previous.current = next;
    // A session the operator is actively reading does not need a toast.
    const watching = typeof document === 'undefined' || document.visibilityState === 'visible';
    const items = requests
      .filter(request => !(watching && request.sessionId === activeId))
      .slice(0, 5)
      .map(request => ({ kind: request.kind, sessionTitle: request.sessionTitle,
        sessionId: /^[a-f0-9]{32}$/.test(request.sessionId) ? request.sessionId : undefined }));
    if (items.length === 0) return;
    // Strictly increasing stamps let the main process drop stale replays even
    // across page reloads; the preload deduplicates identical attribute values.
    lastSeq.current = Math.max(Date.now(), lastSeq.current + 1);
    document.documentElement.setAttribute('data-xn-desktop-notify-request',
      JSON.stringify({ seq: lastSeq.current, locale, items }));
  }, [enabled, sessions, activeId, locale]);
  return null;
}
