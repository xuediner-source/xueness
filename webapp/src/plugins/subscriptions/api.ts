import { get, post } from '../../xuenessApi';

export type SubscriptionModel = { id: string; name: string; providerId: string; source: 'preset' | 'manual' | 'upstream'; capabilities: string[]; reasoningLevels: string[] };
export type QuotaWindow = { kind: string; scope?: string; usedPercent?: number; remaining?: number; limit?: number; usedUsd?: number; unit?: string; resetsAt?: number; windowDurationMins?: number };
export type Quota = { supported: boolean; checkedAt: number; plan?: string; windows: QuotaWindow[] };
export type SubscriptionAccount = {
  id: string; name: string; nameEn?: string; mode: 'oauth' | 'local'; transport: string;
  help?: string; helpEn?: string; tags?: string[]; quotaSupport: boolean; importSupport?: boolean; loginMethod?: string;
  connected: boolean; credentialsSaved: boolean; expired: boolean; account: string;
  hasUserId: boolean; models: SubscriptionModel[]; quota: Quota | null;
};
export type LoginStatus = { busy?: boolean; loggedIn?: boolean; authorizeUrl?: string; userCode?: string; expiresAt?: number; detail?: string };
export type AccountResult = { accounts: SubscriptionAccount[]; result: LoginStatus & Record<string, unknown> };
export function listAccounts(signal?: AbortSignal) { return get<{ accounts: SubscriptionAccount[]; workerRunning: boolean }>('/api/subscriptions', signal); }
export function accountAction(id: string, action: string, body: object = {}, signal?: AbortSignal) { return post<AccountResult>(`/api/subscriptions/${encodeURIComponent(id)}/${action}`, body, signal); }
export function loginStatus(id: string, signal?: AbortSignal) { return get<{ status: LoginStatus; account: SubscriptionAccount }>(`/api/subscriptions/${encodeURIComponent(id)}/status`, signal); }
export function safeAuthorizeUrl(value?: string): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function parseModelIds(value: string): string[] { return [...new Set(value.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))]; }
export function remainingPercent(value: number): number { return Math.min(100, Math.max(0, 100 - value)); }
