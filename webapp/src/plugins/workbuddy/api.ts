import { del, get, post } from '../../xuenessApi';

export type WorkbuddyAccount = {
  id: string;
  uid: string;
  nickname: string;
  credits: number | null;
  cooling: boolean;
  disabled: boolean;
  inFlight: number;
  lastSuccess: string | null;
  lastError: string | null;
  cooldownUntil: string | null;
};

export type WorkbuddyAccountsResult = {
  ok: true;
  accounts: WorkbuddyAccount[];
  gatewayAvailable: boolean;
};

export function listWorkbuddyAccounts(signal?: AbortSignal) {
  return get<WorkbuddyAccountsResult>('/api/workbuddy/accounts', signal);
}

export function addWorkbuddyAccount(credentials: Record<string, unknown>, signal?: AbortSignal) {
  return post<WorkbuddyAccountsResult>('/api/workbuddy/accounts', { credentials }, signal);
}

export function deleteWorkbuddyAccount(id: string, signal?: AbortSignal) {
  return del<WorkbuddyAccountsResult>(`/api/workbuddy/accounts/${encodeURIComponent(id)}`, signal);
}

export type CredentialFileError = 'workbuddy-file-extension' | 'workbuddy-file-read' | 'workbuddy-file-json';

export function parseCredentialsJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('workbuddy-file-json' satisfies CredentialFileError); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workbuddy-file-json' satisfies CredentialFileError);
  }
  return parsed as Record<string, unknown>;
}

export async function readWorkbuddyCredentialsFile(file: Pick<File, 'name' | 'text'>): Promise<Record<string, unknown>> {
  if (!file.name.toLowerCase().endsWith('.json')) throw new Error('workbuddy-file-extension' satisfies CredentialFileError);
  let text: string;
  try { text = await file.text(); }
  catch { throw new Error('workbuddy-file-read' satisfies CredentialFileError); }
  return parseCredentialsJson(text);
}
