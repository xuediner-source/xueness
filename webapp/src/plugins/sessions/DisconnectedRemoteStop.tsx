import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import type { WorkbenchSession } from '../../xuenessWorkbench';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { paneBindingKey, type PaneIdentity } from './paneIdentity';

export type DisconnectedStopTarget = {
  identity: PaneIdentity; adapter: RemoteSessionAdapter; session: WorkbenchSession; enabled: boolean;
};
/** Only a verified snapshot belonging to this exact mounted owner can supply a turn. */
export function disconnectedStopTurn({ identity, adapter, session, enabled }: DisconnectedStopTarget): string | null {
  const turn = session.active_turn_id;
  return enabled && !adapter.isCurrent() && adapter.isSafetyStopAvailable()
    && identity.scope.remoteConnectionId === adapter.owner.connectionId
    && identity.scope.workspaceIdentity === adapter.owner.workspaceIdentity
    && identity.sessionId === session.id && typeof turn === 'string' && !!turn.trim() && turn.length <= 128
    ? turn : null;
}

/** This client has no ordinary command/read authority and never refreshes/reconnects. */
export async function submitDisconnectedStop(target: DisconnectedStopTarget, current: () => boolean): Promise<void> {
  const turn = disconnectedStopTurn(target);
  if (!turn || !current()) throw Object.assign(new Error('Remote stop target is unavailable'), { requestNotSent: true });
  const enabled = () => current() && disconnectedStopTurn(target) === turn;
  const commands = target.adapter.createCommands(() => false, enabled);
  try {
    const result = await commands.submit(target.session.id, 'stop', { expected_turn_id: turn }, async () => {
      throw Object.assign(new Error('Local stop fallback is forbidden'), { requestNotSent: true });
    });
    if (!result || typeof result !== 'object' || typeof (result as { stopping?: unknown }).stopping !== 'boolean') {
      throw new Error(tr('远程停止结果尚未确认，请勿重复提交。'));
    }
  } finally { commands.dispose(); }
}

export function DisconnectedRemoteStop(props: DisconnectedStopTarget) {
  const turn = disconnectedStopTurn(props);
  const key = JSON.stringify([paneBindingKey(props.identity), props.adapter.runtimeKey, turn]);
  const live = useRef({ key, props, mounted: true });
  live.current = { key, props, mounted: live.current.mounted };
  const attempted = useMemo(() => ({ value: false }), [key]);
  const [status, setStatus] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; }; }, []);
  if (!turn) return null;
  const current = () => live.current.mounted && live.current.key === key
    && disconnectedStopTurn(live.current.props) === turn;
  return <div className="xn-pane-disconnected-stop">
    <button type="button" disabled={attempted.value} onClick={() => {
      if (attempted.value || !current()) return;
      attempted.value = true;
      setStatus({ key, text: tr('远程停止结果尚未确认，请勿重复提交。') });
      void submitDisconnectedStop(props, current).then(() => {
        if (current()) setStatus({ key, text: tr('停止请求已接受；远程运行是否结束尚未确认。') });
      }).catch(error => {
        if (current()) setStatus({ key, text: error instanceof Error ? error.message : String(error) });
      });
    }}>{tr('停止上次确认的远程轮次')}</button>
    {status?.key === key && <p role="status">{status.text}</p>}
  </div>;
}
