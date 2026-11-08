import { useCallback, useState } from 'react';
import type { WorkbenchSession } from '../../xuenessWorkbench';
import type { PaneIdentity } from './paneIdentity';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';

type PrimarySidePanelInput = {
  activeId: string | null;
  remoteChoice: string | undefined;
  session: WorkbenchSession | null;
  remoteAdapter: RemoteSessionAdapter | null;
  isPluginEffective: (id: string) => boolean;
};

/** Terminal and browser panels follow the focused pane, scoped to the primary selection it was reported under. */
export function usePrimarySidePanelBinding({ activeId, remoteChoice, session, remoteAdapter, isPluginEffective }: PrimarySidePanelInput) {
  const [sidePanelSelection, setSidePanelSelection] = useState<{ identity: PaneIdentity | null; anchor: string } | null>(null);
  const sidePanelAnchor = JSON.stringify([activeId, remoteChoice ?? null]);
  const receiveFocusedIdentity = useCallback((identity: PaneIdentity | null) => {
    setSidePanelSelection(previous => previous?.anchor === sidePanelAnchor && JSON.stringify(previous.identity) === JSON.stringify(identity)
      ? previous : { identity, anchor: sidePanelAnchor });
  }, [sidePanelAnchor]);
  const scopedSidePanel = resolvePaneSidePanelBinding(sidePanelSelection?.anchor === sidePanelAnchor ? sidePanelSelection.identity : null,
    { sessionId: activeId, root: (session?.id === activeId ? session.root : '') ?? '', remote: Boolean(remoteChoice || (session?.id === activeId && Object.prototype.hasOwnProperty.call(session, 'remote_connection'))) },
    isPluginEffective('remote') ? remoteAdapter : undefined, isPluginEffective('sessions'));
  return { receiveFocusedIdentity, scopedSidePanel };
}

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
