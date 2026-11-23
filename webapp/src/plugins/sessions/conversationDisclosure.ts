import React from 'react';
import { setPersistedDisclosure } from './disclosureState';

export const zcodeConversationDisclosures = new Map<string, boolean>();
export const DisclosureContext = React.createContext<Map<string, boolean> | null>(null);
export const SessionIdContext = React.createContext<string | undefined>(undefined);
const DISCLOSURE_STORAGE_KEY = 'xueness.sessions.tool-disclosures.v1';
const DISCLOSURE_STORAGE_LIMIT = 500;

function readStoredDisclosure(key: string): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(DISCLOSURE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistDisclosure(key: string, value: boolean): void {
  try {
    const raw = window.localStorage.getItem(DISCLOSURE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const state: Record<string, boolean> = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, candidate]) => typeof candidate === 'boolean')) as Record<string, boolean>
      : {};
    delete state[key];
    state[key] = value;
    const keys = Object.keys(state);
    while (keys.length > DISCLOSURE_STORAGE_LIMIT) {
      const oldest = keys.shift();
      if (oldest !== undefined) delete state[oldest];
    }
    window.localStorage.setItem(DISCLOSURE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing and storage quota failures leave the in-memory state
    // authoritative; disclosure persistence is an enhancement only.
  }
}

export function useDisclosure(key: string, defaultOpen = false) {
  const sessionId = React.useContext(SessionIdContext);
  const fullKey = sessionId ? `${sessionId}:${key}` : key;
  const saved = React.useContext(DisclosureContext) ?? zcodeConversationDisclosures;
  const [override, setOpen] = React.useState<boolean | undefined>(() => saved.get(fullKey) ?? saved.get(key) ?? readStoredDisclosure(fullKey));
  React.useEffect(() => {
    setOpen(saved.get(fullKey) ?? saved.get(key) ?? readStoredDisclosure(fullKey));
  }, [fullKey, key, saved]);
  const open = override ?? defaultOpen;
  return { open, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    if (next !== open) {
      setPersistedDisclosure(saved, fullKey, next);
      setPersistedDisclosure(zcodeConversationDisclosures, fullKey, next);
      persistDisclosure(fullKey, next);
      setOpen(next);
    }
  } };
}
