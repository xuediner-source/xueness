import { useEffect } from 'react';
// Tiny eager boundary; browser UI and registry remain in a lazy chunk.
let enabled = false;
type Owner = { setEnabled(value: boolean): void; removeWorkspace(id: string): void };
const owners = new Set<Owner>();
export function registerBrowserLifecycle(value: Owner) { owners.add(value); value.setEnabled(enabled); }
export function setBrowserLifecycleEnabled(value: boolean) { enabled = value; for (const owner of owners) owner.setEnabled(value); }
export function removeBrowserWorkspace(id: string) { for (const owner of owners) owner.removeWorkspace(id); }
export function useBrowserLifecycle(value: boolean) { useEffect(() => { setBrowserLifecycleEnabled(value); }, [value]); }

export function unregisterBrowserLifecycle(value: Owner) { owners.delete(value); value.setEnabled(false); }
