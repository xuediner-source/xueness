import { useEffect } from 'react';
// Eager shell boundary; xterm and registry remain in the lazy terminal chunk.
let enabled = false;
let remoteEnabled = false;
let owner: { setEnabled(value: boolean): void; removeWorkspace(id: string): void; setRemoteEnabled?(value: boolean): void } | undefined;
export function registerTerminalLifecycle(value: typeof owner) { owner = value; owner?.setEnabled(enabled); owner?.setRemoteEnabled?.(remoteEnabled); }
export function setTerminalLifecycleEnabled(value: boolean) { enabled = value; owner?.setEnabled(value); }
export function removeTerminalWorkspace(workspaceId: string) { owner?.removeWorkspace(workspaceId); }
export function setRemoteTerminalLifecycleEnabled(value: boolean) { remoteEnabled = value; owner?.setRemoteEnabled?.(value); }
export function useTerminalLifecycle(value: boolean, remoteValue = false) {
  useEffect(() => { setTerminalLifecycleEnabled(value); }, [value]);
  useEffect(() => { setRemoteTerminalLifecycleEnabled(remoteValue); }, [remoteValue]);
}
