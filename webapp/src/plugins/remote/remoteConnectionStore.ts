/** Stable remote workspace identities are distinct from transient owner generations. */
export type RemoteOwner = { connectionId: string; digest: string; generation: string; state: string;
  workspaceIdentity: string | null; capabilities: Record<string, unknown>; limits?: Record<string, number> };
export type RemoteSessionRow = { id: string; [key: string]: unknown };
export const remoteWorkspaceKey = (owner: Pick<RemoteOwner, 'connectionId' | 'workspaceIdentity'>): string =>
  JSON.stringify(['remote', owner.connectionId, owner.workspaceIdentity]);
export const remoteSessionKey = (owner: Pick<RemoteOwner, 'connectionId' | 'workspaceIdentity'>, id: string): string =>
  JSON.stringify([remoteWorkspaceKey(owner), id]);
export class RemoteConnectionStore {
  private owners = new Map<string, RemoteOwner>();
  private rows = new Map<string, { owner: RemoteOwner; session: RemoteSessionRow }>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  owner(id: string): RemoteOwner | undefined { return this.owners.get(id); }
  current(owner: RemoteOwner): boolean { const current = this.owner(owner.connectionId); return current?.state === 'connected'
    && current.generation === owner.generation && current.digest === owner.digest && current.workspaceIdentity === owner.workspaceIdentity; }
  publish(owner: RemoteOwner, sessions: readonly RemoteSessionRow[]): void {
    this.owners.set(owner.connectionId, owner);
    // Index responses are windows, never deletion manifests.
    if (owner.workspaceIdentity) for (const session of sessions) this.rows.set(remoteSessionKey(owner, session.id), { owner, session });
    this.notify();
  }
  disconnect(id: string): void { const owner = this.owner(id); if (owner) this.publish({ ...owner, state: 'disconnected' }, []); }
  sessions(): readonly { owner: RemoteOwner; session: RemoteSessionRow }[] {
    return [...this.rows.values()].map(row => {
      const current = this.owner(row.owner.connectionId);
      return { ...row, owner: current && remoteWorkspaceKey(current) === remoteWorkspaceKey(row.owner)
        ? current : { ...row.owner, state: 'disconnected' } };
    });
  }
}
export const remoteConnections = new RemoteConnectionStore();
