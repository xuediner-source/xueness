import { useCallback, useEffect, useRef, useState } from 'react';
import { post } from '../../xuenessApi';
import type { PermissionMode } from './permissionModes';

export function setSessionPermissionMode(id: string, mode: PermissionMode, acknowledged: boolean, turnId?: string | null, signal?: AbortSignal) {
  return post(`/api/sessions/${id}/permission`, { permission_mode: mode, acknowledge_yolo: acknowledged, ...(turnId !== undefined ? { expected_turn_id: turnId } : {}) }, signal);
}
export function useLivePermissionMode(id: string | null, turnId: string | null, enabled: boolean, onChanged: (id: string, mode: PermissionMode) => void | Promise<void>) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const current = useRef({ id, enabled, onChanged }); current.current = { id, enabled, onChanged };
  const request = useRef<AbortController | null>(null);
  useEffect(() => { setSaving(false); setError(''); return () => request.current?.abort(); }, [id, enabled]);
  const change = useCallback(async (mode: PermissionMode, acknowledged = false): Promise<boolean> => {
    if (!id || !enabled || current.current.id !== id || !current.current.enabled || request.current && !request.current.signal.aborted) return false;
    const controller = new AbortController(); request.current = controller; setSaving(true); setError('');
    try {
      await setSessionPermissionMode(id, mode, acknowledged, turnId, controller.signal);
      if (controller.signal.aborted || current.current.id !== id || !current.current.enabled) return false;
      await current.current.onChanged(id, mode); return true;
    } catch (e) { if (!controller.signal.aborted && current.current.id === id) setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { controller.abort(); if (current.current.id === id) setSaving(false); }
  }, [id, turnId, enabled]);
  return { saving, error, change };
}
