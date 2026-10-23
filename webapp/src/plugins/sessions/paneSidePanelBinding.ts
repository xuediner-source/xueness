import type { PaneIdentity } from './paneIdentity';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';

/** Side panels use the focused leaf's namespace, never the primary local ID. */
export function resolvePaneSidePanelBinding(identity: PaneIdentity | null, local: { sessionId: string | null; root: string; remote: boolean },
  adapter: RemoteSessionAdapter | null | undefined, enabled: boolean) {
  if (!enabled) return { sessionId: null, workspaceId: '', remote: false, remoteAdapter: undefined };
  if (!identity) return { sessionId: local.remote ? null : local.sessionId, workspaceId: local.remote ? '' : local.root,
    remote: local.remote, remoteAdapter: undefined };
  if (!identity.scope.remoteConnectionId) return { sessionId: identity.sessionId, workspaceId: identity.scope.workspaceRoot,
    remote: false, remoteAdapter: undefined };
  const expected = adapter && JSON.stringify(['remote', adapter.owner.connectionId, adapter.owner.workspaceIdentity]);
  const matches = adapter?.isCurrent() && adapter.owner.connectionId === identity.scope.remoteConnectionId
    && identity.scope.workspaceIdentity === expected;
  return { sessionId: identity.sessionId, workspaceId: identity.scope.workspaceIdentity ?? '', remote: true,
    remoteAdapter: matches ? adapter ?? undefined : undefined };
}
