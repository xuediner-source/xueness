import { useEffect, useMemo, useRef } from 'react';
import { forkSession } from '../../xuenessWorkbench';
import type { SessionCommandClient } from './commandClient';
import type { PaneForkCommand } from './paneForkActions';

/** Primary history retains unresolved fork intent independently of modal mounts.
 * Load fork admission only on use; receipt hydration remains synchronous in the
 * shared command handle, including before this optional action is loaded.
 */
export function usePrimaryForkCommand(commands: SessionCommandClient, enabled: boolean, activeId: string | null): typeof forkSession {
  const pending = useRef(new Map<string, PaneForkCommand>());
  const live = useRef({ enabled, activeId, commands }); live.current = { enabled, activeId, commands };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return useMemo(() => async (id, boundary, revision, title) => {
    const current = () => mounted.current && live.current.enabled && live.current.activeId === id
      && live.current.commands === commands && commands.isEffective();
    if (!current()) return { ok: false, error: 'Fork scope changed' };
    let command = pending.current.get(id);
    if (!command) {
      let module: typeof import('./paneForkActions');
      try { module = await import('./paneForkActions'); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      const { PaneForkCommand } = module;
      if (!current()) return { ok: false, error: 'Fork scope changed' };
      // Concurrent clicks may finish loading together: share the first admitted
      // command so its busy flag and durable ID still serialize every attempt.
      command = pending.current.get(id);
      if (!command) { command = new PaneForkCommand(commands, id); pending.current.set(id, command); }
    }
    const result = await forkSession(id, boundary, revision, title, (_path, body) => command!.submit(body as Record<string, unknown>));
    if (!current()) return { ok: false, error: 'Fork scope changed; return to the source to check the original result' };
    if (result.ok) pending.current.delete(id);
    return result;
  }, [commands]);
}
