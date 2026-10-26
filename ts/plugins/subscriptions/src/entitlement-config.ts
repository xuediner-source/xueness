/**
 * User-authorized entitlement service configuration (F13.03): which account
 * uses which public entitlement endpoint, persisted in the private
 * subscription store. The token never leaves the store; HTTP callers only
 * ever see `hasToken`.
 */
import { isDict, pySlice, PyValueError } from "@xueness/contracts";
import { EntitlementClient, entitlementEndpoint } from "./entitlements.ts";
import { definition, readDocument, writeDocument } from "./state.ts";

type Row = Record<string, unknown>;

export interface EntitlementServiceConfig {
  base: string;
  token: string;
  savedAt: number;
}

const TOKEN_LIMIT = 4096;

function validatedBase(value: unknown): string {
  if (typeof value !== "string") throw new PyValueError("entitlement base URL is required");
  const base = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(base)) throw new PyValueError("entitlement base URL must start with http:// or https://");
  if ([...base].length > 2048) throw new PyValueError("entitlement base URL is too long");
  return base;
}

function validatedToken(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PyValueError("entitlement token is required");
  if ([...value].length > TOKEN_LIMIT) throw new PyValueError("entitlement token is too long");
  return value.trim();
}

/** The configured service for one provider, or null; never throws for absent config. */
export function entitlementConfig(stateDir: string, pid: string): EntitlementServiceConfig | null {
  if (!definition(pid)) return null;
  const store = readDocument(stateDir, "entitlements.json");
  const value = store[pid];
  if (!isDict(value) || typeof value.base !== "string" || typeof value.token !== "string") return null;
  return { base: value.base, token: value.token, savedAt: typeof value.savedAt === "number" && Number.isFinite(value.savedAt) && value.savedAt >= 0 ? value.savedAt : 0 };
}

/** Save (or replace) the service one account uses; requires a known provider. */
export function saveEntitlementConfig(stateDir: string, pid: string, base: unknown, token: unknown, now = Date.now()): EntitlementServiceConfig {
  if (!definition(pid)) throw new PyValueError("subscription provider not found");
  const clean: EntitlementServiceConfig = { base: validatedBase(base), token: validatedToken(token), savedAt: now };
  const store = readDocument(stateDir, "entitlements.json");
  store[pid] = { base: clean.base, token: clean.token, savedAt: clean.savedAt };
  writeDocument(stateDir, "entitlements.json", store);
  return clean;
}

/** Remove the saved service; the account keeps running without the ticket path. */
export function clearEntitlementConfig(stateDir: string, pid: string): boolean {
  if (!definition(pid)) throw new PyValueError("subscription provider not found");
  const store = readDocument(stateDir, "entitlements.json");
  if (!Object.hasOwn(store, pid)) return false;
  delete store[pid];
  writeDocument(stateDir, "entitlements.json", store);
  return true;
}

/** A real client for the configured service; null when none is saved. */
export function entitlementClient(stateDir: string, pid: string): EntitlementClient | null {
  const config = entitlementConfig(stateDir, pid);
  return config ? new EntitlementClient({ base: config.base, token: config.token }) : null;
}

/** The `record.entitlement` seam `NativeProvider` reads; token included, never surfaced over HTTP. */
export function entitlementSeam(stateDir: string, pid: string): { base: string; token: string } | null {
  const config = entitlementConfig(stateDir, pid);
  return config ? { base: config.base, token: config.token } : null;
}

/** HTTP-safe rows: configured endpoints with the token reduced to `hasToken`. */
export function publicEntitlementConfigs(stateDir: string, available: boolean): Row[] {
  if (!available) return [];
  const store = readDocument(stateDir, "entitlements.json");
  const rows: Row[] = [];
  for (const pid of Object.keys(store).sort()) {
    const config = entitlementConfig(stateDir, pid);
    if (!config) continue;
    rows.push({ providerId: pid, base: pySlice(config.base, 2048), hasToken: true, savedAt: config.savedAt, status: "public" });
  }
  return rows;
}

/** Only the documented public contract is configurable; pending vendors are not. */
export function configurableEndpoint(pid: string): Row | null {
  const endpoint = entitlementEndpoint(pid);
  return endpoint ? { id: endpoint.id, name: endpoint.name, nameEn: endpoint.nameEn, auth: endpoint.auth, status: endpoint.status } : null;
}
