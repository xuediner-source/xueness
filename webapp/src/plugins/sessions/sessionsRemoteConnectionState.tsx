import React from 'react';
import { t as tr } from '../../i18n';

const LABELS = {
  pending: '正在连接',
  reconnecting: '正在重连',
  connected: '已连接',
  disconnected: '已断开',
} as const;

// Loaded with this chunk, so the startup catalog does not carry the four phrases.

export type ObservedRemoteConnectionState = keyof typeof LABELS;

/** Read-only phase text. There is no reconnect button and no SSH call. */
export function RemoteConnectionStateLabel({ state }: { state: ObservedRemoteConnectionState }): React.JSX.Element {
  return <span data-connection-state={state}>{tr(LABELS[state])}</span>;
}
