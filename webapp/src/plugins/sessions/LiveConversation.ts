import { useEffect, useRef, useState } from 'react';

type Operation = { op: 'set' | 'delete' | 'append'; path: (string | number)[]; value?: unknown };
type Projection = { revision: number; snapshot: unknown };

/** A patch is only applied to its matching snapshot; every reconnect rebases. */
export function applyConversationPatch(previous: Projection, patch: { baseRevision: number; revision: number; operations: Operation[] }): Projection {
  if (patch.baseRevision !== previous.revision || !Number.isSafeInteger(patch.revision) || patch.revision < previous.revision
    || !Array.isArray(patch.operations) || patch.operations.length > 100000) throw new Error('Conversation revision mismatch');
  let snapshot = structuredClone(previous.snapshot);
  for (const operation of patch.operations) {
    if (!operation || !Array.isArray(operation.path) || operation.path.length > 32
      || operation.path.some(key => typeof key !== 'string' && typeof key !== 'number' || ['__proto__', 'constructor', 'prototype'].includes(String(key)))) {
      throw new Error('Invalid conversation patch');
    }
    if (operation.path.length === 0) {
      if (operation.op !== 'set') throw new Error('Invalid root patch');
      snapshot = structuredClone(operation.value);
      continue;
    }
    let parent = snapshot as Record<string | number, unknown>;
    for (const key of operation.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !(key in parent)) throw new Error('Invalid patch path');
      parent = parent[key] as Record<string | number, unknown>;
    }
    const key = operation.path.at(-1)!;
    if (!parent || typeof parent !== 'object') throw new Error('Invalid patch parent');
    if (operation.op === 'delete') delete parent[key];
    else if (operation.op === 'set') parent[key] = structuredClone(operation.value);
    else if (operation.op === 'append') {
      const target = parent[key];
      if (typeof target === 'string' && typeof operation.value === 'string') parent[key] = target + operation.value;
      else if (Array.isArray(target) && Array.isArray(operation.value)) target.push(...structuredClone(operation.value));
      else throw new Error('Invalid patch append');
    } else throw new Error('Invalid patch operation');
  }
  return { revision: patch.revision, snapshot };
}

type Source = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((this: EventSource, event: Event) => unknown) | null;
};
export function startConversationUpdates(sessionId: string, accept: (snapshot: unknown) => void, connected: (value: boolean) => void,
  createSource: (url: string) => Source = url => new EventSource(url, { withCredentials: true })): () => void {
  const source = createSource(`/api/sessions/${encodeURIComponent(sessionId)}/updates`);
  let stopped = false;
  let projection: Projection | undefined;
  const receive = (type: 'snapshot' | 'patch') => (event: MessageEvent<string>) => {
    if (stopped) return;
    try {
      const data = JSON.parse((event as MessageEvent<string>).data);
      if (type === 'snapshot') {
        if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !data.snapshot) throw new Error('Invalid conversation snapshot');
        projection = data;
      } else {
        if (!projection) throw new Error('Snapshot required');
        projection = applyConversationPatch(projection, data);
      }
      accept(projection!.snapshot);
      connected(true);
    } catch {
      projection = undefined;
      connected(false);
      source.close();
    }
  };
  source.addEventListener('conversation.snapshot', receive('snapshot'));
  source.addEventListener('conversation.patch', receive('patch'));
  source.onerror = () => { if (!stopped) { projection = undefined; connected(false); } };
  return () => { stopped = true; source.close(); };
}

/** Disabling sessions/unmount closes the stream; polling is the recovery fallback. */
export function useConversationUpdates(sessionId: string | null, enabled: boolean, accept: (snapshot: unknown) => void): boolean {
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const [connection, setConnection] = useState<string | null>(null);
  useEffect(() => {
    setConnection(null);
    if (!sessionId || !enabled || typeof EventSource === 'undefined') return;
    return startConversationUpdates(sessionId, value => acceptRef.current(value),
      connected => setConnection(connected ? sessionId : null));
  }, [sessionId, enabled]);
  return enabled && connection === sessionId;
}
