import { validTreeBinding, type TreeBinding } from './paneTree';

export type PaneRestoreResult =
  | { readonly kind: 'present'; readonly status: 200 }
  | { readonly kind: 'absent'; readonly status: 404 | 410 }
  | { readonly kind: 'unknown'; readonly status?: number; readonly reason: string };
export type PaneSessionProbe = (binding: TreeBinding, signal: AbortSignal) => Promise<PaneRestoreResult>;
/** Only an exact-ID successful response proves presence. Index omission proves nothing. */
export function classifyPaneRestore(sessionId: string, status: number, payload?: unknown, workspaceRoot?: string): PaneRestoreResult {
  if (status === 404 || status === 410) return { kind: 'absent', status };
  if (status !== 200) return { kind: 'unknown', status, reason: 'http' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (payload as Record<string, unknown>).id !== sessionId) return { kind: 'unknown', status, reason: 'malformed' };
  const root = (payload as Record<string, unknown>).root;
  // Older sessions omit root; an explicit root must agree with the restored scope.
  if (workspaceRoot !== undefined && root !== undefined && root !== null && root !== workspaceRoot)
    return { kind: 'unknown', status, reason: 'scope-mismatch' };
  return { kind: 'present', status: 200 };
}
/** This endpoint is local. Never send a remote binding to a local session namespace. */
export async function probePaneSession(binding: TreeBinding, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<PaneRestoreResult> {
  if (!validTreeBinding(binding) || binding.sessionId === null) return { kind: 'unknown', reason: 'draft-or-invalid' };
  if (binding.scope.remoteConnectionId) return { kind: 'unknown', reason: 'remote-route-required' };
  if (signal.aborted) return { kind: 'unknown', reason: 'aborted' };
  const controller = new AbortController();
  let settleAbort!: (result: PaneRestoreResult) => void;
  const canceled = new Promise<PaneRestoreResult>(resolve => { settleAbort = resolve; });
  const cancel = (reason: string) => {
    settleAbort({ kind: 'unknown', reason });
    controller.abort();
  };
  const abort = () => cancel('aborted');
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => cancel('timeout'), 15000);
  try {
    // Race the entire operation: custom fetchers and body readers may ignore abort.
    const request = (async (): Promise<PaneRestoreResult> => {
      try {
        const response = await fetcher(`/api/sessions/${encodeURIComponent(binding.sessionId!)}`, {
          signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (controller.signal.aborted) return { kind: 'unknown', reason: signal.aborted ? 'aborted' : 'timeout' };
        // Preserve definitive status even if its body is HTML/empty; parse only a 200.
        if (response.status !== 200) return classifyPaneRestore(binding.sessionId!, response.status);
        try { return classifyPaneRestore(binding.sessionId!, 200, await response.json(), binding.scope.workspaceRoot); }
        catch { return { kind: 'unknown', status: 200, reason: 'malformed' }; }
      } catch { return { kind: 'unknown', reason: 'network' }; }
    })();
    return await Promise.race([request, canceled]);
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}

/** Drafts have no remote identity to prove; restored sessions must be confirmed first. */
export function paneRestoreAllowsWrites(sessionId: string | null, result: PaneRestoreResult | null): boolean {
  return sessionId === null || result?.kind === 'present';
}
