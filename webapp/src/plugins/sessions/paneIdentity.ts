import { paneScopeKey, type PaneScope, type PaneDraftAlias } from './paneTree';

/** Runtime ownership changes on rebind, while composer identity survives promotion. */
export type PaneIdentity = {
  readonly groupId: string;
  readonly paneId: string;
  readonly bindingRevision: number;
  readonly scope: PaneScope;
  readonly sessionId: string | null;
};
export function paneScopeIdentity(scope: PaneScope): string {
  return JSON.stringify([scope.workspaceIdentity ?? scope.workspaceRoot, scope.workspaceRoot, scope.remoteConnectionId ?? null]);
}
export function paneBindingKey(identity: PaneIdentity): string {
  return JSON.stringify([identity.groupId, identity.paneId, identity.bindingRevision, paneScopeIdentity(identity.scope), identity.sessionId]);
}
export function paneComposerKey(identity: PaneIdentity): string {
  return JSON.stringify([identity.groupId, identity.paneId, paneScopeKey(identity.scope)]);
}
// Four independently seeded lanes keep the wire identifier bounded even for long roots.
function identityDigest(value: string): string {
  return [2166136261, 2246822519, 3266489917, 668265263].map(seed => {
    let hash = seed;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
}
export function paneSubscriberId(identity: PaneIdentity): string {
  return `sessions.pane:v2:${identityDigest(paneBindingKey(identity))}:${identity.sessionId ?? 'draft'}`;
}
export function paneDraftAddress(identity: PaneIdentity): PaneDraftAlias {
  return { workspaceKey: `pane-workspace:${paneScopeKey(identity.scope)}`, draftKey: `pane:${JSON.stringify([identity.groupId, identity.paneId])}` };
}
/** Read an old address without moving/deleting it or writing during rendering. */
export function readPaneDraft<T>(identity: PaneIdentity, read: (workspace: string, draft: string) => T | null, alias?: PaneDraftAlias, adopted = false): T | null {
  const address = paneDraftAddress(identity);
  return read(address.workspaceKey, address.draftKey) ?? (!adopted && alias ? read(alias.workspaceKey, alias.draftKey) : null);
}

export type PaneAliasStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
function aliasStorage(): PaneAliasStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function adoptionKey(identity: PaneIdentity): string { return `xueness.pane-draft-adopted:${paneComposerKey(identity)}`; }
export function paneDraftAliasAdopted(identity: PaneIdentity, storage: PaneAliasStorage | null = aliasStorage()): boolean {
  try { return storage?.getItem(adoptionKey(identity)) === '1'; } catch { return false; }
}
/** Reference-only tombstone. The old draft remains untouched and recoverable. */
export function markPaneDraftAliasAdopted(identity: PaneIdentity, storage: PaneAliasStorage | null = aliasStorage()): boolean {
  if (!storage) return false;
  try { storage.setItem(adoptionKey(identity), '1'); return storage.getItem(adoptionKey(identity)) === '1'; } catch { return false; }
}
